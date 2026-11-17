import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3107';
const mock = 'http://127.0.0.1:4107';
const report = [];
const evidence = {
  solution: '两边同时减去常数，得到正确答案。',
  knowledge: '人教A版必修第一册：等式两边同减同加。',
  skills: '采用等价变形，逐步分离未知数。',
  pitfalls: '移项时必须变号，避免漏掉负号。',
};
async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let value;
  if (res.headers.get('content-type')?.includes('ndjson')) value = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
  else value = JSON.parse(raw);
  return { status: res.status, value };
}
async function sql(sql, params = []) {
  const res = await fetch(mock + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) });
  assert.equal(res.status, 200);
  return res.json();
}
async function setModel(chatModel) {
  await api('/api/settings', 'PUT', { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: mock + '/v1', chatModel, analysisModel: 'audit-normal' } }, fish: { enabled: false }, autoContinue: true });
}
await setModel('audit-teach');
const paper = (await api('/api/papers', 'POST', { title: '完成与告别回归', subject: '数学' })).value;
await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/darjeeling.png').toString('base64') });
await api(`/api/papers/${paper.id}/analyze`, 'POST', {});
const tutor = (await api('/api/tutors')).value[0];
async function session() { return (await api('/api/sessions', 'POST', { paperId: paper.id, tutorId: tutor.id })).value.id; }
async function turn(id, model, body = {}) {
  await setModel(model);
  const res = await api(`/api/sessions/${id}/turn`, 'POST', body);
  assert.equal(res.status, 200, JSON.stringify(res));
  return res.value;
}
const done = events => events.find(event => event.type === 'done');
async function savedEvidence(id, problemIdx = 0, role = 'tutor') {
  for (const quote of Object.values(evidence)) await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,$2,\'text\',$3,$4)', [id, role, quote, problemIdx]);
}
function pass(test) { report.push({ test, outcome: 'pass' }); }

const explicit = await session();
let events = await turn(explicit, 'audit-coverage-missing');
assert.equal(done(events).session.progress['0'], 'active');
assert.equal(done(events).action, 'wait');
pass('coverage content without completion trigger does not complete');
await setModel('audit-coverage-error');
const requestsBeforeConfirm = (await (await fetch(mock + '/requests')).json()).length;
events = (await api(`/api/sessions/${explicit}/turn`, 'POST', { text: '我懂了，下一题', problemIdx: 0, planVersion: 1 })).value;
assert.equal(done(events).session.progress['0'], 'done');
assert.equal(done(events).action, 'next');
assert.equal((await (await fetch(mock + '/requests')).json()).length, requestsBeforeConfirm);
assert.ok(done(events).session.completionConfirmations['0'].goalIds.length);
pass('explicit completion records student confirmation without a model call');
events = await turn(explicit, 'audit-coverage-missing', { intent: 'complete_problem', problemIdx: 0 });
assert.equal(done(events).session.currentIdx, 1);
assert.notEqual(done(events).session.progress['1'], 'done');
pass('completion retry for an already-done target only synchronizes progress');

const offline = await session();
await sql('DELETE FROM app_settings WHERE id=1');
const beforeOffline = (await (await fetch(mock + '/requests')).json()).length;
events = (await api(`/api/sessions/${offline}/turn`, 'POST', { intent: 'complete_problem', problemIdx: 0, planVersion: 1 })).value;
assert.equal(done(events).session.progress['0'], 'done');
assert.equal((await (await fetch(mock + '/requests')).json()).length, beforeOffline);
assert.equal((await api(`/api/sessions/${offline}/turn`, 'POST', { intent: 'complete_problem', problemIdx: 1, planVersion: 999 })).status, 409);
assert.equal((await api(`/api/sessions/${offline}/turn`, 'POST', { checkCompletion: true, text: '问题', problemIdx: 1 })).status, 400);
pass('completion works without configured model; obsolete plan and mixed check requests are rejected');
await setModel('audit-teach');

const rollback = await session();
await sql("CREATE FUNCTION audit_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id = " + Number(rollback) + " AND NEW.role = 'user' THEN RAISE EXCEPTION 'audit rollback'; END IF; RETURN NEW; END $$");
await sql('CREATE TRIGGER audit_reject_confirmation BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION audit_reject_confirmation()');
try {
  const response = await fetch(base + `/api/sessions/${rollback}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'complete_problem', problemIdx: 0, planVersion: 1 }) });
  assert.equal(response.status, 500);
  const [row] = await sql('SELECT progress,current_idx,completion_confirmations FROM sessions WHERE id=$1', [rollback]);
  assert.equal(row.progress['0'], 'active');
  assert.equal(row.current_idx, 0);
  assert.deepEqual(row.completion_confirmations, {});
} finally {
  await sql('DROP TRIGGER audit_reject_confirmation ON messages');
  await sql('DROP FUNCTION audit_reject_confirmation()');
}
pass('transaction failure rolls back confirmation and progress');

const cycle = await session();
let cycleResult = await api(`/api/sessions/${cycle}/turn`, 'POST', { intent: 'complete_problem', problemIdx: 0, planVersion: 1 });
const originalPlan = cycleResult.value.find(event => event.type === 'done').session.plan;
const originalGoals = originalPlan.units[0].goals;
assert.ok(originalGoals.length >= 2);
const extra = { ...originalGoals[0], id: 'audit-expanded-goal', description: '新增的目标' };
const expandedPlan = { ...originalPlan, version: 2, units: originalPlan.units.map(unit => unit.idx === 0 ? { ...unit, goals: [originalGoals[1], extra] } : unit) };
await sql("UPDATE sessions SET plan=$2::jsonb,current_idx=0,status='active',progress=$3::jsonb WHERE id=$1", [cycle, JSON.stringify(expandedPlan), JSON.stringify({ 0: 'active', 1: 'pending' })]);
cycleResult = await api(`/api/sessions/${cycle}/turn`, 'POST', { intent: 'complete_problem', problemIdx: 0, planVersion: 2 });
const ids = done(cycleResult.value).session.completionConfirmations['0'].goalIds;
assert.ok(originalGoals.every(goal => ids.includes(goal.id)) && ids.includes(extra.id));
assert.equal(new Set(ids).size, ids.length);
pass('reconfirming expanded goals retains earlier goal IDs without duplicates');

const legacy = await session();
await savedEvidence(legacy);
for (let n = 0; n < 65; n++) await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,\'user\',\'text\',\'这是后续对话，不是证据。\',0)', [legacy]);
events = await turn(legacy, 'audit-coverage-history', { checkCompletion: true, problemIdx: 0 });
assert.equal(done(events).session.progress['0'], 'done');
const [{ coverage }] = await sql('SELECT coverage FROM sessions WHERE id=$1', [legacy]);
assert.deepEqual(Object.values(coverage['0']).sort(), [evidence.knowledge, evidence.skills].sort());
assert.ok(!events.some(event => event.type === 'message'));
pass('check-only recovers legacy evidence before the last 60 messages without re-teaching');

for (const source of ['user', 'other_problem', 'reference', 'declaration', 'heading']) {
  const id = await session();
  if (source === 'user') await savedEvidence(id, 0, 'user');
  if (source === 'other_problem') await savedEvidence(id, 1);
  if (source === 'heading' || source === 'declaration') await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,\'tutor\',\'text\',$2,0)', [id, source === 'heading' ? '## 核心知识点与方法总结' : '这一题已经完整讲解。']);
  events = await turn(id, 'audit-coverage-forged', { checkCompletion: true, problemIdx: 0 });
  assert.equal(done(events).session.progress['0'], 'active');
  assert.equal(done(events).action, 'wait');
}
pass('student, other-problem, reference, headings and declarations cannot prove completion');

for (const model of ['audit-coverage-error', 'audit-coverage-truncated', 'audit-coverage-open', 'audit-coverage-stray']) {
  const id = await session();
  await savedEvidence(id);
  events = await turn(id, model, { checkCompletion: true, problemIdx: 0 });
  assert.equal(done(events).session.progress['0'], 'active');
  assert.equal(done(events).completionCheck.status, 'check_failed');
  assert.ok(!events.some(event => event.type === 'message'));
}
pass('failed or incomplete repair preserves unfinished progress');

const skipped = await session();
await api(`/api/sessions/${skipped}`, 'PATCH', { currentIdx: 1 });
events = await turn(skipped, 'audit-next');
assert.equal(done(events).session.currentIdx, 0);
assert.equal(done(events).session.progress['1'], 'done');
assert.equal(done(events).session.status, 'active');
events = await turn(skipped, 'audit-finish-full');
assert.equal(done(events).session.status, 'completed');
pass('finish revisits skipped problems and completes only after every problem');

const goodbye = await session();
const [{ progress: before }] = await sql('SELECT progress FROM sessions WHERE id=$1', [goodbye]);
events = await turn(goodbye, 'audit-goodbye-next', { text: '就到这里吧，再见' });
assert.equal(done(events).intent, 'goodbye');
assert.equal(done(events).action, 'wait');
assert.deepEqual(done(events).session.progress, before);
assert.ok(!events.some(event => ['problem', 'board'].includes(event.type)));
pass('typed goodbye suppresses erroneous next, board and progress mutation');
for (const model of ['audit-goodbye-error', 'audit-goodbye-truncated', 'audit-goodbye-noaction', 'audit-goodbye-badaction']) {
  events = await turn(goodbye, model, { intent: 'goodbye' });
  assert.equal(done(events), undefined);
  assert.ok(events.some(event => event.type === 'error'));
}
events = await turn(goodbye, 'audit-goodbye', { intent: 'goodbye' });
assert.equal(done(events).intent, 'goodbye');
pass('invalid goodbye has no success done; retry retains goodbye and releases lock');
assert.equal((await api(`/api/sessions/${goodbye}/turn`, 'POST', { intent: 'invalid' })).status, 400);
assert.equal((await api(`/api/sessions/${goodbye}/turn`, 'POST', { intent: 'complete_problem', problemIdx: 1 })).status, 400);
pass('invalid intent and stale target are rejected before teaching');

const gemini = await session();
await savedEvidence(gemini);
await api('/api/settings', 'PUT', { provider: 'gemini', providers: { gemini: { apiKey: 'audit-dummy-key-only', baseUrl: mock, chatModel: 'audit-coverage-history' } } });
events = (await api(`/api/sessions/${gemini}/turn`, 'POST', { checkCompletion: true, problemIdx: 0 })).value;
assert.equal(done(events).session.progress['0'], 'done');
assert.equal(done(events).action, 'next');
pass('Gemini SSE adapter recovers omitted historical evidence without teaching');
await setModel('audit-teach');

fs.writeFileSync('output/audit/classroom-completion-results.json', JSON.stringify({ report, paperId: paper.id, tutorId: tutor.id }, null, 2));
console.log(JSON.stringify(report, null, 2));
