type RunDocker = (args: string[], timeout: number, signal: AbortSignal) => Promise<string>;
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  signal.addEventListener('abort', cancel, { once: true });
});
export async function ensureDocker(run: RunDocker, phase: (text: string) => void, signal: AbortSignal, delay = wait) {
  let kind: string;
  try { kind = await run(['info', '--format', '{{.OSType}}'], 5000, signal); }
  catch {
    signal.throwIfAborted(); phase('启动 Docker Desktop');
    await run(['desktop', 'start', '--detach'], 20_000, signal);
    const until = Date.now() + 120_000;
    for (;;) {
      signal.throwIfAborted();
      try { kind = await run(['info', '--format', '{{.OSType}}'], 5000, signal); break; }
      catch { signal.throwIfAborted(); if (Date.now() > until) throw new Error('Docker Desktop 启动超时。请检查 Linux 容器引擎后重试。'); await delay(2000, signal); }
    }
  }
  if (kind !== 'linux') throw new Error('Docker 需要使用 Linux 容器。请切换引擎后重试。');
}
