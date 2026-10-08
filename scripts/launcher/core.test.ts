import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFor, databaseLog, fingerprint, loadEnvironment, makeRedactor, saveJson } from './config';
import { ensureDocker } from './docker';
import { belongsToProject, descendants, matchesRecord, recordProcess, sameProcess } from './processes';
import { parseBytes } from './manager';
import { filterLogs } from './ui';
import type { ProcessIdentity, LogLine } from './types';

test('process identity rejects reused PID and descendants stay scoped to the application', () => {
  const root: ProcessIdentity = { pid: 1, parentPid: 0, created: '2026-10-08T10:00:00Z', command: 'node D:\\Repo\\AniLearn\\scripts\\launcher\\server-child.cjs start', cpuSeconds: 0, memory: 1 };
  const child = { ...root, pid: 2, parentPid: 1, command: 'node next' };
  const unrelated = { ...root, pid: 3, parentPid: 0, command: 'node other-app' };
  assert.equal(sameProcess(root, { ...root, created: 'reused' }), false);
  assert.deepEqual(descendants([root, child, unrelated], root).map(p => p.pid), [1, 2]);
  assert.equal(belongsToProject(root, 'D:\\Repo\\AniLearn'), true);
  assert.equal(belongsToProject(unrelated, 'D:\\Repo\\AniLearn'), false);
  assert.equal(belongsToProject({ ...root, command: 'node D:\\Repo\\AniLearn-other\\node_modules\\next\\dist\\server.js' }, 'D:\\Repo\\AniLearn'), false);
  assert.equal(belongsToProject({ ...root, command: 'node unrelated.js --config D:\\Repo\\AniLearn\\next.config.ts' }, 'D:\\Repo\\AniLearn'), false);
  assert.equal(belongsToProject({ ...root, command: 'node D:\\Repo\\AniLearn\\node_modules\\next\\dist\\bin\\next dev' }, 'D:\\Repo\\AniLearn'), true);
  assert.deepEqual(descendants([{ ...root, created: 'reused' }, child], root), []);
  const orphan = { ...child, created: '2026-10-08T09:00:00Z' };
  assert.deepEqual(descendants([root, orphan], root).map(p => p.pid), [1]);
  const record = recordProcess({ ...root, command: root.command + ' token=secret-value' }, 'D:\\Repo\\AniLearn');
  assert.ok(!JSON.stringify(record).includes('secret-value'));
  assert.equal(matchesRecord({ ...root, command: root.command + ' token=secret-value' }, record, 'D:\\Repo\\AniLearn'), true);
  assert.equal(matchesRecord(root, record, 'D:\\Repo\\AniLearn'), false);
  assert.equal(matchesRecord({ ...root, created: 'reused' }, record, 'D:\\Repo\\AniLearn'), false);
  assert.equal(matchesRecord(root, record, 'D:\\Repo\\Other'), false);
});
test('redaction protects credentials, proxy URLs, terminal controls and uploads', () => {
  const redact = makeRedactor({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://user:long-password@localhost/db', FISH_API_KEY: 'my-secret-fish-key', POSTGRES_PASSWORD: 'long-password' });
  const safe = redact('\x1b[31merror my-secret-fish-key postgresql://user:long-password@localhost/db https://user:proxy-password@example.test data:image/png;base64,QUJDRA== Bearer token-that-must-be-hidden');
  for (const secret of ['my-secret-fish-key', 'long-password', 'proxy-password', 'QUJDRA==', 'token-that-must-be-hidden', '\x1b']) assert.ok(!safe.includes(secret));
});
test('build fingerprint notices source, assets, config and credentials without depending on runtime caches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilearn-fingerprint-'));
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/page.tsx'), 'first');
    const before = fingerprint(root);
    fs.mkdirSync(path.join(root, '.anilearn')); fs.writeFileSync(path.join(root, '.anilearn/log'), 'irrelevant');
    assert.equal(fingerprint(root), before);
    fs.writeFileSync(path.join(root, 'src/page.tsx'), 'second'); assert.notEqual(fingerprint(root), before);
    const source = fingerprint(root); fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=changed'); assert.notEqual(fingerprint(root), source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('database log filtering excludes SQL, parameters, row contents and multiline payloads', () => {
  const prefix = '2026-10-08 12:00:00 UTC [32] ';
  assert.equal(databaseLog(prefix + 'STATEMENT: INSERT INTO messages VALUES(\'private\')'), '');
  assert.equal(databaseLog(prefix + 'DETAIL: Failing row contains (private).'), '');
  assert.equal(databaseLog('private continuation'), '');
  assert.equal(databaseLog(prefix + 'LOG: execute statement: private'), '');
  assert.ok(!databaseLog(prefix + 'ERROR: invalid input syntax: private').includes('private'));
  assert.equal(databaseLog(prefix + 'LOG: database system is ready to accept connections'), prefix + 'LOG: database system is ready to accept connections');
});
test('preferences persist modes, explicit arguments win, and invalid ports fail early', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilearn-config-'));
  try {
    saveJson(path.join(root, '.anilearn/anilearn/preferences.json'), { mode: 'development', port: 3100 });
    assert.equal(configFor(root, []).mode, 'development');
    assert.equal(configFor(root, ['--mode', 'production', '--port', '3200']).port, 3200);
    assert.throws(() => configFor(root, ['--port', '99']));
    assert.throws(() => configFor(root, ['--project', '../bad']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Docker units are parsed with their actual decimal or binary multipliers', () => {
  assert.equal(parseBytes('12.5MiB'), 12.5 * 1024 ** 2);
  assert.equal(parseBytes('2 MB'), 2_000_000);
  assert.equal(parseBytes('not available'), null);
});
test('log filters combine source, search, severity and paused snapshot', () => {
  const logs: LogLine[] = [
    { id: 1, time: 0, source: 'app', level: 'info', text: '中文启动' },
    { id: 2, time: 0, source: 'database', level: 'error', text: '连接失败' },
    { id: 3, time: 0, source: 'app', level: 'error', text: '中文失败' },
  ];
  assert.deepEqual(filterLogs(logs, 'app', '中文', true, null).map(line => line.id), [3]);
  assert.deepEqual(filterLogs(logs, 'all', '', false, 2).map(line => line.id), [1, 2]);
});
test('mode changes override the environment loader initial mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilearn-env-'));
  const old = process.env.NODE_ENV;
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'POSTGRES_USER=test\n');
    assert.equal(loadEnvironment(configFor(root, ['--mode', 'development'])).NODE_ENV, 'development');
    assert.equal(loadEnvironment(configFor(root, ['--mode', 'production'])).NODE_ENV, 'production');
  } finally { Object.assign(process.env, { NODE_ENV: old }); fs.rmSync(root, { recursive: true, force: true }); }
});
test('Docker cold start waits for Linux readiness and cancellation never starts Desktop', async () => {
  const calls: string[][] = [], phases: string[] = [];
  let info = 0;
  await ensureDocker(async args => { calls.push(args); if (args[0] === 'info' && info++ < 2) throw new Error('engine unavailable'); return args[0] === 'info' ? 'linux' : ''; }, text => phases.push(text), new AbortController().signal, async () => {});
  assert.deepEqual(calls[1], ['desktop', 'start', '--detach']); assert.ok(phases.includes('启动 Docker Desktop'));
  const controller = new AbortController(); controller.abort();
  const cancelled: string[][] = [];
  await assert.rejects(ensureDocker(async args => { cancelled.push(args); throw new Error('offline'); }, () => {}, controller.signal));
  assert.ok(!cancelled.some(args => args[0] === 'desktop'));
  await assert.rejects(ensureDocker(async () => 'windows', () => {}, new AbortController().signal), /Linux/);
});
