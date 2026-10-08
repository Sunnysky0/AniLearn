import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { Dashboard } from './ui';
import type { Connection } from './ipc';
import type { Snapshot } from './types';

const pause = () => new Promise(resolve => setTimeout(resolve, 180));
const snapshot: Snapshot = {
  mode: 'production', port: 3000, app: 'running', database: 'running', docker: 'running', startedAt: Date.now() - 300_000, phase: 'AniLearn 已就绪', phaseAt: Date.now(), busy: false, error: null, detached: false,
  logs: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, time: Date.now(), source: i % 3 === 0 ? 'launcher' : i % 3 === 1 ? 'app' : 'database', level: i % 13 === 0 ? 'error' : 'info', text: i % 13 === 0 ? `连接失败：第 ${i} 条测试日志` : `第 ${i} 条日志 · 中文文本和 $x+1=2$ · 服务运行正常` })),
  samples: Array.from({ length: 60 }, (_, i) => ({ time: Date.now() - (60 - i) * 2000, appCpu: 15 + Math.sin(i / 4) * 12, appMemory: 512_000_000, dbCpu: 2 + Math.cos(i / 5), dbMemory: 42_000_000, rx: 1000 + Math.sin(i) * 500, tx: 512 })),
  stats: { size: 123_000_000, connections: 5, papers: { uploaded: 2, analyzing: 1, ready: 12, failed: 1 }, sessions: { active: 3, completed: 7 }, counts: { tutors: 4, problems: 138, messages: 1245, boards: 72 } },
  processes: [{ pid: 1100, parentPid: 1000, memory: 340_000_000 }, { pid: 1101, parentPid: 1100, memory: 172_000_000 }],
};
test('large, regular and narrow terminal layouts fit and keyboard controls work', async () => {
  const emitter = new EventEmitter() as Connection;
  emitter.snapshot = snapshot;
  const commands: string[] = [];
  emitter.command = command => { commands.push(command); };
  const view = render(<Dashboard connection={emitter} />);
  try {
    const resize = async (columns: number, rows: number) => {
      Object.defineProperty(view.stdout, 'columns', { configurable: true, value: columns });
      Object.defineProperty(view.stdout, 'rows', { configurable: true, value: rows });
      view.stdout.emit('resize'); await pause();
      const frame = view.lastFrame()!;
      assert.ok(frame.split('\n').length <= rows, `${columns}x${rows} height overflow`);
      for (const line of frame.split('\n')) assert.ok(stringWidth(line) <= columns, `${columns}x${rows} width overflow`);
      fs.mkdirSync(path.join(process.cwd(), '.anilearn/visual-qa'), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), `.anilearn/visual-qa/${columns}x${rows}.txt`), frame);
      return frame;
    };
    await pause();
    for (const [columns, rows] of [[160, 50], [120, 36], [80, 24], [50, 18]]) {
      const frame = await resize(columns, rows);
      assert.ok(frame.includes('实时日志')); assert.ok(frame.includes('AniLearn 已就绪'));
      if (columns >= 110) { assert.ok(frame.includes('后台统计')); assert.ok(frame.includes('导师 / 题目')); }
    }
    const send = async (input: string) => { view.stdin.write(input); await pause(); };
    await resize(80, 24);
    await send('\t'); assert.ok(view.lastFrame()!.includes('资源'));
    await send('v'); assert.ok(view.lastFrame()!.includes('应用内存'));
    await send('n'); assert.ok(view.lastFrame()!.includes('数据库容器'));
    await send('\t'); assert.ok(view.lastFrame()!.includes('数据库大小'));
    await send('\t'); await send('2'); assert.ok(!view.lastFrame()!.includes('[数据库]'));
    await send(' '); assert.ok(view.lastFrame()!.includes('已暂停'));
    await send('\x1b[A'); await send('\x1b[F'); assert.ok(view.lastFrame()!.includes('实时跟随'));
    await send('/'); await send('失败'); await send('\r'); assert.ok(view.lastFrame()!.includes('搜索 · 失败'));
    await send('e'); assert.ok(view.lastFrame()!.includes('仅错误'));
    await send('h'); assert.ok(view.lastFrame()!.includes('启动全部服务')); await send('\x1b');
    await send('d'); assert.ok(view.lastFrame()!.includes('保留 AniLearn')); await send('n'); assert.ok(!commands.includes('detach'));
    await send('d'); await send('y'); assert.ok(commands.includes('detach'));
    await send('q'); assert.ok(commands.includes('shutdown'));
  } finally { view.unmount(); view.cleanup(); }
});
