const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('需要 Node.js 22 或更新版本。');
  process.exit(1);
}
const dependenciesReady = ['tsx', 'ink', 'next', '@next/env', 'pg', 'react', 'dotenv'].every(name => {
  try { require.resolve(name, { paths: [root] }); return true; } catch { return false; }
});
if (!dependenciesReady) {
  console.log('正在安装 AniLearn 依赖…');
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npm)) { console.error('未找到 npm。请运行 npm ci 安装项目依赖后重试。'); process.exit(1); }
  const installed = spawnSync(process.execPath, [npm, 'ci'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (installed.status !== 0) process.exit(installed.status || 1);
}
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/launcher/index.tsx'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
