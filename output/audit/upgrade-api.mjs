import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3107';
const report = [];
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text(); let value;
  try { value = JSON.parse(raw); } catch { value = raw.trim().split('\n').filter(Boolean).map(JSON.parse); }
  return { status: response.status, value };
}
async function sql(query, params = []) {
  const response = await fetch('http://127.0.0.1:4107/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) });
  assert.equal(response.status, 200); return response.json();
}
const ok = (result) => { assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
const done = (result) => { ok(result); assert.ok(Array.isArray(result.value)); const event = result.value.find(e => e.type === 'done'); assert.ok(event, JSON.stringify(result.value)); return event; };
const pass = (test) => report.push({ test, outcome: 'pass' });
const key = 'upgrade-dummy-secret-123456';
await sql('delete from app_settings');
await sql('insert into app_settings (id, data) values (1,$1)', [{ provider: 'gemini', providers: { gemini: { apiKey: key, baseUrl: 'http://127.0.0.1:4107', chatModel: 'audit-language', analysisModel: 'audit-plan' } } }]);
let settings = ok(await api('/api/settings'));
assert.equal(settings.models.chat.connectionId, 'gemini');
assert.ok(!JSON.stringify(settings).includes(key));
pass('legacy settings migrate to connections and preserve masked keys');
const connections = [
  { id: 'chat', name: '讲解兼容连接', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:4107/v1', apiKey: key },
  { id: 'analysis', name: '分析 Gemini', protocol: 'gemini', baseUrl: 'http://127.0.0.1:4107', apiKey: key },
  { id: 'extra', name: '备用兼容连接', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:4107/v1', apiKey: key },
];
let models = { chat: { connectionId: 'chat', model: 'audit-finish-full' }, analysis: { connectionId: 'analysis', model: 'audit-plan' } };
async function configure(analysis = 'audit-plan', chat = 'audit-finish-full') {
  models = { chat: { connectionId: 'chat', model: chat }, analysis: { connectionId: 'analysis', model: analysis } };
  settings = ok(await api('/api/settings', 'PUT', { connections, models, fish: { enabled: false } }));
}
await configure();
assert.equal((await api('/api/settings', 'PUT', { connections: connections.filter(c => c.id !== 'chat') })).status, 400);
for (const purpose of ['chat', 'analysis']) assert.equal(ok(await api('/api/settings/test', 'POST', { purpose })).model, models[purpose].model);
assert.ok(!JSON.stringify(settings).includes(key));
pass('independent purpose tests, multiple compatible connections and referenced deletion guard');
const tutor = ok(await api('/api/tutors')).find(t => t.name === '阿尔托莉雅');
assert.ok(tutor); assert.equal(tutor.voiceId, '4aa42286f3844a29a243e2ebd29f815f'); assert.equal(tutor.subject, undefined);
async function paper(pace = 'focused') {
  const paper = ok(await api('/api/papers', 'POST', { title: '导学回归', subject: '数学', pace }));
  ok(await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:text/markdown;base64,' + Buffer.from('四道代表题').toString('base64') }));
  return paper.id;
}
const paperId = await paper();
done(await api(`/api/papers/${paperId}/analyze`, 'POST', {}));
let material = ok(await api(`/api/papers/${paperId}`));
assert.equal(material.problems.length, 4); assert.deepEqual(material.problems.filter(p => p.analysis === 'ready').map(p => p.idx), [0, 2]);
assert.equal(material.directory[1].analysis, null); assert.equal(material.problems[1].answer, '');
assert.deepEqual(material.paper.analysisPlan.units[0].related, [1]);
const sessionId = ok(await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id })).id;
let turn = done(await api(`/api/sessions/${sessionId}/turn`, 'POST', { planVersion: 1 }));
assert.equal(turn.session.currentIdx, 2); assert.equal(turn.session.progress['1'], undefined);
turn = done(await api(`/api/sessions/${sessionId}/turn`, 'POST', { planVersion: 1 }));
assert.equal(turn.session.status, 'completed'); assert.equal(turn.session.progress['3'], undefined);
pass('selective analysis retains full nullable directory, stable sparse indices and plan-only completion');
let planned = ok(await api(`/api/sessions/${sessionId}/plan`, 'POST', { pace: 'thorough', planVersion: 1 }));
assert.deepEqual(planned.missing, [1, 3]); assert.equal(planned.session.plan.version, 1); const pendingVersion = planned.session.pendingPlan.version;
await configure('audit-plan-incomplete');
const failed = await api(`/api/sessions/${sessionId}/supplement`, 'POST', { planVersion: pendingVersion });
assert.ok(failed.value.some(e => e.type === 'error')); assert.ok(!failed.value.some(e => e.type === 'done'));
let row = (await sql('select * from sessions where id=$1', [sessionId]))[0];
assert.equal(row.plan.version, 1); assert.ok(row.supplement_draft['1']); assert.ok(!row.supplement_draft['3']);
await configure();
const requestsBefore = (await (await fetch('http://127.0.0.1:4107/requests')).json()).length;
const supplemented = done(await api(`/api/sessions/${sessionId}/supplement`, 'POST', { planVersion: pendingVersion }));
const resumed = (await (await fetch('http://127.0.0.1:4107/requests')).json()).slice(requestsBefore);
assert.equal(resumed.length, 1); assert.ok(JSON.stringify(resumed[0]).includes('只解析第 4'));
assert.equal(supplemented.session.plan.version, pendingVersion); assert.equal(supplemented.session.status, 'active');
assert.equal((await api(`/api/sessions/${sessionId}/turn`, 'POST', { planVersion: 1, intent: 'complete_problem', problemIdx: 2 })).status, 409);
row = (await sql('select * from sessions where id=$1', [sessionId]))[0];
assert.ok(row.coverage['0']); assert.equal(row.progress['0'], 'pending');
pass('confirmed supplement failure preserves old plan and indexed draft; retry resumes; new goal version rejects stale completion');
for (const pace of ['thorough', 'focused', 'essential', 'challenge', 'advanced']) {
  planned = ok(await api(`/api/sessions/${sessionId}/plan`, 'POST', { pace, planVersion: row.plan.version }));
  row = (await sql('select * from sessions where id=$1', [sessionId]))[0];
  assert.equal(row.plan.pace, pace); assert.equal(row.pending_plan, null);
  if (pace === 'advanced') assert.ok(row.plan.units.every(u => ['extension', 'practice'].every(t => u.goals.some(g => g.topic === t))));
}
pass('five paces generate valid target plans; advanced requires extension and practice feedback');
const canceledSession = ok(await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id })).id;
const canceled = ok(await api(`/api/sessions/${canceledSession}/plan`, 'POST', { pace: 'thorough', planVersion: 1 })).session.pendingPlan.version;
ok(await api(`/api/sessions/${canceledSession}/plan`, 'DELETE'));
const replacement = ok(await api(`/api/sessions/${canceledSession}/plan`, 'POST', { pace: 'thorough', planVersion: 1 })).session.pendingPlan.version;
assert.ok(replacement > canceled);
assert.equal((await api(`/api/sessions/${canceledSession}/supplement`, 'POST', { planVersion: canceled })).status, 409);
pass('canceled pending versions are never reused and stale confirmations are rejected');
await configure('audit-plan-incomplete');
const sparsePaper = await paper('challenge');
const sparseFailed = await api(`/api/papers/${sparsePaper}/analyze`, 'POST', {});
assert.ok(sparseFailed.value.some(e => e.type === 'error'));
const sparseDraft = (await sql('select analysis_draft from papers where id=$1', [sparsePaper]))[0].analysis_draft;
assert.deepEqual(Object.keys(sparseDraft.indexed), ['2']);
await configure();
const sparseBefore = (await (await fetch('http://127.0.0.1:4107/requests')).json()).length;
done(await api(`/api/papers/${sparsePaper}/analyze`, 'POST', {}));
const sparseRequests = (await (await fetch('http://127.0.0.1:4107/requests')).json()).slice(sparseBefore);
assert.equal(sparseRequests.length, 1);
assert.ok(JSON.stringify(sparseRequests[0]).includes('只解析第 4'));
assert.deepEqual(ok(await api(`/api/papers/${sparsePaper}`)).problems.filter(p => p.analysis === 'ready').map(p => p.idx), [2, 3]);
pass('initial non-contiguous analysis resumes by stable index without redoing completed work');
await configure('audit-change'); done(await api(`/api/papers/${paperId}/analyze`, 'POST', { restart: true, pace: 'thorough' }));
assert.equal((await api(`/api/sessions/${sessionId}/supplement`, 'POST', { planVersion: pendingVersion })).status, 409);
assert.equal((await api(`/api/sessions/${canceledSession}/supplement`, 'POST', { planVersion: replacement })).status, 409);
assert.equal((await sql('select snapshot from sessions where id=$1', [sessionId]))[0].snapshot.problems.length, 4);
pass('reanalysis isolates historical classroom snapshots and rejects incompatible supplements');
await configure('audit-plan', 'audit-language');
done(await api(`/api/sessions/${sessionId}/turn`, 'POST', { planVersion: row.plan.version }));
const requests = await (await fetch('http://127.0.0.1:4107/requests')).json();
assert.ok(requests.some(r => r.model === 'audit-language' && JSON.stringify(r.messages).includes('[MESSAGE_REPAIR]')));
assert.ok(!requests.some(r => r.model === 'audit-plan' && JSON.stringify(r.messages).includes('[MESSAGE_REPAIR]')));
pass('message repairs use teaching binding independently of analysis binding');
const readingIds = [];
await configure('audit-plan', 'audit-teach');
for (const language of ['en', 'ja']) {
  const text = language === 'en' ? 'Scientists study how cities change.\n\nTheir work helps communities plan for the future.' : '春になると、街の公園に花が咲きます。\n\n人々は散歩しながら季節の変化を楽しみます。';
  const reading = ok(await api('/api/readings', 'POST', { title: `${language} 外刊`, language, text }));
  done(await api(`/api/readings/${reading.id}/analyze`, 'POST', {}));
  assert.equal((await api('/api/reading-sessions', 'POST', { readingId: reading.id, tutorId: tutor.id })).status, 400);
  let data = ok(await api(`/api/readings/${reading.id}`));
  const confirmed = ok(await api(`/api/readings/${reading.id}`, 'PATCH', { revision: data.reading.revision, text }));
  assert.equal(confirmed.paragraphs.length, 2);
  const classId = ok(await api('/api/reading-sessions', 'POST', { readingId: reading.id, tutorId: tutor.id })).id;
  const output = await api(`/api/reading-sessions/${classId}/turn`, 'POST', { paragraphIdx: 0, text: '' });
  done(output); assert.ok(output.value.some(e => e.type === 'message' && e.message.kind === 'quote' && e.message.language === language && !e.message.speech));
  assert.ok(output.value.some(e => e.type === 'message' && e.message.kind === 'exercise'));
  assert.ok(output.value.some(e => e.type === 'message' && e.message.kind === 'feedback'));
  assert.ok(done(await api(`/api/reading-sessions/${classId}/turn`, 'POST', { paragraphIdx: 0, text: '我理解了', intent: 'next' })).session.currentIdx === 1);
  assert.equal((await api(`/api/reading-sessions/${classId}/turn`, 'POST', { paragraphIdx: 0 })).status, 409);
  const restored = ok(await api(`/api/reading-sessions/${classId}`)); assert.equal(restored.session.currentIdx, 1); assert.ok(restored.session.notes['0'].length); assert.ok(restored.messages.length);
  const jumped = ok(await api(`/api/reading-sessions/${classId}`, 'PATCH', { currentIdx: 0 })); assert.equal(jumped.progress['0'], 'done');
  ok(await api(`/api/readings/${reading.id}`, 'PATCH', { revision: confirmed.revision, text: 'Changed article.' }));
  assert.equal(ok(await api(`/api/reading-sessions/${classId}`)).reading.paragraphs[0].text, confirmed.paragraphs[0].text);
  readingIds.push({ readingId: reading.id, sessionId: classId, language });
}
pass('English and Japanese reading review, language-labeled quotations, open practice, position/notes recovery and snapshot isolation');
const imageReading = ok(await api('/api/readings', 'POST', { title: '图片文章', language: 'en' }));
ok(await api(`/api/readings/${imageReading.id}/sources`, 'POST', { dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') }));
assert.equal(done(await api(`/api/readings/${imageReading.id}/analyze`, 'POST', {})).reading.status, 'review');
pass('image article OCR uses analysis binding and requires source review');
fs.writeFileSync('output/audit/upgrade-api-results.json', JSON.stringify({ report, paperId, sessionId, readingIds }, null, 2));
console.log(JSON.stringify(report, null, 2));
