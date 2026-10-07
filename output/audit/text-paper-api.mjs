import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3107';
const report = [];
const markdown = '# 文本试卷\n\n1. 解方程 $x+1=2$。\n\n<!-- MD_SOURCE_MARKER -->';
const latex = '\\documentclass{ctexart}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n2. 解方程 $x+2=4$，其中 $x\\in\\R$。\n% TEX_SOURCE_MARKER\n\\end{document}';
const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
const pass = (test) => { report.push({ test, outcome: 'pass' }); console.log('PASS', test); };

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  const value = res.headers.get('content-type')?.includes('ndjson') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(raw);
  return { status: res.status, value };
}
async function create() {
  const result = await api('/api/papers', 'POST', { title: '文本试卷回归', subject: '数学' });
  assert.equal(result.status, 200);
  return result.value.id;
}
async function model(name) {
  const result = await api('/api/settings', 'PUT', { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', analysisModel: name, chatModel: 'audit-teach' } }, fish: { enabled: false } });
  assert.equal(result.status, 200);
}
async function requests() { return (await fetch('http://127.0.0.1:4107/requests')).json(); }
async function upload(id, mime, text) {
  assert.equal((await api(`/api/papers/${id}/pages`, 'POST', { dataUrl: dataUrl(mime, text) })).status, 200);
}
const textOf = (request) => JSON.stringify(request.messages.filter((m) => m.role === 'user').map((m) => m.content));
const done = (result) => result.value.some((e) => e.type === 'done');

const id = await create();
await upload(id, 'text/markdown', markdown);
await upload(id, 'text/x-tex', latex);
const source = await fetch(`${base}/api/papers/${id}/pages/1`);
assert.equal(await source.text(), latex);
assert.match(source.headers.get('content-type'), /^text\/x-tex; charset=utf-8$/);
assert.deepEqual((await api(`/api/papers/${id}`)).value.paper.pageMimes, ['text/markdown', 'text/x-tex']);
assert.deepEqual((await api('/api/papers')).value.find((p) => p.id === id).pageMimes, ['text/markdown', 'text/x-tex']);
pass('UTF-8 Chinese, formulas and macros stored losslessly; MIME metadata returned');

await model('audit-source-incomplete');
assert.equal(done(await api(`/api/papers/${id}/analyze`, 'POST', {})), false);
assert.equal((await api(`/api/papers/${id}`)).value.paper.status, 'failed');
await model('audit-source');
const before = (await requests()).length;
assert.equal(done(await api(`/api/papers/${id}/analyze`, 'POST', {})), true);
const resumed = (await requests()).slice(before);
assert.equal(resumed.length, 1);
assert.ok(textOf(resumed[0]).includes('TEX_SOURCE_MARKER'));
assert.ok(!textOf(resumed[0]).includes('MD_SOURCE_MARKER'));
const published = (await api(`/api/papers/${id}`)).value;
assert.deepEqual(published.problems.map((p) => p.page), [1, 2]);
pass('failed text analysis resumes only unfinished problem with the correct source page');

const mixed = await create();
await upload(mixed, 'text/markdown', markdown);
await upload(mixed, 'application/x-tex', latex);
const image = fs.readFileSync('public/avatars/darjeeling.png');
assert.equal((await api(`/api/papers/${mixed}/pages`, 'POST', { dataUrl: dataUrl('image/png', image) })).status, 200);
await model('audit-source-cross');
const start = (await requests()).length;
assert.equal(done(await api(`/api/papers/${mixed}/analyze`, 'POST', {})), true);
const calls = (await requests()).slice(start);
assert.equal(calls.length, 3);
for (const call of calls.slice(0, 2)) {
  assert.ok(textOf(call).includes('MD_SOURCE_MARKER'));
  assert.ok(textOf(call).includes('TEX_SOURCE_MARKER'));
  assert.equal(call.messages.at(-1).content.filter((p) => p === '[image omitted]').length, 1);
}
assert.ok(!textOf(calls[2]).includes('MD_SOURCE_MARKER'));
assert.ok(!textOf(calls[2]).includes('TEX_SOURCE_MARKER'));
pass('mixed sources and cross-page ranges send original text and only real image parts');

const validation = await create();
for (const value of [dataUrl('text/markdown', '  \n'), dataUrl('text/x-tex', Buffer.from([0xff, 0xfe])), 'data:text/markdown;base64,not-valid!!!', dataUrl('text/markdown', '\u0000binary'), dataUrl('text/html', '<script>bad</script>'), 42]) {
  assert.equal((await api(`/api/papers/${validation}/pages`, 'POST', { dataUrl: value })).status, 400);
}
assert.equal((await api(`/api/papers/${validation}/pages`, 'POST', { dataUrl: dataUrl('text/markdown', 'x'.repeat(1_500_001)) })).status, 413);
assert.equal((await api(`/api/papers/${validation}`)).value.paper.pageCount, 0);
await upload(validation, 'text/markdown', '\ufeff# BOM_UTF8 试卷');
for (let i = 1; i < 12; i++) await upload(validation, 'text/x-tex', '$x=1$');
assert.equal((await api(`/api/papers/${validation}/pages`, 'POST', { dataUrl: dataUrl('text/markdown', markdown) })).status, 400);
assert.equal((await api(`/api/papers/${id}/pages`, 'POST', { dataUrl: dataUrl('text/markdown', markdown) })).status, 409);
pass('empty, non-UTF-8, invalid, oversized and unsupported content rejected; page cap and published locks preserved');

const tutorId = (await api('/api/tutors')).value[0].id;
const session = await api('/api/sessions', 'POST', { paperId: id, tutorId });
assert.equal(session.status, 200);
const turn = await api(`/api/sessions/${session.value.id}/turn`, 'POST', {});
assert.ok(done(turn));
assert.ok(turn.value.some((e) => e.type === 'board'));
pass('text-source paper creates a classroom and streams chat/board normally');
fs.writeFileSync('output/audit/text-paper-api-results.json', JSON.stringify(report, null, 2));
