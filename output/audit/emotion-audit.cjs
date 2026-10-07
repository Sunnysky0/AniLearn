const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const assert = require('node:assert/strict');

const loaded = new Map();
const repairs = [];
let repairSpeech = '一緒に考えましょう。';
let repairFails = false;
const llm = {
  complete: async (_, input) => {
    repairs.push(input);
    if (repairFails) throw new Error('Mock repair failure');
    return [...input.messages[0].content.matchAll(/<zh>([\s\S]*?)<\/zh>/g)]
      .map((m) => `<msg><zh>${m[1]}</zh><ja>${repairSpeech}</ja></msg>`).join('');
  },
};
function load(file) {
  const filename = path.resolve(file);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const mod = new Module(filename, module);
  loaded.set(filename, mod);
  mod.filename = filename;
  mod.paths = module.paths;
  const original = mod.require.bind(mod);
  mod.require = (id) => {
    if (id === './llm') return llm;
    if (id === '@/lib/server/settings') return {
      getSettings: async () => ({ fish: { model: 's2.1-pro', proxyUrl: '' } }),
      resolveFishKey: () => ({ key: 'emotion-audit-dummy-key' }),
    };
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

const text = load('src/lib/text.ts');
const tutor = load('src/lib/server/tutor-output.ts');
const tts = load('src/app/api/tts/route.ts');
const report = [];
const pass = (test) => report.push({ test, outcome: 'pass' });
const style = '[優雅で落ち着いた丁寧な口調]';
const sample = '[confident] ここで [emphasis] 両辺から一を引きます。[break] 答えが分かります。';
const cfg = { provider: 'openai', model: 'emotion-audit', apiKey: 'dummy' };
const signal = new AbortController().signal;
const request = (speech) => new Request('http://localhost/api/tts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: speech, voiceId: 'audit-voice', fresh: true }),
});

async function run() {
  for (const speech of [sample, style + ' 一緒に考えましょう。', '[warm and happy][soft tone] よくできました！', 'こんにちは。'])
    assert.ok(text.isJapaneseSpeech(speech), speech);
  for (const speech of ['[happy', '[happy] 这是中文。', '[happy]', '[ ] こんにちは。', '[] こんにちは。', '[[happy]] こんにちは。', '[happy\ncalm] こんにちは。', '[happy] こんにちは。$x^2$'])
    assert.ok(!text.isJapaneseSpeech(speech), speech);
  pass('S2 free-form English/Japanese cues and inline controls accepted; malformed cues and invalid spoken text rejected');

  let messages = await tutor.prepareTutorMessages(cfg, '先一起看条件。', sample, signal, style);
  assert.equal(messages[0].ja, sample);
  assert.equal(repairs.length, 0);
  messages = await tutor.prepareTutorMessages(cfg, '先一起看条件。', '一緒に考えましょう。', signal, style);
  assert.equal(messages[0].ja, style + ' 一緒に考えましょう。');
  messages = await tutor.prepareTutorMessages(cfg, '先一起看条件。', '一緒に考えましょう。', signal);
  assert.ok(messages[0].ja.startsWith('[calm] '));
  assert.equal(text.withSpeechStyle('', style), '');
  assert.equal(text.speechStyleTag('優しく穏やかな口調'), '[優しく穏やかな口調]');
  assert.equal(text.speechStyleTag('[ ]'), '[calm]');
  pass('existing sentence and inline cues preserved; missing leading cue gets tutor style or calm without an extra LLM request');

  const long = '根据等式性质，我们把两边同时减去一，再检查计算过程。'.repeat(10);
  repairSpeech = '[proud] よくできました。[break] 続けましょう。';
  messages = await tutor.prepareTutorMessages(cfg, long, sample, signal, style);
  assert.ok(messages.length > 1);
  assert.equal(messages.map((m) => m.zh).join(''), text.splitShortMessages(long).join(''));
  assert.ok(messages.every((m) => m.ja === repairSpeech));
  assert.ok(repairs.at(-1).system.includes(style));
  assert.ok(repairs.at(-1).system.includes('[emphasis]'));
  assert.ok(repairs.at(-1).messages[0].content.includes(`<original_speech>${sample}</original_speech>`));
  repairSpeech = '一緒に確認しましょう。';
  messages = await tutor.prepareTutorMessages(cfg, long, sample, signal, style);
  assert.ok(messages.every((m) => m.ja.startsWith(style)));
  repairFails = true;
  messages = await tutor.prepareTutorMessages(cfg, long, sample, signal, style);
  assert.ok(messages.every((m) => m.ja === ''));
  assert.equal(messages.map((m) => m.zh).join(''), text.splitShortMessages(long).join(''));
  pass('repair receives original cues and tutor style; repaired bubbles get leading cues; failure keeps Chinese with empty speech');

  const upstream = [];
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.headers.get('model'), 's2.1-pro');
    assert.equal(options.headers.get('Authorization'), 'Bearer emotion-audit-dummy-key');
    const body = JSON.parse(options.body);
    upstream.push(body);
    assert.deepEqual(Object.keys(body).sort(), ['format', 'reference_id', 'text']);
    assert.equal(body.reference_id, 'audit-voice');
    assert.equal(body.format, 'mp3');
    return new Response('mock-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  assert.equal((await tts.POST(request(sample))).status, 200);
  assert.equal(upstream[0].text, sample);
  assert.equal((await tts.POST(request('[ ] こんにちは。'))).status, 400);
  assert.equal(upstream.length, 1);
  assert.equal((await tts.POST(request('こんにちは。'))).status, 200);
  assert.equal(upstream[1].text, 'こんにちは。');
  pass('Fish request retains all cue positions and protocol fields; malformed cues blocked before network; direct untagged Japanese remains valid');
  fs.writeFileSync('output/audit/fix-emotion-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
const originalFetch = global.fetch;
run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
