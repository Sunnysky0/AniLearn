const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('需要 Node.js 22 或更新版本。');
  process.exit(1);
}
function dependenciesReady() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const lockedRoot = lock.packages?.[''];
    if (!lockedRoot) return false;
    for (const section of ['dependencies', 'devDependencies']) {
      const declared = manifest[section] ?? {};
      const locked = lockedRoot[section] ?? {};
      if (Object.keys(declared).length !== Object.keys(locked).length) return false;
      for (const [name, range] of Object.entries(declared)) {
        if (locked[name] !== range) return false;
        const version = lock.packages[`node_modules/${name}`]?.version;
        const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
        if (!version || installed.version !== version) return false;
      }
    }
    return true;
  } catch { return false; }
}
if (!dependenciesReady()) {
  console.log('项目依赖缺失或与锁文件不一致，正在同步 AniLearn 依赖…');
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npm)) { console.error('未找到 npm。请运行 npm ci --include=dev 安装项目依赖后重试。'); process.exit(1); }
  const installed = spawnSync(process.execPath, [npm, 'ci', '--include=dev'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (installed.error) { console.error('依赖安装进程启动失败，请运行 npm ci --include=dev 后重试。'); process.exit(1); }
  if (installed.status !== 0) process.exit(installed.status || 1);
  if (!dependenciesReady()) { console.error('安装后依赖仍与锁文件不一致，请检查 npm 安装结果后重试。'); process.exit(1); }
}
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/launcher/index.tsx'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
