const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const assert = require('node:assert/strict');
const path = require('node:path');
function load(file) {
  const filename = path.resolve(file);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  const requireOriginal = mod.require.bind(mod);
  mod.require = id => id.startsWith('.') && fs.existsSync(path.resolve(path.dirname(filename), id + '.ts'))
    ? load(path.resolve(path.dirname(filename), id + '.ts')) : requireOriginal(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, filename);
  return mod.exports;
}
const llm = load('src/lib/server/llm.ts');
const protocol = load('src/lib/server/protocol.ts');
const text = load('src/lib/text.ts');
const analysis = load('src/lib/server/analysis.ts');
const report = [];
(async () => {
  const previous = global.fetch;
  const example = '<msg><zh>公式 $x^2+1$。</zh><ja>エックスの二乗プラス一。</ja></msg>';
  for (const provider of ['openai', 'xai', 'anthropic', 'gemini']) {
    let request;
    let ending = 'normal';
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      request = { url, body, headers: opts.headers };
      let payload = [...example].map(ch => {
        if (provider === 'anthropic') return 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ch } }) + '\n\n';
        if (provider === 'gemini') return 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: ch }] } }] }) + '\n\n';
        return 'data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n';
      }).join('');
      if (ending !== 'missing') {
        if (provider === 'anthropic') payload += 'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: ending === 'truncated' ? 'max_tokens' : 'end_turn' } }) + '\n\ndata: {"type":"message_stop"}\n\n';
        else if (provider === 'gemini') payload += 'data: ' + JSON.stringify({ candidates: [{ finishReason: ending === 'truncated' ? 'MAX_TOKENS' : 'STOP' }] }) + '\n\n';
        else payload += 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: ending === 'truncated' ? 'length' : 'stop' }] }) + '\n\ndata: [DONE]\n\n';
      }
      const bytes = new TextEncoder().encode(payload);
      let index = 0;
      return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(index, index += 5)); } }), { status: 200 });
    };
    const output = await llm.complete({ provider, model: 'audit-model', apiKey: 'dummy' }, { system: '中文教学', messages: [{ role: 'user', content: [{ type: 'text', text: '题目' }, { type: 'image', mime: 'image/png', data: 'dummy-image' }] }], maxTokens: 32000 });
    assert.equal(output, example);
    report.push({ test: provider + ' streaming text + image request with split UTF-8 packets', outcome: 'pass', url: request.url, outputBudget: request.body.max_tokens ?? request.body.generationConfig?.maxOutputTokens ?? null });
    ending = 'truncated';
    await assert.rejects(llm.complete({ provider, model: 'audit-model', apiKey: 'dummy' }, { system: '', messages: [] }), /长度上限/);
    ending = 'missing';
    await assert.rejects(llm.complete({ provider, model: 'audit-model', apiKey: 'dummy' }, { system: '', messages: [] }), /提前断开/);
    report.push({ test: provider + ' truncation and premature EOF rejected', outcome: 'pass' });
    if (provider === 'openai') {
      ending = 'normal';
      await llm.complete({ provider, model: 'gpt-5', apiKey: 'dummy' }, { system: '', messages: [], maxTokens: 16000 });
      assert.equal(request.body.max_completion_tokens, 16000);
      assert.equal(request.body.max_tokens, undefined);
      report.push({ test: 'reasoning model completion budget', outcome: 'pass' });
    }
  }
  global.fetch = previous;
  const sample = '<msg><zh>计算 $x^2$。</zh><ja>エックスの二乗。</ja></msg><board mode="append" title="重点">$$x=1$$</board><action>wait</action>';
  for (let size = 1; size < 50; size++) {
    const parser = protocol.createTagParser(['msg', 'board', 'action']);
    const blocks = [];
    for (let i = 0; i < sample.length; i += size) blocks.push(...parser.push(sample.slice(i, i + size)));
    blocks.push(...parser.end());
    assert.deepEqual(blocks.map(b => b.tag), ['msg', 'board', 'action']);
    assert.equal(protocol.innerTag(blocks[0].body, 'zh'), '计算 $x^2$。');
  }
  report.push({ test: 'incremental tags at 49 different packet boundaries', outcome: 'pass' });
  const truncatedParser = protocol.createTagParser(['msg']);
  truncatedParser.push('<msg><zh>未完成');
  assert.equal(truncatedParser.end()[0].closed, false);
  const inventory = '<inventory count="1" pages="1"><overview>整体分析</overview><item number="1" page="1" endpage="1">题干</item></inventory>';
  assert.equal(analysis.parseInventory(inventory, 1).items.length, 1);
  assert.throws(() => analysis.parseInventory(inventory.replace('count="1"', 'count="2"'), 1));
  assert.throws(() => analysis.parseInventory(inventory.replace('</inventory>', ''), 1));
  assert.throws(() => analysis.parseInventory(inventory.replace('endpage="1"', 'endpage="3"'), 1));
  assert.throws(() => analysis.parseInventory(inventory, 2));
  report.push({ test: 'unclosed tags, directory counts and page ranges validated', outcome: 'pass' });
  const atomic = ['$$x^2+1$$', '$x^2$', '**重点**', '[链接](https://example.com)', '\\(x+1\\)'];
  const source = '你好' + atomic.join('，') + '。';
  const tokens = text.tokenizeForReveal(source);
  assert.equal(tokens.join(''), source);
  for (const a of atomic) assert.ok(tokens.includes(a));
  report.push({ test: 'LaTeX, bold and links reveal atomically', outcome: 'pass' });
  const short = text.splitShortMessages(('中文说明 $x^2+1$。**核心知识**。').repeat(20));
  assert.ok(short.length > 1);
  assert.equal(short.join(''), ('中文说明 $x^2+1$。**核心知识**。').repeat(20));
  assert.ok(short.every(s => (s.match(/\$/g)?.length ?? 0) % 2 === 0));
  assert.ok(text.isJapaneseSpeech('[穏やかに] 例を与えて、一緒に考えましょう。'));
  assert.ok(!text.isJapaneseSpeech('这是中文语音。'));
  assert.ok(!text.isJapaneseSpeech('日本語ですが $x^2$。'));
  report.push({ test: 'short splitting preserves atomic formulas; Japanese validation accepts 与える', outcome: 'pass' });
  fs.writeFileSync('output/audit/fix-provider-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
