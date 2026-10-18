import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const { installRequestLogging } = createRequire(import.meta.url)('./request-logging.cjs') as {
  installRequestLogging(write?: (line: string) => void): () => void;
};

async function fixture(t: TestContext, handler: RequestListener, write?: (line: string) => void) {
  const lines: string[] = [];
  const uninstall = installRequestLogging(write ?? (line => lines.push(line)));
  const server = createServer(handler);
  t.after(async () => {
    uninstall(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, lines, uninstall };
}

test('production request logs preserve bodies and omit query parameters, headers and payloads', { timeout: 5000 }, async t => {
  const { url, lines } = await fixture(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    response.statusCode = 201; response.end(body);
  });
  const response = await fetch(url + '/api/readings?token=private-query', {
    method: 'POST', headers: { Authorization: 'Bearer private-header', Cookie: 'session=private-cookie' }, body: 'private-student-message',
  });
  assert.equal(response.status, 201); assert.equal(await response.text(), 'private-student-message');
  assert.equal(lines.length, 2); assert.equal(lines[0], 'POST /api/readings 开始');
  assert.match(lines[1], /^POST \/api\/readings 201 \d+ms$/);
  for (const secret of ['private-query', 'private-header', 'private-cookie', 'private-student-message']) assert.ok(!lines.join('\n').includes(secret));
});

test('streaming requests log their start immediately and complete once after the final chunk', { timeout: 5000 }, async t => {
  let finish!: () => void;
  const { url, lines } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write('{"first":true}\n'); finish = () => response.end('{"last":true}\n');
  });
  const response = await fetch(url + '/api/reading-sessions/1/turn', { method: 'POST' });
  const reader = response.body!.getReader(); const first = await reader.read();
  assert.deepEqual(lines, ['POST /api/reading-sessions/1/turn 开始']);
  finish(); let body = new TextDecoder().decode(first.value);
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value); }
  assert.equal(body, '{"first":true}\n{"last":true}\n');
  assert.equal(lines.length, 2); assert.match(lines[1], /^POST \/api\/reading-sessions\/1\/turn 200 \d+ms$/);
});

test('an interrupted stream is logged once without a successful completion', { timeout: 5000 }, async t => {
  let closed!: () => void; const close = new Promise<void>(resolve => { closed = resolve; });
  const { url, lines } = await fixture(t, (_request, response) => {
    response.once('close', closed); response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write('{"partial":true}\n');
  });
  const controller = new AbortController();
  const response = await fetch(url + '/api/book-sessions/1/turn', { method: 'POST', signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read(); controller.abort();
  await assert.rejects(reader.read()); await close;
  assert.equal(lines.length, 2); assert.match(lines[1], /^POST \/api\/book-sessions\/1\/turn 已中断 \d+ms$/);
});

test('successful health and static requests stay quiet while their failures remain visible', { timeout: 5000 }, async t => {
  const { url, lines } = await fixture(t, (request, response) => {
    response.statusCode = request.url!.includes('failed') ? 503 : request.url!.includes('missing') ? 404 : 200; response.end('unchanged');
  });
  for (const pathname of ['/api/health', '/_next/static/chunk.js', '/favicon.ico']) assert.equal(await (await fetch(url + pathname)).text(), 'unchanged');
  assert.deepEqual(lines, []);
  await (await fetch(url + '/api/health?failed=1')).text();
  await (await fetch(url + '/_next/static/missing.js')).text();
  assert.equal(lines.length, 2); assert.match(lines[0], /^GET \/api\/health 503 \d+ms$/); assert.match(lines[1], /^GET \/_next\/static\/missing.js 404 \d+ms$/);
});

test('a failed log writer does not fail an HTTP request', { timeout: 5000 }, async t => {
  const { url } = await fixture(t, (_request, response) => { response.statusCode = 202; response.end('accepted'); }, () => { throw new Error('Log storage is unavailable'); });
  const response = await fetch(url + '/readings'); assert.equal(response.status, 202); assert.equal(await response.text(), 'accepted');
});

test('unsubscribing stops request logging without changing HTTP behavior', { timeout: 5000 }, async t => {
  const { url, lines, uninstall } = await fixture(t, (_request, response) => response.end('unchanged'));
  await (await fetch(url + '/books')).text(); assert.equal(lines.length, 2);
  uninstall(); assert.equal(await (await fetch(url + '/readings')).text(), 'unchanged'); assert.equal(lines.length, 2);
});

for (const mode of ['start', 'dev']) test(`server child ${mode === 'start' ? 'installs production request logging before Next starts' : 'uses the existing development logger'} and retains IPC shutdown`, () => {
  const calls: string[] = []; let message!: (value: { type: string }) => void;
  const runtime = {
    execPath: process.execPath, argv: [process.execPath, 'server-child.cjs', mode, 'project'],
    on(event: string, listener: typeof message) { assert.equal(event, 'message'); message = listener; },
    emit(event: string, signal: string) { assert.equal(event, 'SIGINT'); assert.equal(signal, 'SIGINT'); calls.push('stop'); },
  };
  const require = Object.assign((name: string) => {
    calls.push(name); return { installRequestLogging: () => calls.push('install') };
  }, { resolve: (name: string) => 'resolved:' + name });
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/launcher/server-child.cjs'), 'utf8'), { process: runtime, require });
  assert.deepEqual(calls, mode === 'start' ? ['./request-logging.cjs', 'install', 'next/dist/bin/next'] : ['next/dist/bin/next']);
  assert.deepEqual(Array.from(runtime.argv), [process.execPath, 'resolved:next/dist/bin/next', mode, 'project']);
  message({ type: 'stop' }); assert.equal(calls.at(-1), 'stop');
});
