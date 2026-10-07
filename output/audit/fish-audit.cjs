const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { ProxyAgent } = require('undici');

const loaded = new Map();
const agents = [];
class ObservedProxyAgent extends ProxyAgent {
  constructor(options) { super(options); this.options = options; agents.push(this); }
  destroy(...args) { this.wasDestroyed = true; return super.destroy(...args); }
}
let stored;
let saves = 0;
const db = {
  select: () => ({ from: () => ({ where: async () => stored ? [{ data: structuredClone(stored) }] : [] }) }),
  insert: () => ({ values: (row) => ({ onConflictDoUpdate: async () => { stored = structuredClone(row.data); saves++; } }) }),
};
function load(file) {
  const filename = path.resolve(file);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const mod = new Module(filename, module);
  loaded.set(filename, mod);
  mod.filename = filename;
  mod.paths = module.paths;
  const original = mod.require.bind(mod);
  mod.require = id => {
    if (id === '@/db') return { db };
    if (id === '@/db/schema') return { appSettings: { id: 1 } };
    if (id === 'undici') return { ProxyAgent: ObservedProxyAgent };
    if (id.startsWith('@/')) return load('src/' + id.slice(2) + '.ts');
    if (id.startsWith('.') && fs.existsSync(path.resolve(path.dirname(filename), id + '.ts')))
      return load(path.resolve(path.dirname(filename), id + '.ts'));
    return original(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return mod.exports;
}
const fish = load('src/lib/server/fish.ts');
const settings = load('src/lib/server/settings.ts');
const settingsRoute = load('src/app/api/settings/route.ts');
const tts = load('src/app/api/tts/route.ts');
const voices = load('src/app/api/voices/route.ts');
const report = [];
const config = { key: 'fish-audit-secret-key', proxyUrl: '' };
const authenticatedProxy = 'http://proxy-user:proxy-password@127.0.0.1:18081';
function request(body) {
  return new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function run() {
  assert.equal(fish.normalizeFishProxy(''), '');
  assert.equal(fish.normalizeFishProxy(' https://proxy.example:443 '), 'https://proxy.example/');
  for (const input of ['localhost:18081', 'socks5://localhost:1080', 'http://proxy/path', 'http://proxy?q=1', 'http://proxy#fragment', 'http://bad%xx:pass@proxy'])
    assert.throws(() => fish.normalizeFishProxy(input), /HTTP\/HTTPS/);
  assert.equal(fish.fishProxyPreview(authenticatedProxy), 'http://***@127.0.0.1:18081');
  assert.equal(fish.fishProxyPreview('broken-password'), '已配置');
  report.push({ test: 'proxy scheme, authority validation and credential masking', outcome: 'pass' });

  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.fish.audio/model');
    assert.equal(options.headers.get('Authorization'), 'Bearer ' + config.key);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.dispatcher, undefined);
    return Response.json({ ok: true });
  };
  assert.deepEqual(await fish.fishRequest('/model', config, {}, r => r.json()), { ok: true });
  global.fetch = async (_, options) => {
    assert.ok(options.dispatcher instanceof ProxyAgent);
    assert.equal(options.dispatcher.options.uri, 'http://127.0.0.1:18081/');
    assert.equal(options.dispatcher.options.token, 'Basic ' + Buffer.from('proxy-user:proxy-password').toString('base64'));
    return Response.json({ ok: true });
  };
  await fish.fishRequest('/model', { ...config, proxyUrl: authenticatedProxy }, {}, async r => {
    assert.equal(agents.at(-1).wasDestroyed, undefined);
    return r.json();
  });
  assert.equal(agents.at(-1).wasDestroyed, true);
  report.push({ test: 'direct requests, authenticated per-request proxy and body lifetime', outcome: 'pass' });

  for (const [status, hint] of [[400, '参数'], [401, '密钥'], [402, '余额'], [403, '无权'], [404, '不存在'], [407, '代理认证'], [429, '并发'], [503, '暂时不可用']]) {
    global.fetch = async () => Response.json({ message: `${config.key} ${authenticatedProxy} proxy-password` }, { status });
    try { await fish.fishRequest('/model', { ...config, proxyUrl: authenticatedProxy }, {}, r => r.json()); assert.fail(); }
    catch (e) {
      const response = fish.fishErrorResponse(e);
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.equal(body.upstreamStatus, status);
      assert.ok(body.error.includes(hint));
      for (const secret of [config.key, authenticatedProxy, 'proxy-password']) assert.ok(!JSON.stringify(body).includes(secret));
    }
    assert.equal(agents.at(-1).wasDestroyed, true);
  }
  global.fetch = async () => new Response('<html>private-edge-body</html>', { status: 503 });
  await assert.rejects(fish.fishRequest('/model', config, {}, r => r.json()), e => !e.message.includes('private-edge-body'));
  report.push({ test: 'Fish HTTP errors and non-JSON gateways return safe Chinese hints', outcome: 'pass' });

  for (const [code, result, status] of [['UND_ERR_CONNECT_TIMEOUT', 'FISH_CONNECT_TIMEOUT', 504], ['ENOTFOUND', 'FISH_DNS_ERROR', 502], ['EAI_AGAIN', 'FISH_DNS_ERROR', 502], ['ECONNREFUSED', 'FISH_CONNECTION_REFUSED', 502], ['CERT_HAS_EXPIRED', 'FISH_TLS_ERROR', 502], ['ECONNRESET', 'FISH_NETWORK_ERROR', 502]]) {
    global.fetch = async () => { throw new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('secret-details'), { code })]) }); };
    try { await fish.fishRequest('/model', { ...config, proxyUrl: authenticatedProxy }, {}, r => r.json()); assert.fail(); }
    catch (e) {
      const response = fish.fishErrorResponse(e);
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(body.code, result);
      assert.ok(!body.error.includes('secret-details'));
    }
    assert.equal(agents.at(-1).wasDestroyed, true);
  }
  global.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(fish.fishRequest('/model', config, {}, r => r.json()), e => e.code === 'FISH_TIMEOUT');
  global.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('Proxy response (407) !== 200 when HTTP Tunneling'), { name: 'AbortError', code: 'UND_ERR_ABORTED' }) }); };
  await assert.rejects(fish.fishRequest('/model', { ...config, proxyUrl: authenticatedProxy }, {}, r => r.json()), e => e.code === 'FISH_PROXY_AUTH');
  global.fetch = async () => new Response('audio');
  await assert.rejects(fish.fishRequest('/v1/tts', { ...config, proxyUrl: authenticatedProxy }, {}, async () => { throw new DOMException('timeout', 'TimeoutError'); }), e => e.code === 'FISH_TIMEOUT');
  assert.equal(agents.at(-1).wasDestroyed, true);
  const controller = new AbortController();
  controller.abort();
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fish.fishRequest('/model', config, { signal: controller.signal }, r => r.json()), e => e.code === 'FISH_CANCELLED');
  report.push({ test: 'nested network causes, response-body timeout and cancellation release dispatchers', outcome: 'pass' });

  stored = settings.defaultSettings();
  stored.fish.apiKey = config.key;
  let response = await settingsRoute.PUT(request({ fish: { proxyUrl: authenticatedProxy } }));
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.fish.hasProxy, true);
  assert.ok(!JSON.stringify(body).includes('proxy-password'));
  assert.equal(body.fish.proxyUrl, undefined);
  assert.equal(body.fish.apiKey, undefined);
  await settingsRoute.PUT(request({ fish: { model: 's2.1-pro' } }));
  assert.equal(stored.fish.proxyUrl, fish.normalizeFishProxy(authenticatedProxy));
  const savedCount = saves;
  for (const proxyUrl of ['socks://proxy', 17, 'http://proxy/path']) {
    response = await settingsRoute.PUT(request({ fish: { proxyUrl } }));
    assert.equal(response.status, 400);
  }
  assert.equal(saves, savedCount);
  for (const invalid of [null, [], { fish: 'invalid' }, { fish: null }])
    assert.equal((await settingsRoute.PUT(request(invalid))).status, 400);
  await settingsRoute.PUT(request({ fish: { proxyUrl: null } }));
  assert.equal(stored.fish.proxyUrl, '');
  body = await (await settingsRoute.GET()).json();
  assert.equal(body.fish.hasProxy, false);
  delete stored.fish.proxyUrl;
  assert.equal((await settings.getSettings()).fish.proxyUrl, '');
  report.push({ test: 'settings save, preserve, reject, clear and legacy defaults without exposing secrets', outcome: 'pass' });

  calls = 0;
  stored.fish.proxyUrl = '';
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('model'), 's2.1-pro');
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.headers.get('Authorization'), 'Bearer ' + stored.fish.apiKey);
    const body = JSON.parse(options.body);
    assert.equal(body.format, 'mp3');
    assert.equal(body.reference_id, 'audit-voice');
    assert.equal(body.fresh, undefined);
    return new Response('mock-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const sample = { text: 'こんにちは。一緒に考えましょう。', voiceId: 'audit-voice' };
  assert.equal((await tts.POST(request(sample))).status, 200);
  assert.equal((await tts.POST(request(sample))).headers.get('X-TTS-Cache'), 'hit');
  assert.equal(calls, 1);
  assert.equal((await tts.POST(request({ ...sample, fresh: true }))).status, 200);
  assert.equal(calls, 2);
  stored.fish.apiKey = 'another-fish-audit-key';
  await tts.POST(request(sample));
  assert.equal(calls, 3);
  stored.fish.proxyUrl = 'http://localhost:18081';
  await tts.POST(request(sample));
  assert.equal(calls, 4);
  const beforeInvalid = calls;
  assert.equal((await tts.POST(request({ text: '中文不得播放。' }))).status, 400);
  assert.equal(calls, beforeInvalid);
  global.fetch = async () => Response.json({ message: 'Insufficient credits' }, { status: 402 });
  response = await tts.POST(request({ ...sample, fresh: true }));
  assert.equal((await response.json()).code, 'FISH_HTTP_402');
  global.fetch = async () => new Response('');
  assert.equal((await tts.POST(request({ ...sample, fresh: true }))).status, 502);
  global.fetch = async () => Response.json({ message: 'not audio' });
  assert.equal((await (await tts.POST(request({ ...sample, fresh: true }))).json()).code, 'FISH_INVALID_RESPONSE');
  assert.equal((await tts.POST(request(null))).status, 400);
  report.push({ test: 'TTS protocol, fresh synthesis, config-separated cache and language guard', outcome: 'pass' });

  global.fetch = async (url, options) => {
    assert.ok(options.dispatcher instanceof ProxyAgent);
    const params = new URL(url).searchParams;
    assert.equal(params.get('language'), 'ja');
    assert.equal(params.get('title'), 'test');
    assert.equal(params.get('self'), 'true');
    assert.ok(options.signal);
    return Response.json({ total: 1, items: [{ _id: 'voice', title: '声线', languages: ['ja'] }], has_more: true });
  };
  body = await (await voices.GET(new Request('http://localhost/api/voices?q=test&mine=1'))).json();
  assert.equal(body.items[0].id, 'voice');
  assert.equal(body.hasMore, true);
  assert.equal(agents.at(-1).wasDestroyed, true);
  report.push({ test: 'voice search shares proxy, timeout and existing DTO mapping', outcome: 'pass' });
  fs.writeFileSync('output/audit/fix-fish-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
const originalFetch = global.fetch;
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
