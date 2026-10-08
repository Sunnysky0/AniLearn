import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFor } from './config';
import { connectManager, runDaemon } from './ipc';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('AniLearn TUI\n\nnpm run launcher -- [--port 3000] [--mode production|development] [--no-autostart]\n\nQ / Ctrl+C: 关闭全部服务并退出；D: 保留后台并退出；H: 操作菜单。');
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const config = configFor(root, args);
  if (args.includes('--daemon')) { await runDaemon(config); return; }
  if (process.platform !== 'win32') throw new Error('当前启动器面向 Windows，请在 Windows Terminal 或 PowerShell 中运行。');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI 需要交互终端。请双击 AniLearn.cmd 或在 Windows Terminal 中运行 npm run launcher。');
  const connection = await connectManager(config);
  process.env.FORCE_COLOR ??= '3';
  const { render } = await import('ink');
  const { Dashboard } = await import('./ui');
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const instance = render(<Dashboard connection={connection} />, { exitOnCtrlC: false, patchConsole: false, maxFps: 10 });
  let finished = false;
  const finish = (detached: boolean) => {
    if (finished) return; finished = true;
    instance.unmount(); connection.close();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.log(detached ? 'AniLearn 已保留在后台。再次打开启动器可连接。' : 'AniLearn 应用与数据库已关闭，数据已保留。');
  };
  connection.on('exit', finish);
  connection.on('close', () => {
    if (finished) return;
    finished = true; instance.unmount(); process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.error('与后台管理器的连接已断开，请重新打开面板查看服务状态。'); process.exitCode = 1;
  });
  process.on('SIGINT', () => connection.command('shutdown'));
  process.on('SIGTERM', () => connection.command('shutdown'));
  if (!args.includes('--no-autostart')) connection.command('start');
  await instance.waitUntilExit();
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
