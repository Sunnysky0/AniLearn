type RunDocker = (args: string[], timeout: number, signal: AbortSignal) => Promise<string>;
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  signal.addEventListener('abort', cancel, { once: true });
});
export async function ensureDocker(run: RunDocker, phase: (text: string) => void, signal: AbortSignal, delay = wait, report: (text: string) => void = phase) {
  const until = Date.now() + 120_000;
  const remaining = (maximum: number) => Math.max(1, Math.min(maximum, until - Date.now()));
  const checkFailure = (error: unknown) => {
    signal.throwIfAborted();
    if (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) throw error;
  };
  const requireLinux = (kind: string) => {
    if (kind !== 'linux') throw new Error('Docker 需要使用 Linux 容器。请切换引擎后重试。');
  };
  let kind: string | undefined;
  signal.throwIfAborted();
  try { kind = await run(['info', '--format', '{{.OSType}}'], remaining(5000), signal); }
  catch (error) { checkFailure(error); }
  signal.throwIfAborted();
  if (kind !== undefined) { requireLinux(kind); return; }
  phase('启动 Docker Desktop');
  try { await run(['desktop', 'start', '--detach'], remaining(20_000), signal); }
  catch (error) {
    checkFailure(error);
    report(error instanceof Error ? error.message : 'Docker Desktop 启动请求未确认。');
  }
  phase('等待 Docker Linux 引擎就绪');
  // A CLI timeout does not imply that the independently started engine failed.
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= until) throw new Error('Docker Desktop 启动超时（已等待 120 秒）。请检查 Linux 容器引擎后重试。');
    kind = undefined;
    try { kind = await run(['info', '--format', '{{.OSType}}'], remaining(5000), signal); }
    catch (error) { checkFailure(error); }
    signal.throwIfAborted();
    if (kind !== undefined) { requireLinux(kind); return; }
    await delay(remaining(2000), signal);
  }
}
