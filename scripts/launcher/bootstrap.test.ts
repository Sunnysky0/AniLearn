import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const bootstrapPath = path.resolve('scripts/launcher/bootstrap.cjs');
const source = fs.readFileSync(bootstrapPath, 'utf8');
const requireFromBootstrap = createRequire(bootstrapPath);
const versions = {
  tsx: '4.23.15', ink: '6.8.0', next: '16.2.6', '@next/env': '16.2.6',
  pg: '8.20.0', react: '19.2.6', dotenv: '17.3.1',
  'fast-xml-parser': '5.11.2', yauzl: '3.4.0', parse5: '8.0.1', '@types/yauzl': '3.4.0',
};

function installLocked(root: string) {
  for (const [name, version] of Object.entries(versions)) {
    const folder = path.join(root, 'node_modules', name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version }));
  }
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilearn-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dependencies = Object.fromEntries(Object.entries(versions).filter(([name]) => name !== '@types/yauzl').map(([name, version]) => [name, `^${version}`]));
  const manifest = { dependencies, devDependencies: { '@types/yauzl': '^3.4.0' } };
  const packages = Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': manifest, ...packages } }));
  const npmFolder = path.join(root, 'node_modules/npm/bin');
  fs.mkdirSync(npmFolder, { recursive: true });
  fs.writeFileSync(path.join(npmFolder, 'npm-cli.js'), '');
  installLocked(root);
  return root;
}

type InstallResult = { status: number | null; error?: Error };
function runBootstrap(root: string, install: () => InstallResult = () => ({ status: 0 })) {
  const calls: Array<{ executable: string; args: string[]; options: { cwd: string; windowsHide: boolean } }> = [];
  const messages: string[] = [];
  const exit = {};
  const runtime = {
    versions: process.versions, execPath: path.join(root, 'node.exe'),
    argv: ['node', bootstrapPath, '--no-autostart'], exitCode: undefined as number | undefined,
    chdir: (directory: string) => assert.equal(directory, root),
    exit: (code: number) => { runtime.exitCode = code; throw exit; },
  };
  const spawnSync = (executable: string, args: string[], options: { cwd: string; windowsHide: boolean }) => {
    calls.push({ executable, args: [...args], options: { ...options } });
    return args[1] === 'ci' ? install() : { status: 0 };
  };
  try {
    vm.runInNewContext(source, {
      __dirname: path.join(root, 'scripts/launcher'), process: runtime,
      require: (name: string) => name === 'node:child_process' ? { spawnSync } : requireFromBootstrap(name),
      console: { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) },
    }, { filename: bootstrapPath });
  } catch (error) { if (error !== exit) throw error; }
  return { calls, messages, exitCode: runtime.exitCode };
}

test('matching locked dependencies launch without npm, including types-only packages', t => {
  const root = fixture(t);
  const result = runBootstrap(root);
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].args, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/launcher/index.tsx'), '--no-autostart']);
});

for (const name of ['fast-xml-parser', 'yauzl', '@types/yauzl']) {
  test(`missing ${name} triggers a locked install before launching`, t => {
    const root = fixture(t);
    fs.rmSync(path.join(root, 'node_modules', name, 'package.json'));
    const result = runBootstrap(root, () => { installLocked(root); return { status: 0 }; });
    assert.equal(result.exitCode, 0);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.calls[0].args, [path.join(root, 'node_modules/npm/bin/npm-cli.js'), 'ci', '--include=dev']);
    assert.equal(result.calls[0].options.cwd, root);
    assert.equal(result.calls[0].options.windowsHide, true);
  });
}

test('an installed parse5 version that differs from the lock is synchronized', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'node_modules/parse5/package.json'), JSON.stringify({ name: 'parse5', version: '7.3.0' }));
  const result = runBootstrap(root, () => { installLocked(root); return { status: 0 }; });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.length, 2);
});

test('manifest and lock disagreement cannot reuse apparently installed dependencies', t => {
  const root = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.dependencies['fast-xml-parser'] = '^6.0.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  const result = runBootstrap(root, () => ({ status: 2 }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].args[1], 'ci');
});

test('a missing lock file attempts installation and stops on failure', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'package-lock.json'));
  const result = runBootstrap(root, () => ({ status: 1 }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.length, 1);
});

for (const outcome of [{ status: 23 }, { status: null }, { status: null, error: new Error('spawn failed') }]) {
  test(`unsuccessful npm result (${outcome.status}, error=${Boolean(outcome.error)}) prevents launch`, t => {
    const root = fixture(t);
    fs.rmSync(path.join(root, 'node_modules/yauzl/package.json'));
    const result = runBootstrap(root, () => outcome);
    assert.equal(result.exitCode, outcome.status || 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].args[1], 'ci');
  });
}

test('npm success without repairing dependencies still prevents launch', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'node_modules/yauzl/package.json'));
  const result = runBootstrap(root);
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.length, 1);
  assert.ok(result.messages.some(message => message.includes('安装后依赖仍与锁文件不一致')));
});

test('missing npm explains the repair command without launching', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'node_modules/yauzl/package.json'));
  fs.rmSync(path.join(root, 'node_modules/npm/bin/npm-cli.js'));
  const result = runBootstrap(root);
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.length, 0);
  assert.ok(result.messages.some(message => message.includes('npm ci --include=dev')));
});
