const { channel } = require('node:diagnostics_channel');
const { performance } = require('node:perf_hooks');

function installRequestLogging(write = line => console.log(line)) {
  const requests = channel('http.server.request.start');
  const log = line => {
    try { write(line); } catch { /* Logging must not fail an application request. */ }
  };
  const onRequest = ({ request, response }) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://anilearn.local').pathname; }
    catch { pathname = '/[无效路径]'; }
    const label = `${request.method} ${pathname.slice(0, 300)}`;
    const quiet = pathname === '/api/health' || pathname === '/favicon.ico' || pathname.startsWith('/_next/');
    const started = performance.now();
    if (!quiet) log(`${label} 开始`);
    const complete = () => {
      response.off('finish', complete);
      response.off('close', complete);
      const interrupted = !response.writableFinished;
      if (!quiet || interrupted || response.statusCode >= 400) {
        log(`${label} ${interrupted ? '已中断' : response.statusCode} ${Math.round(performance.now() - started)}ms`);
      }
    };
    response.once('finish', complete);
    response.once('close', complete);
  };
  requests.subscribe(onRequest);
  return () => requests.unsubscribe(onRequest);
}

module.exports = { installRequestLogging };
