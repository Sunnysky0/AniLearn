import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3107';
const report = [];
async function api(url, method = 'GET', body) {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let value;
  try { value = JSON.parse(raw); } catch { value = raw.trim().split('\n').filter(Boolean).map(JSON.parse); }
  return { status: r.status, value };
}
async function sql(query, params = []) {
  const r = await fetch('http://127.0.0.1:4107/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) });
  assert.equal(r.status, 200);
  return r.json();
}
async function model(name, target = 'chatModel') {
  assert.equal((await api('/api/settings', 'PUT', { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', [target]: name } } })).status, 200);
}
async function paper() {
  const p = (await api('/api/papers', 'POST', { title: '修复回归试卷', subject: '数学', pace: 'thorough' })).value;
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync('public/avatars/darjeeling.png').toString('base64');
  assert.equal((await api(`/api/papers/${p.id}/pages`, 'POST', { dataUrl })).status, 200);
  return p.id;
}
async function session(paperId) {
  const tutorId = (await api('/api/tutors')).value[0].id;
  const r = await api('/api/sessions', 'POST', { paperId, tutorId });
  assert.equal(r.status, 200, JSON.stringify(r.value));
  return r.value.id;
}
async function analyze(id, name = 'audit-normal', restart = false) {
  await model(name, 'analysisModel');
  return api(`/api/papers/${id}/analyze`, 'POST', { restart });
}
async function turn(id, name, text = '') {
  await model(name);
  return api(`/api/sessions/${id}/turn`, 'POST', { text });
}
const done = r => r.value.find(e => e.type === 'done');
const pass = (test, details = {}) => report.push({ test, outcome: 'pass', ...details });
const normal = await paper();
assert.ok(done(await analyze(normal)));
assert.equal((await api(`/api/papers/${normal}`)).value.problems.length, 2);
const classId = await session(normal);
assert.deepEqual((await turn(classId, 'audit-teach')).value.map(e => e.type), ['message', 'board', 'message', 'done']);
pass('validated inventory + per-problem analysis; Chinese chat, Japanese speech, interleaved board');

for (const name of ['audit-incomplete', 'audit-error', 'audit-bad-inventory', 'audit-missing-fields', 'audit-wrong-number']) {
  const id = await paper();
  const events = await analyze(id, name);
  const data = (await api(`/api/papers/${id}`)).value;
  assert.equal(data.paper.status, 'failed');
  assert.ok(data.paper.error);
  assert.equal(done(events), undefined);
  assert.equal((await api('/api/sessions', 'POST', { paperId: id, tutorId: 1 })).status, 400);
  if (['audit-incomplete', 'audit-error'].includes(name)) {
    assert.equal(data.problems.filter(p => p.analysis !== 'unparsed').length, 1);
    const before = (await (await fetch('http://127.0.0.1:4107/requests')).json()).length;
    assert.ok(done(await analyze(id)));
    const requests = (await (await fetch('http://127.0.0.1:4107/requests')).json()).slice(before);
    assert.equal(requests.length, 1);
    assert.ok(JSON.stringify(requests[0].messages).includes('只解析第 2'));
    assert.equal((await api(`/api/papers/${id}`)).value.problems.length, 2);
  }
  if (name === 'audit-incomplete' || name === 'audit-error') {
    // Fresh failed papers have no published rows; a failed reanalysis must keep old rows visible.
    const existing = await paper();
    await analyze(existing);
    assert.equal((await analyze(existing, name, true)).value.some(e => e.type === 'error'), true);
    assert.equal((await api(`/api/papers/${existing}`)).value.problems.length, 2);
  }
  pass(name + ' rejected; no ready/classroom; completed work resumes without duplicates');
}

const finishId = await session(normal);
const early = done(await turn(finishId, 'audit-finish'));
assert.equal(early.action, 'wait');
assert.equal(early.session.status, 'active');
assert.notEqual(early.session.progress['0'], 'done');
assert.equal(done(await turn(finishId, 'audit-forged')).action, 'wait');
const first = done(await turn(finishId, 'audit-finish-full'));
assert.equal(first.action, 'next');
assert.equal(first.session.currentIdx, 1);
assert.equal(first.session.status, 'active');
const final = done(await turn(finishId, 'audit-finish-full'));
assert.equal(final.action, 'finish');
assert.equal(final.session.status, 'completed');
assert.deepEqual(final.session.progress, { 0: 'done', 1: 'done' });
pass('early finish and forged evidence blocked; all four teaching topics and all problems required');
const jumped = await session(normal);
assert.equal((await api(`/api/sessions/${jumped}`, 'PATCH', { currentIdx: 1 })).status, 200);
const back = done(await turn(jumped, 'audit-finish-full'));
assert.equal(back.action, 'next');
assert.equal(back.session.currentIdx, 0);
assert.equal(done(await turn(jumped, 'audit-finish-full')).session.status, 'completed');
pass('jumping to last problem still returns to unfinished earlier problem');

const longId = await session(normal);
for (const name of ['audit-long', 'audit-fallback', 'audit-repair-fail']) {
  const output = (await turn(longId, name)).value.filter(e => e.type === 'message').map(e => e.message);
  assert.ok(output.length > 1);
  assert.ok(output.every(m => m.content.length <= 80));
  assert.equal(output.map(m => m.content).join(''), '这里解释方程式的移项原理。'.repeat(45));
  assert.ok(output.every(m => name === 'audit-repair-fail' ? !m.speech : /[\u3040-\u30ff]/.test(m.speech)));
  pass(name + ' split into short bubbles without losing content', { bubbles: output.length });
}
const repaired = (await turn(longId, 'audit-language')).value.find(e => e.type === 'message').message;
assert.equal(repaired.content, '这是修复后的中文消息。');
assert.ok(/[\u3040-\u30ff]/.test(repaired.speech));
const boardRepair = (await turn(longId, 'audit-board-language')).value.find(e => e.type === 'board');
assert.ok(!/[\u3040-\u30ff]/.test(JSON.stringify(boardRepair.board)));
assert.equal((await api('/api/tts', 'POST', { text: '这是中文语音。', voiceId: 'dummy' })).status, 400);
pass('language split repaired for chat/board; TTS rejects Chinese');

const concurrentId = await session(normal);
await model('audit-slow');
const active = api(`/api/sessions/${concurrentId}/turn`, 'POST', {});
await new Promise(r => setTimeout(r, 150));
assert.equal((await api(`/api/sessions/${concurrentId}/turn`, 'POST', {})).status, 409);
assert.equal((await api(`/api/sessions/${concurrentId}`, 'PATCH', { currentIdx: 1 })).status, 409);
assert.equal((await api(`/api/sessions/${concurrentId}`, 'DELETE')).status, 409);
assert.ok(done(await active));
await turn(concurrentId, 'audit-teach');
assert.equal((await sql('select blocks from boards where session_id=$1', [concurrentId]))[0].blocks.length, 2);
pass('concurrent generation, jump and delete rejected; later turn preserves both board writes');
await model('audit-teach');
const ids = await Promise.all(Array.from({ length: 10 }, () => session(normal)));
await Promise.all(ids.map(async id => assert.ok(done(await api(`/api/sessions/${id}/turn`, 'POST', {})))));
pass('ten distinct concurrent classrooms do not exhaust database work connections');
const failedTurn = await session(normal);
assert.ok((await turn(failedTurn, 'audit-turn-error')).value.some(e => e.type === 'error'));
assert.ok(done(await turn(failedTurn, 'audit-teach')));
const cancelled = await session(normal);
await model('audit-slow');
const cancel = new AbortController();
const cancelledResponse = await fetch(base + `/api/sessions/${cancelled}/turn`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: cancel.signal });
await cancelledResponse.body.getReader().read();
cancel.abort();
await new Promise(r => setTimeout(r, 300));
assert.ok(done(await turn(cancelled, 'audit-teach')));
pass('session lock released after upstream error or student cancellation');

const reparse = await paper();
await analyze(reparse);
const oldClass = await session(reparse);
await turn(oldClass, 'audit-teach');
assert.equal((await analyze(reparse, 'audit-incomplete', true)).value.some(e => e.type === 'error'), true);
assert.equal((await sql('select count(*)::int as n from problems where paper_id=$1', [reparse]))[0].n, 2);
await analyze(reparse, 'audit-change', true);
const newClass = await session(reparse);
const snapshots = await sql('select id, snapshot from sessions where id=any($1::int[]) order by id', [[oldClass, newClass]]);
assert.ok(snapshots[0].snapshot.problems[0].content.includes('x+1=2'));
assert.ok(snapshots[1].snapshot.problems[0].content.includes('导数'));
const oldHtml = await (await fetch(base + '/classroom/' + oldClass)).text();
assert.ok(oldHtml.includes('x+1=2'));
pass('failed reanalysis preserves published results; successful reanalysis preserves existing classroom snapshot');

await model('audit-slow', 'analysisModel');
const lockedPaper = await paper();
const analysis = api(`/api/papers/${lockedPaper}/analyze`, 'POST', {});
await new Promise(r => setTimeout(r, 150));
assert.equal((await api(`/api/papers/${lockedPaper}`, 'PATCH', { title: 'race' })).status, 409);
assert.equal((await api(`/api/papers/${lockedPaper}`, 'DELETE')).status, 409);
assert.ok(done(await analysis));
pass('paper edit/delete cannot race with analysis');
const requests = await (await fetch('http://127.0.0.1:4107/requests')).json();
assert.ok(requests.filter(r => r.messages[0].content.includes('试卷识别专家')).every(r => r.max_tokens === 16000));
pass('explicit analysis output budget is sent upstream');
await model('audit-teach');
await model('audit-normal', 'analysisModel');
fs.writeFileSync('output/audit/fix-api-results.json', JSON.stringify({ base, classId, normalPaperId: normal, report }, null, 2));
console.log(JSON.stringify({ classId, normalPaperId: normal, passed: report.length, report }, null, 2));
