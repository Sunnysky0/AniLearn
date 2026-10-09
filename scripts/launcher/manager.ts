import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Pool } from 'pg';
import { databaseLog, fingerprint, loadEnvironment, makeRedactor, readJson, saveJson } from './config';
import { belongsToProject, descendants, matchesRecord, portAvailable, portOwner, processes, recordProcess, sameProcess, terminateTree, type ProcessRecord } from './processes';
import { ensureDocker } from './docker';
import type { Command, Config, DatabaseStats, LogSource, ProcessIdentity, Sample, Snapshot } from './types';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('操作已取消。')); return; }
  const cancel = () => { clearTimeout(timer); reject(new Error('操作已取消。')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
  signal?.addEventListener('abort', cancel, { once: true });
});
export function parseBytes(text: string) {
  const match = text.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return null;
  const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(match[2].toUpperCase().replace('I', ''));
  return Number(match[1]) * (match[2].includes('i') ? 1024 : 1000) ** power;
}
export function managerKey(config: Config) {
  return createHash('sha256').update(config.root.toLowerCase() + ':' + config.project).digest('hex').slice(0, 20);
}
export class Manager extends EventEmitter {
  readonly snapshot: Snapshot;
  private env: NodeJS.ProcessEnv;
  private redact: (text: string) => string;
  private appProcess: ChildProcess | null = null;
  private identity: ProcessIdentity | null = null;
  private record: ProcessRecord | null = null;
  private pool: Pool | null = null;
  private container: string | null = null;
  private logProcess: ChildProcess | null = null;
  private controller: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastDb = 0;
  private dbDelay = 5000;
  private previous: { time: number; cpu: Map<string, number>; rx: number; tx: number } | null = null;
  private logId = 0;
  private lastBroadcast = 0;
  private closed = false;
  private cancelVersion = 0;
  private statsPolling = false;
  private resourceProcess: ChildProcess | null = null;
  private resources: { cpu: number; memory: number | null; rx: number; tx: number; time: number } | null = null;
  private detecting = false;
  private lastContainer = 0;
  constructor(readonly config: Config) {
    super();
    this.env = loadEnvironment(config);
    this.redact = makeRedactor(this.env);
    this.snapshot = { mode: config.mode, port: config.port, app: 'stopped', database: 'stopped', docker: 'stopped', startedAt: null, phase: '正在检测', phaseAt: Date.now(), busy: false, error: null, logs: [], samples: [], stats: null, processes: [], detached: false };
    this.record = readJson<ProcessRecord>(path.join(config.runtime, 'app.json'));
  }
  changed(force = false) {
    if (force || Date.now() - this.lastBroadcast > 400) { this.lastBroadcast = Date.now(); this.emit('snapshot', this.snapshot); }
  }
  log(source: LogSource, text: string) {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const safe = this.redact(source === 'database' ? databaseLog(line) : line);
      if (!safe.trim()) continue;
      const entry = { id: ++this.logId, time: Date.now(), source, level: /error|fail|fatal|exception|错误|失败/i.test(safe) ? 'error' as const : 'info' as const, text: safe };
      this.snapshot.logs.push(entry);
      if (this.snapshot.logs.length > 1000) this.snapshot.logs.shift();
      const file = path.join(this.config.runtime, 'activity.log');
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
          fs.rmSync(file + '.3', { force: true });
          for (let n = 2; n >= 1; n--) { const old = file + '.' + n; if (fs.existsSync(old)) fs.renameSync(old, file + '.' + (n + 1)); }
          fs.renameSync(file, file + '.1');
        }
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
      } catch { /* Monitoring must remain usable if local log storage is unavailable. */ }
    }
    this.changed();
  }
  private phase(text: string) { this.snapshot.phase = text; this.snapshot.phaseAt = Date.now(); this.log('launcher', text); this.changed(true); }
  private compose(args: string[]) { return ['compose', '-p', this.config.project, '--env-file', this.config.envFile, '-f', this.config.composeFile, ...args]; }
  private logStream(stream: NodeJS.ReadableStream, source: LogSource) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (text: string) => {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { this.log(source, buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (buffer.length > 100_000) { this.log(source, this.redact(buffer)); buffer = ''; }
    });
    stream.on('end', () => { if (buffer) this.log(source, buffer); });
  }
  private run(executable: string, args: string[], timeout = 30_000, signal?: AbortSignal, source: LogSource = 'launcher', quiet = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const launchedAt = Date.now();
      const child = spawn(executable, args, { cwd: this.config.root, env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const capture = (chunk: Buffer, stderr: boolean) => {
        const safe = this.redact(chunk.toString());
        if (stderr) errors = (errors + safe).slice(-32_000); else output = (output + chunk.toString()).slice(-2_000_000);
      };
      child.stdout.on('data', chunk => capture(chunk, false)); child.stderr.on('data', chunk => capture(chunk, true));
      if (!quiet) { this.logStream(child.stdout, source); this.logStream(child.stderr, source); }
      let cancelling = false, timedOut = false;
      const cancel = () => {
        if (cancelling) return; cancelling = true;
        if (child.pid) void processes().then(all => {
          if (child.exitCode !== null || child.signalCode) return;
          const p = all.find(p => p.pid === child.pid && p.parentPid === process.pid && Date.parse(p.created) >= launchedAt);
          if (p) return terminateTree(p);
        }).catch(() => {}).finally(() => { if (child.exitCode === null && !child.signalCode) child.kill(); });
      };
      const timer = setTimeout(() => { timedOut = true; cancel(); }, timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(error); });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) reject(new Error('操作已取消。'));
        else if (timedOut) reject(new Error(`${path.basename(executable)} 执行超时。`));
        else if (code !== 0) reject(new Error(errors.trim() || `${path.basename(executable)} 执行失败（${code ?? '超时'}）。`));
        else resolve(output.trim());
      });
    });
  }
  async initialize() {
    fs.mkdirSync(this.config.runtime, { recursive: true });
    const file = path.join(this.config.runtime, 'activity.log');
    if (fs.existsSync(file)) {
      const recent = fs.readFileSync(file, 'utf8').slice(-500_000).split('\n').slice(-301);
      for (const line of recent) { try { const entry = JSON.parse(line); const text = this.redact(entry.source === 'database' ? databaseLog(entry.text) : entry.text); if (text) this.snapshot.logs.push({ ...entry, id: ++this.logId, text }); } catch { /* Ignore an incomplete log tail. */ } }
    }
    await this.detect();
    this.snapshot.phase = '就绪';
    this.pollTimer = setInterval(() => { void this.poll(); }, 2000);
    void this.poll();
  }
  private async detect() {
    const all = await processes();
    if (!this.identity && this.record) this.identity = all.find(p => matchesRecord(p, this.record!, this.config.root) && belongsToProject(p, this.config.root)) ?? null;
    if (this.identity && (!belongsToProject(this.identity, this.config.root) || !all.some(p => sameProcess(p, this.identity!)))) this.identity = null;
    if (!this.identity && !(await portAvailable(this.config.port))) {
      const owner = await portOwner(this.config.port);
      let found = all.find(p => p.pid === owner && belongsToProject(p, this.config.root));
      if (found) {
        const parent = all.find(p => p.pid === found!.parentPid && belongsToProject(p, this.config.root) && /(?:next[\\/]dist[\\/]bin[\\/]next|server-child)/.test(p.command));
        if (parent) found = parent;
        this.identity = found;
        this.record = recordProcess(found, this.config.root);
        saveJson(path.join(this.config.runtime, 'app.json'), this.record);
        this.snapshot.mode = /\bdev\b/.test(found.command) ? 'development' : 'production';
        this.log('launcher', `已连接本项目的现有服务，PID ${found.pid}；此前标准输出无法接管。`);
      }
    }
    if (this.identity) { this.snapshot.app = 'running'; this.snapshot.startedAt = Date.parse(this.identity.created); }
    try {
      const kind = await this.run('docker', ['info', '--format', '{{.OSType}}'], 8000, undefined, 'launcher', true);
      this.snapshot.docker = kind === 'linux' ? 'running' : 'error';
      await this.detectContainer();
    } catch { this.snapshot.docker = 'stopped'; this.snapshot.database = 'stopped'; }
    this.changed(true);
  }
  private async detectContainer() {
    const id = await this.run('docker', this.compose(['ps', '--all', '-q', 'postgres']), 8000, undefined, 'launcher', true);
    if (!id) { this.container = null; this.snapshot.database = 'stopped'; return; }
    const raw = await this.run('docker', ['inspect', '--format', '{{json .}}', id], 8000, undefined, 'launcher', true);
    const inspected = JSON.parse(raw);
    const labels = inspected.Config.Labels;
    const normalize = (p: string) => path.resolve(p).toLowerCase();
    if (labels['com.docker.compose.project'] !== this.config.project || normalize(labels['com.docker.compose.project.working_dir']) !== normalize(path.dirname(this.config.composeFile))) throw new Error('同名数据库容器来自其他目录，已拒绝接管。');
    this.container = id;
    this.snapshot.database = !inspected.State.Running ? 'stopped' : inspected.State.Health?.Status === 'healthy' ? 'running' : 'starting';
    if (!this.closed && this.snapshot.database === 'running' && !this.logProcess) {
      const child = spawn('docker', ['logs', '--follow', '--since', '30s', id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.logProcess = child;
      if (child.stdout) this.logStream(child.stdout, 'database');
      if (child.stderr) this.logStream(child.stderr, 'database');
      child.on('error', error => this.log('launcher', String(error)));
      child.on('close', () => { if (this.logProcess === child) this.logProcess = null; });
    }
    if (!this.closed && this.snapshot.database === 'running' && !this.resourceProcess) {
      const child = spawn('docker', ['stats', '--format', '{{json .}}', id], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.resourceProcess = child;
      let buffer = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', text => {
        buffer += text;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
          if (!clean) continue;
          try {
            const stats = JSON.parse(clean);
            const network = stats.NetIO.split('/').map((value: string) => parseBytes(value));
            this.resources = { cpu: Math.min(100, Number.parseFloat(stats.CPUPerc) / os.cpus().length), memory: parseBytes(stats.MemUsage.split('/')[0]), rx: network[0] ?? 0, tx: network[1] ?? 0, time: Date.now() };
          } catch { this.resources = null; }
        }
      });
      child.on('error', () => { this.resources = null; });
      child.on('close', () => { if (this.resourceProcess === child) this.resourceProcess = null; this.resources = null; });
    }
  }
  private validateConfig() {
    if (!fs.existsSync(this.config.envFile)) throw new Error('缺少环境配置。请根据 .env.example 配置 .env.local 后重试。');
    if (!this.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL。请配置数据库连接后重试。');
    const url = new URL(this.env.DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (url.port || '5432') !== (this.env.POSTGRES_PORT || '5432') || decodeURIComponent(url.pathname.slice(1)) !== this.env.POSTGRES_DB) throw new Error('DATABASE_URL 与本项目 Compose 数据库不匹配，已停止自动启动。');
    if (!this.env.POSTGRES_USER || !this.env.POSTGRES_PASSWORD || !this.env.POSTGRES_DB) throw new Error('缺少 POSTGRES_USER、POSTGRES_PASSWORD 或 POSTGRES_DB。');
  }
  private databasePool() {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000, idleTimeoutMillis: 5000, statement_timeout: 2000, options: '-c default_transaction_read_only=on', application_name: 'anilearn_launcher' });
      this.pool.on('error', error => this.log('launcher', `数据库监控连接：${error.message}`));
    }
    return this.pool;
  }
  private async validateSchema() {
    const required: Record<string, string[]> = { papers: ['analysis_draft', 'inventory', 'analysis_plan', 'pace', 'learning_request', 'revision'], sessions: ['snapshot', 'coverage', 'plan', 'plan_revision', 'pending_plan', 'supplement_draft'], tutors: [], messages: [], boards: [], problems: [], paper_pages: [], app_settings: [], readings: ['paragraphs', 'revision'], reading_sources: [], reading_sessions: ['snapshot', 'notes'], reading_messages: [] };
    const result = await this.databasePool().query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'");
    for (const [table, columns] of Object.entries(required)) if (!result.rows.some(r => r.table_name === table) || columns.some(column => !result.rows.some(r => r.table_name === table && r.column_name === column))) throw new Error('数据库表结构尚未就绪。请审查并运行 npm run db:push 后重试；启动器不会修改表结构。');
  }
  async command(command: Command) {
    if (command === 'shutdown' || command === 'stop') { this.cancelVersion++; this.controller?.abort(); }
    else if (this.snapshot.busy) { this.log('launcher', '当前操作尚未完成，请稍候。'); return; }
    const version = this.cancelVersion;
    this.snapshot.busy = true;
    this.pending = this.pending.then(async () => {
      if (version !== this.cancelVersion && command !== 'shutdown' && command !== 'stop') return;
      const controller = new AbortController(); this.controller = controller;
      this.snapshot.busy = true; this.snapshot.error = null; this.changed(true);
      try {
        if (command === 'start') await this.start(controller.signal);
        if (command === 'restart' || command === 'mode' || command === 'build') {
          await this.stopApp();
          if (command === 'mode') { this.config.mode = this.snapshot.mode === 'production' ? 'development' : 'production'; this.snapshot.mode = this.config.mode; Object.assign(this.env, { NODE_ENV: this.config.mode }); }
          if (command === 'build') fs.rmSync(path.join(this.config.runtime, 'build.json'), { force: true });
          await this.start(controller.signal, command === 'build');
        }
        if (command === 'stop' || command === 'shutdown') await this.stopAll();
        if (command === 'detach') { this.snapshot.detached = true; this.phase('服务已保留在后台'); this.emit('exit', true); }
        if (command === 'shutdown') { this.phase('全部服务已关闭'); this.emit('exit', false); }
        saveJson(path.join(this.config.runtime, 'preferences.json'), { mode: this.snapshot.mode, port: this.config.port });
      } catch (error) {
        let failure = this.redact(error instanceof Error ? error.message : String(error));
        if (['start', 'restart', 'mode', 'build'].includes(command) && this.snapshot.app === 'starting') {
          try { await this.stopApp(); } catch (cleanup) { failure += '\n' + this.redact(String(cleanup)); }
          this.snapshot.app = 'error';
        }
        this.snapshot.error = failure;
        this.phase('操作未完成'); this.log('launcher', this.snapshot.error);
        if (this.snapshot.app === 'starting') this.snapshot.app = 'error';
        if (command === 'shutdown') this.emit('shutdown-error');
      } finally { this.snapshot.busy = false; this.controller = null; this.changed(true); }
    });
    return this.pending;
  }
  private async start(signal: AbortSignal, forceBuild = false) {
    const previousUrl = this.env.DATABASE_URL;
    this.config.mode = this.snapshot.mode;
    this.env = loadEnvironment(this.config); this.redact = makeRedactor(this.env);
    if (previousUrl !== this.env.DATABASE_URL && this.pool) { await this.pool.end(); this.pool = null; }
    this.validateConfig();
    this.phase('检查 Docker 引擎');
    await ensureDocker((args, timeout, signal) => this.run('docker', args, timeout, signal, 'launcher', true), text => { this.snapshot.docker = 'starting'; this.phase(text); }, signal);
    this.snapshot.docker = 'running';
    await this.detectContainer();
    this.snapshot.database = 'starting'; this.phase('启动 PostgreSQL，等待健康检查');
    await this.run('docker', this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'postgres']), 100_000, signal);
    await this.detectContainer(); await this.validateSchema();
    signal.throwIfAborted();
    if (this.snapshot.app === 'running' && !forceBuild) { this.phase('应用已在运行，数据库已就绪'); return; }
    this.phase('检查应用端口');
    if (!(await portAvailable(this.config.port))) {
      await this.detect();
      if (this.identity) { this.phase('已连接现有应用'); return; }
      throw new Error(`端口 ${this.config.port} 被其他进程占用（PID ${await portOwner(this.config.port) ?? '未知'}）。请用 --port 指定其他端口。`);
    }
    if (this.config.mode === 'production' || forceBuild) {
      const current = fingerprint(this.config.root);
      const built = readJson<{ hash: string; environment: string; buildId: string }>(path.join(this.config.runtime, 'build.json'));
      const environment = createHash('sha256').update(fs.readFileSync(this.config.envFile)).digest('hex');
      const buildFile = path.join(this.config.root, '.next/BUILD_ID');
      const buildId = fs.existsSync(buildFile) ? fs.readFileSync(buildFile, 'utf8') : null;
      if (!buildId || built?.buildId !== buildId || built?.hash !== current || built?.environment !== environment || forceBuild) {
        this.phase('生成生产构建');
        fs.rmSync(path.join(this.config.runtime, 'build.json'), { force: true });
        const previousEnv = this.env;
        this.env = loadEnvironment({ ...this.config, mode: 'production' });
        this.redact = makeRedactor({ ...previousEnv, ...this.env });
        try { await this.run(process.execPath, [path.join(this.config.root, 'node_modules/next/dist/bin/next'), 'build'], 600_000, signal, 'app'); }
        finally { this.env = previousEnv; Object.assign(process.env, { NODE_ENV: this.config.mode }); this.redact = makeRedactor(this.env); }
        signal.throwIfAborted();
        if (fingerprint(this.config.root) !== current) throw new Error('构建过程中源码发生变化，请重新构建后启动。');
        saveJson(path.join(this.config.runtime, 'build.json'), { hash: current, environment, buildId: fs.readFileSync(buildFile, 'utf8') });
      } else this.log('launcher', '生产构建未变化，直接复用。');
    }
    this.phase(this.config.mode === 'production' ? '启动生产服务' : '启动开发服务'); this.snapshot.app = 'starting';
    // Windows termination can interrupt Turbopack's persistent dev cache; use Next's Webpack option.
    const child = spawn(process.execPath, [path.join(this.config.root, 'scripts/launcher/server-child.cjs'), this.config.mode === 'production' ? 'start' : 'dev', this.config.root, ...(this.config.mode === 'development' ? ['--webpack'] : []), '--hostname', '127.0.0.1', '--port', String(this.config.port)], {
      cwd: this.config.root, env: { ...this.env, NODE_ENV: this.config.mode, NEXT_EXIT_TIMEOUT_MS: '5000' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.appProcess = child;
    if (child.stdout) this.logStream(child.stdout, 'app'); if (child.stderr) this.logStream(child.stderr, 'app');
    child.on('error', error => { this.snapshot.error = this.redact(error.message); this.snapshot.app = 'error'; this.changed(true); });
    child.on('exit', () => { if (this.appProcess === child) { this.appProcess = null; this.snapshot.app = 'stopped'; this.snapshot.startedAt = null; this.changed(true); } });
    await sleep(600, signal);
    this.identity = (await processes()).find(p => p.pid === child.pid) ?? null;
    if (!this.identity) throw new Error('应用进程未启动，请查看应用日志。');
    this.record = recordProcess(this.identity, this.config.root);
    saveJson(path.join(this.config.runtime, 'app.json'), this.record);
    const until = Date.now() + 120_000;
    this.phase('等待应用健康检查');
    for (;;) {
      signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode) throw new Error('应用启动失败，请查看应用日志。');
      try { const response = await fetch(`http://127.0.0.1:${this.config.port}/api/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) }); if (response.ok && (await response.json()).ok) break; } catch { /* Retry until the readiness deadline. */ }
      if (Date.now() > until) throw new Error('应用健康检查超时，可停止后重试。');
      await sleep(1000, signal);
    }
    this.snapshot.app = 'running'; this.snapshot.startedAt = Date.now(); this.phase('AniLearn 已就绪');
  }
  private async stopApp() {
    this.phase('停止 AniLearn 应用');
    const all = await processes();
    const identity = this.identity ?? all.find(p => p.pid === this.appProcess?.pid && belongsToProject(p, this.config.root));
    const captured = identity && belongsToProject(identity, this.config.root) ? descendants(all, identity) : [];
    if (this.appProcess?.connected) {
      const child = this.appProcess; child.send({ type: 'stop' });
      const until = Date.now() + 10_000;
      while (child.exitCode === null && !child.signalCode && Date.now() < until) await sleep(200);
    }
    const afterGrace = await processes();
    for (const item of captured.reverse()) if (afterGrace.some(p => sameProcess(p, item))) await terminateTree(item);
    const remaining = await processes();
    if (captured.some(identity => remaining.some(p => sameProcess(identity, p)))) throw new Error('应用进程尚未退出，数据库保持运行以便重试关闭。');
    this.appProcess = null; this.identity = null; this.record = null; this.previous = null;
    this.snapshot.app = 'stopped'; this.snapshot.startedAt = null; this.snapshot.processes = [];
    fs.rmSync(path.join(this.config.runtime, 'app.json'), { force: true });
  }
  private async stopAll() {
    await this.stopApp();
    this.stopLog();
    if (this.pool) { const pool = this.pool; this.pool = null; await pool.end(); }
    this.phase('停止本项目 PostgreSQL，保留数据卷');
    // A cancelled cold start has no owned container to stop when the engine is still offline.
    if (this.container || this.snapshot.docker === 'running' || this.snapshot.database === 'running') {
      try { await this.detectContainer(); } catch (error) { throw new Error(`无法核验数据库归属，未执行停止：${String(error)}`); }
    }
    if (this.container) await this.run('docker', this.compose(['stop', '--timeout', '15', 'postgres']), 30_000);
    this.snapshot.database = 'stopped'; this.snapshot.stats = null;
    this.stopLog(); this.phase('应用与数据库已关闭');
  }
  private async databaseStats(): Promise<DatabaseStats> {
    const pool = this.databasePool();
    const size = await pool.query("SELECT pg_database_size(current_database())::float8 AS size, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS connections");
    const papers = await pool.query('SELECT status, count(*)::int AS count FROM papers GROUP BY status');
    const sessions = await pool.query('SELECT status, count(*)::int AS count FROM sessions GROUP BY status');
    const counts: Record<string, number> = {};
    for (const table of ['tutors', 'problems', 'messages', 'boards']) counts[table] = (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
    return { ...size.rows[0], papers: Object.fromEntries(papers.rows.map(row => [row.status, row.count])), sessions: Object.fromEntries(sessions.rows.map(row => [row.status, row.count])), counts };
  }
  private async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const now = Date.now();
      const sample: Sample = { time: now, appCpu: null, appMemory: null, dbCpu: null, dbMemory: null, rx: null, tx: null };
      let appCpu = new Map<string, number>(), rx = 0, tx = 0;
      try {
        const all = await processes();
        const tree = this.identity ? descendants(all, this.identity) : [];
        this.snapshot.processes = tree.map(p => ({ pid: p.pid, parentPid: p.parentPid, memory: p.memory }));
        if (tree.length) {
          sample.appMemory = tree.reduce((n, p) => n + p.memory, 0);
          appCpu = new Map(tree.map(p => [p.pid + ':' + p.created, p.cpuSeconds]));
          if (this.previous) sample.appCpu = Math.min(100, tree.reduce((n, p) => n + Math.max(0, p.cpuSeconds - (this.previous!.cpu.get(p.pid + ':' + p.created) ?? p.cpuSeconds)), 0) / ((now - this.previous.time) / 1000) / os.cpus().length * 100);
        } else if (this.snapshot.app === 'running') { this.identity = null; this.snapshot.app = 'stopped'; this.snapshot.startedAt = null; }
      } catch { /* A failed sample is represented by null values. */ }
      if (this.resources && now - this.resources.time < 10_000 && this.snapshot.database === 'running') {
        sample.dbCpu = this.resources.cpu; sample.dbMemory = this.resources.memory;
        rx = this.resources.rx; tx = this.resources.tx;
        if (this.previous) { const seconds = (now - this.previous.time) / 1000; sample.rx = Math.max(0, rx - this.previous.rx) / seconds; sample.tx = Math.max(0, tx - this.previous.tx) / seconds; }
      }
      if (!this.snapshot.busy && !this.detecting && now - this.lastContainer > 10_000) {
        this.detecting = true; this.lastContainer = now;
        void this.run('docker', ['info', '--format', '{{.OSType}}'], 8000, undefined, 'launcher', true).then(async kind => {
          this.snapshot.docker = kind === 'linux' ? 'running' : 'error'; await this.detectContainer();
        }).catch(() => { this.snapshot.docker = 'stopped'; this.snapshot.database = 'error'; }).finally(() => { this.detecting = false; this.changed(true); });
      }
      this.previous = { time: now, cpu: appCpu, rx, tx };
      this.snapshot.samples.push(sample); this.snapshot.samples = this.snapshot.samples.filter(s => now - s.time <= 120_000);
      if (this.snapshot.database === 'running' && !this.snapshot.busy && !this.statsPolling && now - this.lastDb >= this.dbDelay) {
        this.lastDb = now;
        this.statsPolling = true;
        void this.databaseStats().then(stats => { if (this.snapshot.database === 'running' && !this.closed) this.snapshot.stats = stats; this.dbDelay = 5000; })
          .catch(() => { this.snapshot.stats = null; this.dbDelay = Math.min(60_000, this.dbDelay * 2); })
          .finally(() => { this.statsPolling = false; this.changed(true); });
      } else if (this.snapshot.database !== 'running') this.snapshot.stats = null;
      this.changed(true);
    } finally { this.polling = false; }
  }
  async dispose() {
    this.closed = true; if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopLog();
    if (this.pool) await this.pool.end();
  }
  private stopLog() { const process = this.logProcess; this.logProcess = null; process?.kill(); const resource = this.resourceProcess; this.resourceProcess = null; resource?.kill(); this.resources = null; }
}
