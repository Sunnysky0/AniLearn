import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readJson, saveJson } from './config';
import { Manager, managerKey } from './manager';
import type { ClientMessage, Command, Config, ServerMessage, Snapshot } from './types';

interface DaemonState { pipe: string; token: string; pid: number; port: number }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function framing(socket: net.Socket, onMessage: (message: unknown) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4_000_000) { socket.destroy(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { onMessage(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
}
export class Connection extends EventEmitter {
  snapshot: Snapshot | null = null;
  private timer: NodeJS.Timeout;
  constructor(readonly socket: net.Socket, token: string) {
    super();
    framing(socket, data => {
      const message = data as ServerMessage;
      if (message.type === 'snapshot') { this.snapshot = message.snapshot; this.emit('snapshot', message.snapshot); }
      if (message.type === 'exit') this.emit('exit', message.detached);
    });
    socket.on('close', () => { clearInterval(this.timer); this.emit('close'); });
    socket.on('error', () => {});
    socket.write(JSON.stringify({ type: 'hello', token }) + '\n');
    this.timer = setInterval(() => socket.write('{"type":"ping"}\n'), 3000);
  }
  command(command: Command) { this.socket.write(JSON.stringify({ type: 'command', command }) + '\n'); }
  close() { clearInterval(this.timer); this.socket.end(); }
}
async function connect(state: DaemonState): Promise<Connection> {
  const socket = net.connect(state.pipe);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('后台管理器连接超时。')); }, 3000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => {
      const client = new Connection(socket, state.token);
      client.once('snapshot', () => { clearTimeout(timer); resolve(client); });
      client.once('close', () => { clearTimeout(timer); reject(new Error('后台管理器连接已关闭。')); });
    });
  });
}
export async function connectManager(config: Config): Promise<Connection> {
  const stateFile = path.join(config.runtime, 'daemon.json');
  fs.mkdirSync(config.runtime, { recursive: true });
  const old = readJson<DaemonState>(stateFile);
  if (old) {
    try {
      if (old.port !== config.port) {
        const probe = net.connect(old.pipe);
        const alive = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 1000);
          probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true); });
          probe.once('error', () => { clearTimeout(timer); resolve(false); });
        });
        if (alive) throw new Error(`已有面板使用端口 ${old.port}。请关闭全部服务后再更换端口。`);
      }
      const connection = await connect(old);
      if (old.port !== config.port) { connection.close(); throw new Error(`已有面板使用端口 ${old.port}。请关闭全部服务后再更换端口。`); }
      return connection;
    } catch (error) { if (error instanceof Error && error.message.startsWith('已有面板')) throw error; }
  }
  const args = [path.join(config.root, 'scripts/launcher/index.tsx'), '--daemon', '--port', String(config.port), '--mode', config.mode, '--env-file', config.envFile, '--compose-file', config.composeFile, '--project', config.project];
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: config.root, detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    await pause(300);
    const state = readJson<DaemonState>(stateFile);
    if (!state) continue;
    try { return await connect(state); } catch { /* The detached manager may still be initializing. */ }
  }
  throw new Error('后台管理器未能启动。请检查 Node 版本、依赖与目录权限。');
}
export async function runDaemon(config: Config) {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\anilearn-${managerKey(config)}` : path.join(config.runtime, 'manager.sock');
  const stateFile = path.join(config.runtime, 'daemon.json');
  fs.mkdirSync(config.runtime, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const manager = new Manager(config);
  const clients = new Map<net.Socket, { authorized: boolean; lastPing: number }>();
  let closing = false, ready = false, unattendedAt = Date.now();
  const waiting: Command[] = [];
  const send = (socket: net.Socket, message: ServerMessage) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
  const server = net.createServer(socket => {
    const info = { authorized: false, lastPing: Date.now() }; clients.set(socket, info);
    socket.on('error', () => {});
    framing(socket, data => {
      const message = data as ClientMessage;
      if (message.type === 'hello' && message.token === token) {
        info.authorized = true; info.lastPing = Date.now(); manager.snapshot.detached = false;
        send(socket, { type: 'snapshot', snapshot: manager.snapshot });
      } else if (!info.authorized) socket.destroy();
      else if (message.type === 'ping') info.lastPing = Date.now();
      else if (message.type === 'command' && ['start', 'stop', 'restart', 'mode', 'build', 'shutdown', 'detach'].includes(message.command)) {
        if (ready) void manager.command(message.command); else waiting.push(message.command);
      }
    });
    socket.on('close', () => { clients.delete(socket); unattendedAt = Date.now(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); }).catch(() => { process.exit(0); });
  saveJson(stateFile, { pipe, token, pid: process.pid, port: config.port });
  manager.on('snapshot', snapshot => { for (const [socket, info] of clients) if (info.authorized) send(socket, { type: 'snapshot', snapshot }); });
  manager.on('exit', async (detached: boolean) => {
    await Promise.all([...clients].filter(([, info]) => info.authorized).map(([socket]) => new Promise<void>(resolve => {
      if (socket.destroyed) { resolve(); return; }
      socket.write(JSON.stringify({ type: 'exit', detached }) + '\n', () => resolve());
    })));
    if (detached) return;
    closing = true; clearInterval(watchdog);
    await manager.dispose();
    await Promise.all([...clients.keys()].map(socket => new Promise<void>(resolve => { if (socket.destroyed) resolve(); else socket.end(resolve); })));
    server.close(); fs.rmSync(stateFile, { force: true }); process.exit(0);
  });
  manager.on('shutdown-error', () => { closing = false; unattendedAt = Date.now(); });
  const watchdog = setInterval(() => {
    for (const [socket, info] of clients) if (Date.now() - info.lastPing > 12_000) socket.destroy();
    if (ready && !closing && !clients.size && !manager.snapshot.detached && Date.now() - unattendedAt > 15_000) { closing = true; void manager.command('shutdown'); }
  }, 3000);
  const emergency = () => { if (!closing) { closing = true; void manager.command('shutdown'); } };
  process.on('SIGINT', emergency); process.on('SIGTERM', emergency);
  process.on('uncaughtException', error => { manager.log('launcher', String(error)); emergency(); });
  process.on('unhandledRejection', error => { manager.log('launcher', String(error)); emergency(); });
  try { await manager.initialize(); } catch (error) { manager.log('launcher', String(error)); manager.snapshot.error = manager.snapshot.logs.at(-1)?.text ?? '后台检测失败。'; manager.changed(true); }
  ready = true;
  for (const command of waiting) void manager.command(command);
}
