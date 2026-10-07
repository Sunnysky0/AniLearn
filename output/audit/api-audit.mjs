import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3107';
const report = [];
async function api(url, method = 'GET', body) {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  return { status: r.status, value };
}
async function sql(query, params = []) {
  return (await fetch('http://127.0.0.1:4107/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) })).json();
}
async function model(name, target = 'chatModel') {
  const r = await api('/api/settings', 'PUT', { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', [target]: name } } });
  assert.equal(r.status, 200);
}
async function paper(name = '审计测试试卷') {
  const p = (await api('/api/papers', 'POST', { title: name, subject: '数学' })).value;
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync('public/avatars/darjeeling.png').toString('base64');
  assert.equal((await api(`/api/papers/${p.id}/pages`, 'POST', { dataUrl })).status, 200);
  return p.id;
}
async function session(paperId) {
  const tutorId = (await api('/api/tutors')).value[0].id;
  const r = await api('/api/sessions', 'POST', { paperId, tutorId });
  assert.equal(r.status, 200);
  return r.value.id;
}
async function analyze(id, name = 'audit-normal') {
  await model(name, 'analysisModel');
  return api(`/api/papers/${id}/analyze`, 'POST');
}
async function turn(id, name, text = '') {
  await model(name);
  return api(`/api/sessions/${id}/turn`, 'POST', { text });
}
const normal = await paper();
const normalEvents = await analyze(normal);
const normalData = (await api(`/api/papers/${normal}`)).value;
assert.equal(normalData.paper.status, 'ready');
assert.equal(normalData.problems.length, 2);
report.push({ test: 'normal analysis', outcome: 'pass', problems: 2, fieldsPresent: normalData.problems.every(p => p.answer && p.solution && p.knowledgePoints.length && p.skills.length) });
const classId = await session(normal);
const teach = await turn(classId, 'audit-teach');
assert.deepEqual(teach.value.map(e => e.type), ['message', 'board', 'message', 'done']);
report.push({ test: 'short Chinese messages interleaved with board and Japanese scripts', outcome: 'pass', eventTypes: teach.value.map(e => e.type) });
const incompleteId = await paper('截断复现');
await analyze(incompleteId, 'audit-incomplete');
const incompleteData = (await api(`/api/papers/${incompleteId}`)).value;
report.push({ test: 'model output truncated mid-problem (finish_reason=length)', outcome: 'defect', paper: incompleteData.paper, problems: incompleteData.problems.map(p => ({ number: p.number, content: p.content, answer: p.answer, solution: p.solution, knowledgeCount: p.knowledgePoints.length, skillsCount: p.skills.length })) });
const errorId = await paper('中途错误复现');
const errEvents = await analyze(errorId, 'audit-error');
const errData = (await api(`/api/papers/${errorId}`)).value;
report.push({ test: 'upstream fails after first problem', outcome: 'defect', status: errData.paper.status, error: errData.paper.error, problemCount: errData.problems.length, events: errEvents.value.map(e => e.type) });
await sql("update papers set status='analyzing' where id=$1", [errorId]);
const activeSession = await session(errorId);
report.push({ test: 'start classroom with analyzing paper', outcome: 'defect', sessionId: activeSession });
const finishId = await session(normal);
const finish = await turn(finishId, 'audit-finish');
const finished = finish.value.find(e => e.type === 'done').session;
assert.equal(finished.status, 'completed');
assert.equal(finished.progress['1'], undefined);
report.push({ test: 'finish emitted on first of two problems', outcome: 'defect', status: finished.status, currentIdx: finished.currentIdx, progress: finished.progress });
const longId = await session(normal);
const long = await turn(longId, 'audit-long');
report.push({ test: 'tagged long bubble', outcome: 'defect', tutorMessages: long.value.filter(e => e.type === 'message').length, length: long.value.find(e => e.type === 'message').message.content.length });
const fallback = await turn(longId, 'audit-fallback');
report.push({ test: 'untagged long-paragraph fallback', outcome: 'defect', tutorMessages: fallback.value.filter(e => e.type === 'message').length, length: fallback.value.find(e => e.type === 'message').message.content.length });
const language = await turn(longId, 'audit-language');
report.push({ test: 'language split violation passed through', outcome: 'defect', message: language.value.find(e => e.type === 'message').message });
const concurrentId = await session(normal);
await model('audit-teach');
const concurrent = await Promise.all([api(`/api/sessions/${concurrentId}/turn`, 'POST', {}), api(`/api/sessions/${concurrentId}/turn`, 'POST', {})]);
const storedBoards = await sql('select blocks from boards where session_id=$1', [concurrentId]);
const boardMsgCount = await sql("select count(*)::int as count from messages where session_id=$1 and kind='board'", [concurrentId]);
report.push({ test: 'two simultaneous turns', outcome: 'defect', responseStatuses: concurrent.map(r => r.status), storedBoardBlockCount: storedBoards[0].blocks.length, boardMessageCount: boardMsgCount[0].count });
const reparseId = await paper('重新解析复现');
await analyze(reparseId);
const reparseClass = await session(reparseId);
await turn(reparseClass, 'audit-teach');
await analyze(reparseId, 'audit-change');
const newProblem = (await api(`/api/papers/${reparseId}`)).value.problems[0];
const staleBoard = await sql('select problem_idx, title, blocks from boards where session_id=$1', [reparseClass]);
report.push({ test: 'reparse existing paper changes problem meaning', outcome: 'defect', newProblem: newProblem.content, retainedBoard: staleBoard[0] });
const requests = await (await fetch('http://127.0.0.1:4107/requests')).json();
const analysisRequest = requests.find(r => r.model === 'audit-incomplete');
report.push({ test: 'OpenAI analysis output budget', outcome: 'defect', max_tokens: analysisRequest.max_tokens, max_completion_tokens: analysisRequest.max_completion_tokens, requestedInSource: 32000 });
await model('audit-teach');
await model('audit-normal', 'analysisModel');
fs.writeFileSync('output/audit/api-results.json', JSON.stringify({ base, classId, normalPaperId: normal, report }, null, 2));
console.log(JSON.stringify({ classId, normalPaperId: normal, tests: report.map(r => ({ test: r.test, outcome: r.outcome, ...(r.length ? { length: r.length } : {}) })) }, null, 2));
