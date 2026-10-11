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
async function waitReadingStatus(id, status, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await api(`/api/readings/${id}/analysis-status`);
    if (result.status === 200 && result.value.status === status) return result.value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Reading ${id} did not reach ${status}`);
}
async function waitLearningAnalysisStatus(id, status, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await api(`/api/reading-sessions/${id}/analysis-status`);
    if (result.status === 200 && result.value.status === status) return result.value;
    if (result.status === 200 && result.value.status === 'failed' && status !== 'failed') throw new Error(`Reading analysis failed: ${result.value.error}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Reading session ${id} did not reach analysis status ${status}`);
}
const ok = (result) => { assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
const created = (result) => { assert.equal(result.status, 201, JSON.stringify(result.value)); return result.value; };
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
  assert.equal(done(await api(`/api/readings/${reading.id}/analyze`, 'POST', {})).reading.extracted, text);
  assert.equal((await api('/api/reading-sessions', 'POST', { readingId: reading.id, tutorId: tutor.id })).status, 400);
  let data = ok(await api(`/api/readings/${reading.id}`));
  const confirmed = ok(await api(`/api/readings/${reading.id}`, 'PATCH', { revision: data.reading.revision, text }));
  assert.equal(confirmed.paragraphs.length, 2);
  const classId = ok(await api('/api/reading-sessions', 'POST', { readingId: reading.id, tutorId: tutor.id })).id;
  let restored = ok(await api(`/api/reading-sessions/${classId}`));
  assert.equal(restored.session.learning.phase, 'free_reading');
  assert.equal(restored.messages.length, 0, 'a new reading classroom must start silently');
  assert.equal((await api(`/api/reading-sessions/${classId}/turn`, 'POST', { requestId: 'reading-empty-request-001', phase: 'free_reading', stateRevision: 0, paragraphIdx: 0, text: '' })).status, 400);
  const first = restored.reading.paragraphs[0];
  const quote = language === 'en' ? 'study' : '公園';
  const source = first.text;
  const quoteAt = source.indexOf(quote);
  const selection = { segments: [{ paragraphId: first.id, start: quoteAt, end: quoteAt + quote.length, quote, prefix: source.slice(Math.max(0, quoteAt - 16), quoteAt), suffix: source.slice(quoteAt + quote.length, quoteAt + quote.length + 16) }] };
  const annotation = created(await api(`/api/reading-sessions/${classId}/notes`, 'POST', { clientId: 'annotation-' + language, kind: 'annotation', content: '留意这里的表达。', selection }));
  assert.equal(annotation.selection.segments[0].quote, quote);
  const document = created(await api(`/api/reading-sessions/${classId}/notes`, 'POST', { clientId: 'document', kind: 'document', content: '自由阅读时想到的问题。' }));
  const updatedDocument = ok(await api(`/api/reading-sessions/${classId}/notes/${document.id}`, 'PATCH', { content: '补充全文读后感。', revision: document.revision }));
  assert.equal(updatedDocument.revision, document.revision + 1);
  assert.equal((await api(`/api/reading-sessions/${classId}/notes/${document.id}`, 'PATCH', { content: '覆盖旧内容', revision: document.revision })).status, 409);

  const turnRequest = { requestId: 'reading-free-request-0001', phase: 'free_reading', stateRevision: restored.session.learning.stateRevision, paragraphIdx: 0, selection, text: '请解释选中词语的语法。' };
  const output = await api(`/api/reading-sessions/${classId}/turn`, 'POST', turnRequest);
  const firstDone = done(output);
  assert.equal(firstDone.action, 'wait');
  assert.ok(output.value.some(e => e.type === 'message' && e.message.role === 'tutor' && e.message.speech));
  assert.ok(!output.value.some(e => e.type === 'message' && e.message.kind === 'exercise'));
  assert.deepEqual(done(await api(`/api/reading-sessions/${classId}/turn`, 'POST', turnRequest)).session.learning, firstDone.session.learning);
  assert.equal((await sql('select count(*)::int as count from reading_turns where session_id=$1 and request_id=$2', [classId, turnRequest.requestId]))[0].count, 1);
  assert.equal((await api(`/api/reading-sessions/${classId}/turn`, 'POST', { ...turnRequest, paragraphIdx: 1 })).status, 409);

  const beforePrepCount = ((await (await fetch('http://127.0.0.1:4107/requests')).json()).filter(r => JSON.stringify(r.messages).includes('完整阅读全文'))).length;
  const start = await api(`/api/reading-sessions/${classId}/analysis`, 'POST', { action: 'start', requestId: 'reading-analysis-start-0001', stateRevision: firstDone.session.learning.stateRevision });
  assert.ok([200, 202].includes(start.status));
  const prep = await waitLearningAnalysisStatus(classId, 'ready');
  assert.equal(prep.completedChunks, 1); assert.equal(prep.totalChunks, 1);
  restored = ok(await api(`/api/reading-sessions/${classId}`));
  assert.equal(restored.session.learning.phase, 'article_analysis');
  assert.equal(restored.session.learning.articleKind, 'general');
  assert.equal(restored.session.learning.articleKindSource, 'automatic');
  assert.equal(restored.session.learning.currentFocus, 'structure');
  assert.equal(((await (await fetch('http://127.0.0.1:4107/requests')).json()).filter(r => JSON.stringify(r.messages).includes('完整阅读全文')).length), beforePrepCount + 1);
  const analysisTurn = await api(`/api/reading-sessions/${classId}/turn`, 'POST', {
    requestId: 'reading-analysis-turn-0001', phase: 'article_analysis', stateRevision: restored.session.learning.stateRevision,
    focus: 'structure', paragraphIdx: 1, text: '请引导我分析文章结构。',
  });
  const analysisDone = done(analysisTurn);
  assert.ok(analysisTurn.value.some(e => e.type === 'analysis' && e.learning.analysisNotes.structure));
  assert.equal(analysisDone.session.currentIdx, 1, 'chat must not move the reading bookmark');
  assert.ok(analysisDone.session.learning.stateRevision > restored.session.learning.stateRevision);
  const confirmedFocus = ok(await api(`/api/reading-sessions/${classId}`, 'PATCH', { action: 'confirm_focus', stateRevision: analysisDone.session.learning.stateRevision }));
  assert.equal(confirmedFocus.learning.focusStatus.structure, 'confirmed');
  assert.equal(confirmedFocus.learning.currentFocus, 'writing');
  const literary = ok(await api(`/api/reading-sessions/${classId}`, 'PATCH', { action: 'set_article_kind', articleKind: 'literary', stateRevision: confirmedFocus.learning.stateRevision }));
  assert.equal(literary.learning.articleKind, 'literary');
  assert.equal(literary.learning.articleKindSource, 'user');
  const literaryFocus = ok(await api(`/api/reading-sessions/${classId}`, 'PATCH', { action: 'set_focus', focus: 'emotion', stateRevision: literary.learning.stateRevision }));
  assert.equal(literaryFocus.learning.currentFocus, 'emotion');
  const backToReading = ok(await api(`/api/reading-sessions/${classId}`, 'PATCH', { action: 'return_to_reading', stateRevision: literaryFocus.learning.stateRevision }));
  assert.equal(backToReading.learning.phase, 'free_reading');
  const resumeAnalysis = await api(`/api/reading-sessions/${classId}/analysis`, 'POST', { action: 'start', requestId: 'reading-analysis-start-0002', stateRevision: backToReading.learning.stateRevision });
  assert.equal(resumeAnalysis.status, 200, JSON.stringify(resumeAnalysis.value));
  assert.equal(resumeAnalysis.value.learning.articleKind, 'literary');
  assert.equal(resumeAnalysis.value.learning.focusStatus.structure, 'confirmed');
  assert.equal(resumeAnalysis.value.learning.currentFocus, 'writing');
  assert.equal(((await (await fetch('http://127.0.0.1:4107/requests')).json()).filter(r => JSON.stringify(r.messages).includes('完整阅读全文')).length), beforePrepCount + 1);

  ok(await api(`/api/readings/${reading.id}`, 'PATCH', { revision: confirmed.revision, text: 'Changed article.' }));
  assert.equal(ok(await api(`/api/reading-sessions/${classId}`)).reading.paragraphs[0].text, confirmed.paragraphs[0].text);
  readingIds.push({ readingId: reading.id, sessionId: classId, language });
}
pass('English and Japanese reading review, silent free-reading, verified text selection, private revisioned notes, guided analysis, literary focus, cached resume and snapshot isolation');
const imageReading = ok(await api('/api/readings', 'POST', { title: '图片文章', language: 'en' }));
ok(await api(`/api/readings/${imageReading.id}/sources`, 'POST', { dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') }));
assert.equal(done(await api(`/api/readings/${imageReading.id}/analyze`, 'POST', {})).reading.status, 'review');
pass('image article OCR uses analysis binding and requires source review');

const longParagraph = 'A'.repeat(1700);
const longParagraphs = Array.from({ length: 1002 }, (_, index) => index === 1001 ? 'LAST-READING-CHUNK-MARKER ' + 'B'.repeat(1700) : longParagraph);
const longPages = [longParagraphs.slice(0, 501).join('\n\n'), longParagraphs.slice(501).join('\n\n')];
assert.ok(longPages.every(page => Buffer.byteLength(page) < 1_500_000));
const longReading = ok(await api('/api/readings', 'POST', { title: '长文自动解析', language: 'en', expectedPageCount: 2 }));
for (const [idx, pageText] of longPages.entries()) {
  const uploaded = await api(`/api/readings/${longReading.id}/sources`, 'POST', { idx, dataUrl: 'data:text/plain;base64,' + Buffer.from(pageText).toString('base64') });
  assert.ok([200, 202].includes(uploaded.status), JSON.stringify(uploaded.value));
  if (idx === 0) {
    assert.equal((await api(`/api/readings/${longReading.id}/confirm`, 'POST', { revision: 0 })).status, 409);
    assert.equal((await api(`/api/readings/${longReading.id}`, 'PATCH', { revision: 0, text: longPages[0] })).status, 409);
  }
}
const longStatus = await waitReadingStatus(longReading.id, 'review');
assert.equal(longStatus.completedPages, 2); assert.equal(longStatus.totalPages, 2);
assert.ok(!JSON.stringify(longStatus).includes(longParagraph));
let page0 = ok(await api(`/api/readings/${longReading.id}/pages/0`));
let page1 = ok(await api(`/api/readings/${longReading.id}/pages/1`));
assert.ok(page0.recognized && page1.recognized);
ok(await api(`/api/readings/${longReading.id}/pages/0`, 'PATCH', { text: page0.text + '\n\nEdited page one.', revision: page0.revision }));
assert.equal((await api(`/api/readings/${longReading.id}/pages/1`, 'PATCH', { text: page1.text, revision: page1.revision })).status, 409);
const longReady = ok(await api(`/api/readings/${longReading.id}/confirm`, 'POST', { revision: 1 }));
assert.equal(longReady.status, 'ready');
const longCounts = (await sql('select octet_length(extracted) as bytes, jsonb_array_length(paragraphs) as paragraphs, count(*) filter (where value->>\'page\' = \'1\') as page_one, count(*) filter (where value->>\'page\' = \'2\') as page_two from readings, jsonb_array_elements(paragraphs) as value where id=$1 group by extracted, paragraphs', [longReading.id]))[0];
assert.ok(longCounts.bytes > 1_500_000); assert.equal(longCounts.paragraphs, 1003); assert.ok(Number(longCounts.page_one) > 500 && Number(longCounts.page_two) === 501);
const longClassroom = ok(await api('/api/reading-sessions', 'POST', { readingId: longReading.id, tutorId: tutor.id }));
const longBundle = ok(await api(`/api/reading-sessions/${longClassroom.id}`));
assert.equal(longBundle.reading.paragraphs.length, 1003);
await configure('audit-reading-chunk-once', 'audit-teach');
const longStart = await api(`/api/reading-sessions/${longClassroom.id}/analysis`, 'POST', { action: 'start', requestId: 'reading-long-start-0001', stateRevision: longBundle.session.learning.stateRevision });
assert.ok([200, 202].includes(longStart.status));
const interruptedAnalysis = await waitLearningAnalysisStatus(longClassroom.id, 'failed');
assert.ok(interruptedAnalysis.completedChunks > 10 && interruptedAnalysis.completedChunks < interruptedAnalysis.totalChunks);
assert.equal(interruptedAnalysis.resumable, true);
const partialAnalysis = (await sql('select analysis_draft from reading_sessions where id=$1', [longClassroom.id]))[0].analysis_draft;
assert.equal(Object.keys(partialAnalysis.chunks).length, interruptedAnalysis.completedChunks);
const requestsBeforeResume = await (await fetch('http://127.0.0.1:4107/requests')).json();
await configure('audit-plan', 'audit-teach');
const resume = await api(`/api/reading-sessions/${longClassroom.id}/analysis`, 'POST', { action: 'resume', requestId: 'reading-long-resume-001' });
assert.equal(resume.status, 202);
const longAnalysis = await waitLearningAnalysisStatus(longClassroom.id, 'ready');
assert.equal(longAnalysis.completedChunks, longAnalysis.totalChunks);
assert.ok(longAnalysis.totalChunks > 100);
const requestsAfterResume = await (await fetch('http://127.0.0.1:4107/requests')).json();
const resumedChunks = requestsAfterResume.slice(requestsBeforeResume.length).filter(request => request.messages?.[0]?.content?.includes('文章结构分析助手'));
assert.equal(resumedChunks.length, longAnalysis.totalChunks - interruptedAnalysis.completedChunks, 'resume only regenerates chunks not saved before the failure');
const fullAnalysis = (await sql('select analysis_draft from reading_sessions where id=$1', [longClassroom.id]))[0].analysis_draft;
assert.ok(fullAnalysis.context.includes('第 1-1003 段'));
const longReadySession = ok(await api(`/api/reading-sessions/${longClassroom.id}`));
assert.equal(longReadySession.session.learning.articleKind, 'general');
assert.ok(!JSON.stringify(longReadySession).includes('分析提要'), 'session load does not expose the full preparation draft');
const longTurn = done(await api(`/api/reading-sessions/${longClassroom.id}/turn`, 'POST', {
  requestId: 'reading-long-turn-0001', phase: 'article_analysis', stateRevision: longReadySession.session.learning.stateRevision,
  focus: 'structure', paragraphIdx: 0, text: '请结合整篇文章讨论结构。',
}));
assert.ok(longTurn.session.learning.analysisNotes.structure);
const compactReady = ok(await api(`/api/readings/${longReading.id}`));
assert.equal(compactReady.reading.paragraphs.length, 0); assert.equal(compactReady.reading.extracted, '');
pass('automatic OCR and whole-article context preparation for a 1.5 MB-plus article with 1,003 paragraphs; failed last chunk resumes without regenerating saved chunks, final analysis cites persisted context');

await configure('audit-reading-blank');
const blankReading = ok(await api('/api/readings', 'POST', { title: '空白页来源', language: 'ja', expectedPageCount: 2 }));
ok(await api(`/api/readings/${blankReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') }));
assert.equal((await api(`/api/readings/${blankReading.id}/sources`, 'POST', { idx: 1, dataUrl: 'data:text/plain;base64,' + Buffer.from('春の街を歩きます。').toString('base64') })).status, 202);
await waitReadingStatus(blankReading.id, 'review');
const blankPage = ok(await api(`/api/readings/${blankReading.id}/pages/0`));
assert.equal(blankPage.recognized, true); assert.equal(blankPage.blank, true); assert.equal(blankPage.text, '');
const blankReady = ok(await api(`/api/readings/${blankReading.id}/confirm`, 'POST', { revision: 0 }));
assert.equal(blankReady.status, 'ready');
const blankMapping = (await sql('select paragraphs->0->>\'page\' as page from readings where id=$1', [blankReading.id]))[0];
assert.equal(blankMapping.page, '2');
pass('an explicitly recognized blank page counts as complete and preserves the next source page number');

await configure('audit-reading-truncated');
const failedReading = ok(await api('/api/readings', 'POST', { title: '中断后续接', language: 'en', expectedPageCount: 1 }));
assert.equal((await api(`/api/readings/${failedReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') })).status, 202);
const failedStatus = await waitReadingStatus(failedReading.id, 'failed');
assert.equal(failedStatus.resumable, true); assert.equal(failedStatus.completedPages, 0);
await configure('audit-plan');
assert.equal((await api(`/api/readings/${failedReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(failedReading.id, 'review');
pass('truncated OCR retries twice, preserves progress and resumes in the background');

await configure('audit-reading-timeout');
const timeoutReading = ok(await api('/api/readings', 'POST', { title: '单页模型超时续接', language: 'en', expectedPageCount: 1 }));
assert.equal((await api(`/api/readings/${timeoutReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') })).status, 202);
const timeoutStatus = await waitReadingStatus(timeoutReading.id, 'failed', 15000);
assert.equal(timeoutStatus.completedPages, 0); assert.equal(timeoutStatus.resumable, true);
await configure('audit-plan');
assert.equal((await api(`/api/readings/${timeoutReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(timeoutReading.id, 'review');
pass('a per-page model timeout stops after bounded retries and resumes from the unsaved page');

const saveFailureReading = ok(await api('/api/readings', 'POST', { title: '逐页保存失败后续接', language: 'en', expectedPageCount: 1 }));
await sql(`create or replace function audit_reject_reading_draft() returns trigger language plpgsql as $$ begin if NEW.id = ${saveFailureReading.id} and NEW.draft is distinct from OLD.draft then raise exception 'simulated draft write failure'; end if; return NEW; end $$`);
await sql('create trigger audit_reject_reading_draft before update on readings for each row execute function audit_reject_reading_draft()');
assert.equal((await api(`/api/readings/${saveFailureReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:text/plain;base64,' + Buffer.from('Page saved only after the retry.').toString('base64') })).status, 202);
const saveFailedStatus = await waitReadingStatus(saveFailureReading.id, 'failed');
assert.equal(saveFailedStatus.completedPages, 0); assert.equal(saveFailedStatus.resumable, true);
await sql('drop trigger audit_reject_reading_draft on readings');
await sql('drop function audit_reject_reading_draft()');
assert.equal((await api(`/api/readings/${saveFailureReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(saveFailureReading.id, 'review');
assert.equal(ok(await api(`/api/readings/${saveFailureReading.id}/pages/0`)).text, 'Page saved only after the retry.');
pass('a database failure while saving a page retains resumable state and retries the unsaved page');

await configure('audit-slow');
const lockedReading = ok(await api('/api/readings', 'POST', { title: '识别操作锁', language: 'en', expectedPageCount: 1 }));
assert.equal((await api(`/api/readings/${lockedReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') })).status, 202);
assert.equal((await api(`/api/readings/${lockedReading.id}/analyze`, 'POST', { background: true })).status, 409);
await waitReadingStatus(lockedReading.id, 'review');
pass('a repeated background start returns 409 while the article lock is held');

const interruptedReading = ok(await api('/api/readings', 'POST', { title: '进程重启续接', language: 'en' }));
ok(await api(`/api/readings/${interruptedReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:text/plain;base64,' + Buffer.from('Already saved on page one.').toString('base64') }));
ok(await api(`/api/readings/${interruptedReading.id}/sources`, 'POST', { idx: 1, dataUrl: 'data:text/plain;base64,' + Buffer.from('Finish page two.').toString('base64') }));
let savedFirst = ok(await api(`/api/readings/${interruptedReading.id}/pages/0`));
ok(await api(`/api/readings/${interruptedReading.id}/pages/0`, 'PATCH', { text: 'Already saved on page one.', revision: savedFirst.revision }));
await sql("update readings set expected_page_count=2, status='analyzing', error='模拟应用重启' where id=$1", [interruptedReading.id]);
const interruptedStatus = ok(await api(`/api/readings/${interruptedReading.id}/analysis-status`));
assert.equal(interruptedStatus.running, false); assert.equal(interruptedStatus.resumable, true); assert.equal(interruptedStatus.completedPages, 1);
assert.equal((await api(`/api/readings/${interruptedReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(interruptedReading.id, 'review');
const resumedFirst = ok(await api(`/api/readings/${interruptedReading.id}/pages/0`));
const resumedSecond = ok(await api(`/api/readings/${interruptedReading.id}/pages/1`));
assert.equal(resumedFirst.text, 'Already saved on page one.'); assert.equal(resumedSecond.text, 'Finish page two.');
pass('a stale analyzing state with a released lock is reported as resumable after restart and completed pages are reused');

await sql("update readings set status='analyzing', error='模拟末页保存后重启' where id=$1", [interruptedReading.id]);
const finalPageSavedStatus = ok(await api(`/api/readings/${interruptedReading.id}/analysis-status`));
assert.equal(finalPageSavedStatus.completedPages, 2); assert.equal(finalPageSavedStatus.resumable, true);
assert.equal((await api(`/api/readings/${interruptedReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(interruptedReading.id, 'review');
assert.equal((await api(`/api/readings/${interruptedReading.id}/pages/0`)).value.text, 'Already saved on page one.');
assert.equal((await api(`/api/readings/${interruptedReading.id}/pages/1`)).value.text, 'Finish page two.');
pass('restart after the final page save can resume only the publication step');

const legacyRereading = ok(await api('/api/readings', 'POST', { title: '历史全文编辑与新版重识别', language: 'en', text: 'Original legacy source.' }));
let legacyConfirmed = ok(await api(`/api/readings/${legacyRereading.id}`, 'PATCH', { text: 'Reviewed legacy text.', revision: 0 }));
const legacySession = ok(await api('/api/reading-sessions', 'POST', { readingId: legacyRereading.id, tutorId: tutor.id }));
assert.equal((await api(`/api/readings/${legacyRereading.id}/analyze`, 'POST', { background: true, restart: true })).status, 202);
const rerecognizedStatus = await waitReadingStatus(legacyRereading.id, 'review');
assert.equal(rerecognizedStatus.revision, legacyConfirmed.revision + 1);
assert.equal((await api(`/api/readings/${legacyRereading.id}/confirm`, 'POST', { revision: legacyConfirmed.revision })).status, 409);
assert.equal(ok(await api(`/api/readings/${legacyRereading.id}/pages/0`)).text, 'Original legacy source.');
ok(await api(`/api/readings/${legacyRereading.id}/confirm`, 'POST', { revision: rerecognizedStatus.revision }));
assert.equal(ok(await api(`/api/reading-sessions/${legacySession.id}`)).reading.paragraphs[0].text, 'Reviewed legacy text.');
assert.equal((await api(`/api/readings/${legacyRereading.id}`, 'PATCH', { text: 'Obsolete full-text editor.', revision: 3 })).status, 409);
pass('legacy full-text editing and NDJSON stay compatible; background re-recognition switches to pages, invalidates old revisions and preserves classroom snapshots');

await configure('audit-slow');
const actualRestartReading = ok(await api('/api/readings', 'POST', { title: '实际进程重启续接', language: 'en', expectedPageCount: 2 }));
ok(await api(`/api/readings/${actualRestartReading.id}/sources`, 'POST', { idx: 0, dataUrl: 'data:text/plain;base64,' + Buffer.from('Preserve this saved first page.').toString('base64') }));
assert.equal((await api(`/api/readings/${actualRestartReading.id}/sources`, 'POST', { idx: 1, dataUrl: 'data:image/png;base64,' + fs.readFileSync('public/avatars/artoria.png').toString('base64') })).status, 202);
for (let attempt = 0; attempt < 50; attempt++) {
  const status = ok(await api(`/api/readings/${actualRestartReading.id}/analysis-status`));
  if (status.completedPages === 1 && status.running) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal((await fetch('http://127.0.0.1:4107/restart', { method: 'POST' })).status, 200);
let restarted = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(base + '/api/health')).ok) { restarted = true; break; } } catch { /* Wait for the owned child server. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(restarted, true);
const restartedStatus = ok(await api(`/api/readings/${actualRestartReading.id}/analysis-status`));
assert.equal(restartedStatus.running, false); assert.equal(restartedStatus.resumable, true); assert.equal(restartedStatus.completedPages, 1);
await configure('audit-plan');
assert.equal((await api(`/api/readings/${actualRestartReading.id}/analyze`, 'POST', { background: true })).status, 202);
await waitReadingStatus(actualRestartReading.id, 'review');
assert.equal(ok(await api(`/api/readings/${actualRestartReading.id}/pages/0`)).text, 'Preserve this saved first page.');
pass('an actual app-process restart releases the operation lock and manual resume reuses the previously saved source page');

fs.writeFileSync('output/audit/upgrade-api-results.json', JSON.stringify({ report, paperId, sessionId, readingIds }, null, 2));
console.log(JSON.stringify(report, null, 2));
