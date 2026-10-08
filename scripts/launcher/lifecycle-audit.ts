import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { configFor, saveJson } from './config';
import { connectManager, type Connection } from './ipc';
import { belongsToProject, portAvailable, processes, sameProcess } from './processes';
import type { Config } from './types';

const root = process.cwd();
const execute = promisify(execFile);
const project = `anilearn_launcher_audit_${Date.now()}`;
const folder = path.join(root, '.anilearn', project);
fs.mkdirSync(folder, { recursive: true });
const freePort = () => new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); }); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(300); }
  throw new Error(message);
}
async function command(connection: Connection, name: Parameters<Connection['command']>[0], timeout = 150_000) {
  connection.command(name);
  await until(() => Boolean(connection.snapshot?.busy), `${name} did not start`, 15_000);
  await until(() => !connection.snapshot?.busy, `${name} timed out`, timeout);
  assert.equal(connection.snapshot?.error, null, `${name}: ${connection.snapshot?.error}`);
  console.log(`Lifecycle: ${name} passed`);
}
async function compose(config: Config, args: string[]) {
  const result = await execute('docker', ['compose', '-p', config.project, '--env-file', config.envFile, '-f', config.composeFile, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return result.stdout;
}
async function run() {
  const dbPort = await freePort(), appPort = await freePort();
  const password = crypto.randomBytes(16).toString('hex');
  const databaseUrl = `postgresql://anilearn:${password}@127.0.0.1:${dbPort}/launcher_audit`;
  const envFile = path.join(folder, '.env.local'), composeFile = path.join(folder, 'compose.yaml');
  fs.writeFileSync(envFile, `POSTGRES_USER=anilearn\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=launcher_audit\nPOSTGRES_PORT=${dbPort}\nDATABASE_URL=${databaseUrl}\n`);
  fs.copyFileSync(path.join(root, 'compose.yaml'), composeFile);
  const config = configFor(root, ['--project', project, '--env-file', envFile, '--compose-file', composeFile, '--port', String(appPort), '--mode', 'development']);
  const checks: string[] = [];
  const neighbors: Array<{ ID: string; Names: string; State: string }> = (await execute('docker', ['ps', '-a', '--format', 'json'], { encoding: 'utf8' })).stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  let connection: Connection | null = null;
  try {
    const existing = (await execute('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' })).stdout.trim();
    assert.equal(existing, '', 'Audit project must not exist before this run');
    await compose(config, ['up', '-d', '--wait', 'postgres']);
    connection = await connectManager(config);
    connection.command('start');
    await until(() => Boolean(connection!.snapshot!.busy), 'schema check did not start');
    await until(() => !connection!.snapshot!.busy, 'schema check did not finish');
    assert.ok(connection.snapshot!.error?.includes('表结构尚未就绪'));
    const empty = new Pool({ connectionString: databaseUrl });
    assert.equal((await empty.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0);
    await empty.end(); checks.push('missing schema is explained without automatic database mutations');
    await execute(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'), 'push', '--force'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 120_000 });
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query("INSERT INTO papers(title, subject) VALUES('保留数据测试', '数学')"); await pool.end();
    await command(connection, 'start');
    assert.equal(connection.snapshot!.app, 'running'); checks.push('development startup and health');
    const appBefore = (await processes()).filter(p => belongsToProject(p, root));
    await compose(config, ['stop', '--timeout', '15', 'postgres']);
    await command(connection, 'start');
    const appAfter = await processes();
    assert.ok(appBefore.every(p => appAfter.some(current => sameProcess(p, current))));
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).status, 200);
    checks.push('starting an existing app restores its stopped database without replacing the app');
    const second = await connectManager(config); assert.equal(second.snapshot!.port, appPort); second.close(); checks.push('duplicate panel reconnects without a duplicate server');
    await assert.rejects(connectManager({ ...config, port: appPort + 1 }), /已有面板使用端口/); checks.push('conflicting manager port is rejected without changing background ownership');
    await until(() => connection!.snapshot!.stats !== null, 'database monitoring unavailable');
    assert.equal(connection.snapshot!.stats!.papers.uploaded, 1); checks.push('read-only database counts');
    await until(() => connection!.snapshot!.samples.some(sample => sample.dbMemory !== null && sample.appMemory !== null), 'resource metrics unavailable'); checks.push('process and PostgreSQL resource monitoring');
    await command(connection, 'restart'); checks.push('application restart retains database');
    connection.command('detach'); await new Promise(resolve => connection!.once('exit', resolve)); connection.close();
    await pause(1000); assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).status, 200);
    connection = await connectManager(config); checks.push('explicit background keep and reconnect');
    await command(connection, 'mode', 660_000); assert.equal(connection.snapshot!.mode, 'production'); checks.push('production build and mode switch');
    await command(connection, 'restart'); assert.ok(connection.snapshot!.logs.some(line => line.text.includes('直接复用'))); checks.push('unchanged production build reused');
    const originalEnv = fs.readFileSync(envFile, 'utf8');
    fs.appendFileSync(envFile, 'NODE_OPTIONS=--require ./missing-launcher-audit-module.cjs\n');
    connection.command('restart');
    await until(() => Boolean(connection!.snapshot!.busy), 'failed build did not start');
    await until(() => !connection!.snapshot!.busy, 'failed build did not finish');
    assert.ok(connection.snapshot!.error);
    assert.equal(fs.existsSync(path.join(folder, 'build.json')), false);
    fs.writeFileSync(envFile, originalEnv);
    await command(connection, 'start', 660_000); checks.push('changed build input invalidates cache and failed build can be retried');
    await command(connection, 'build', 660_000); checks.push('manual production rebuild');
    await command(connection, 'stop'); checks.push('complete stop leaves data volume');
    await until(async () => (await portAvailable(appPort)) && (await portAvailable(dbPort)), 'stopped services did not release their ports', 30_000); checks.push('full shutdown releases both listening ports');
    await compose(config, ['up', '-d', '--wait', 'postgres']);
    const preserved = new Pool({ connectionString: databaseUrl }); assert.equal((await preserved.query('SELECT count(*)::int AS count FROM papers')).rows[0].count, 1); await preserved.end(); checks.push('data preserved after database restart');
    await command(connection, 'start', 660_000);
    connection.close(); connection = null;
    await until(async () => {
      const id = (await compose(config, ['ps', '-q', 'postgres'])).trim(); return !id;
    }, 'unexpected panel disconnect did not stop database', 90_000); checks.push('unexpected terminal loss stops app and database');
    const conflict = net.createServer(); await new Promise<void>(resolve => conflict.listen(appPort, '127.0.0.1', resolve));
    connection = await connectManager(config); connection.command('start');
    await until(() => Boolean(connection!.snapshot!.busy), 'conflict operation did not start'); await until(() => !connection!.snapshot!.busy, 'conflict operation did not finish');
    assert.ok(connection.snapshot!.error?.includes('被其他进程占用')); assert.ok(conflict.listening); conflict.close(); checks.push('unknown port owner preserved');
    connection.command('start');
    await until(() => connection!.snapshot!.app === 'starting', 'startup cancellation target not reached');
    const owned = (await processes()).filter(p => belongsToProject(p, root));
    const exit = new Promise(resolve => connection!.once('exit', resolve)); connection.command('shutdown');
    await exit; connection.close(); connection = null;
    const remaining = await processes();
    assert.ok(owned.every(p => !remaining.some(current => sameProcess(p, current))));
    await until(async () => (await portAvailable(appPort)) && (await portAvailable(dbPort)), 'cancelled services did not release their ports', 30_000);
    checks.push('exit during application startup cancels, removes child processes and releases ports');
    for (const neighbor of neighbors) {
      const state = (await execute('docker', ['inspect', '--format', '{{.State.Status}}', neighbor.ID], { encoding: 'utf8' })).stdout.trim();
      assert.equal(state, neighbor.State, `${neighbor.Names} state changed`);
    }
    checks.push('other Compose projects retain their original state');
    saveJson(path.join(folder, 'results.json'), { project, appPort, dbPort, checks });
    console.log(JSON.stringify({ project, checks }, null, 2));
  } finally {
    if (connection && !connection.socket.destroyed) {
      connection.command('shutdown');
      await Promise.race([new Promise(resolve => connection!.once('exit', resolve)), pause(45_000)]); connection.close();
    }
    // This run created the project after checking it did not exist; never remove another project's volume.
    await compose(config, ['down', '--volumes']);
    fs.rmSync(envFile, { force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
