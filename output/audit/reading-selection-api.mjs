import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const reportedParagraph = 'For the first few years of the war in Ukraine, Russia’s hybrid warfare attacks in Europe remained just below the threshold that might trigger a collective response. As the United States’ permanent representative to NATO from 2021 to 2024, I watched the campaign develop: undersea cables cut, incendiary devices hidden in cargo packages, and arson attacks on weapons factories and depots across Europe. To address the threat, allies reinforced critical infrastructure, increased patrols in the Baltic Sea, and expanded intelligence sharing. But NATO’s approach remained largely defensive: these attacks were scattered, small in scale, and just deniable enough that Moscow could wave them away.';

export function anchorFor(paragraph, quote, occurrence = 0) {
  const source = paragraph.text.replace(/\*\*/g, '');
  const start = occurrence ? source.lastIndexOf(quote) : source.indexOf(quote);
  assert.ok(start >= 0, `Missing fixture quote: ${quote}`);
  return { paragraphId: paragraph.id, start, end: start + quote.length, quote,
    prefix: source.slice(Math.max(0, start - 40), start), suffix: source.slice(start + quote.length, start + quote.length + 40) };
}

export async function selectionFixture(api, tutorId, language = 'en') {
  const text = language === 'en'
    ? ['Unrelated opening paragraph.', 'Second paragraph.', 'Third paragraph.', 'Fourth paragraph.', 'Fifth paragraph.', reportedParagraph].join('\n\n')
    : ['第一段です。', '第二段です。', '第三段です。', '第四段です。', '第五段です。', '結果は**明らか**です。同じ結果について、後で明らかになることもあります。'].join('\n\n');
  const material = (await api('/api/readings', 'POST', { title: '划词解释回归 ' + language, language, text })).value;
  assert.ok(material.id);
  const recognized = await api(`/api/readings/${material.id}/analyze`, 'POST', {});
  assert.equal(recognized.status, 200);
  const review = (await api(`/api/readings/${material.id}`)).value;
  const confirmed = await api(`/api/readings/${material.id}`, 'PATCH', { revision: review.reading.revision, text });
  assert.equal(confirmed.status, 200);
  const started = (await api('/api/reading-sessions', 'POST', { readingId: material.id, tutorId })).value;
  const bundle = (await api(`/api/reading-sessions/${started.id}`)).value;
  assert.equal(bundle.messages.length, 0);
  assert.equal(bundle.reading.paragraphs.length, 6);
  const paragraph = bundle.reading.paragraphs[5];
  const selection = { segments: [anchorFor(paragraph, language === 'en' ? 'incendiary' : '明らか', language === 'ja' ? 1 : 0)] };
  return { id: started.id, readingId: material.id, bundle, selection };
}

export async function runReadingSelectionAudit({ api, sql, configure, tutor, report }) {
  const checks = [];
  const pass = test => { checks.push({ test, outcome: 'pass' }); report.push({ test, outcome: 'pass' }); };
  const mainRequests = async model => (await (await fetch('http://127.0.0.1:4107/requests')).json())
    .filter(request => request.model === model && String(request.messages[0].content).includes('本轮是学生主动发起的划词快捷任务'));
  await configure('audit-plan', 'audit-selection-normal');
  const fixture = await selectionFixture(api, tutor.id);
  const path = `/api/reading-sessions/${fixture.id}`;
  const savedNote = await api(path + '/notes', 'POST', { clientId: randomUUID(), kind: 'document', content: '这条个人笔记必须保持独立。' });
  assert.equal(savedNote.status, 201);
  const initial = (await api(path)).value;
  const request = (changes = {}) => ({ requestId: randomUUID(), phase: 'free_reading', stateRevision: initial.session.learning.stateRevision,
    paragraphIdx: 0, selection: fixture.selection, selectionTask: 'vocabulary', text: '请解释原文中“incendiary”在此处的含义和语境。', ...changes });
  const rowsFor = async body => (await sql(`SELECT t.status,t.action,count(m.id) FILTER (WHERE m.role='tutor')::int AS tutors,
    count(m.id) FILTER (WHERE m.role='user')::int AS users FROM reading_turns t LEFT JOIN reading_messages m ON m.turn_id=t.id
    WHERE t.session_id=$1 AND t.request_id=$2 GROUP BY t.id`, [fixture.id, body.requestId]))[0];
  const unchanged = async before => {
    const after = (await api(path)).value;
    assert.equal(after.session.currentIdx, before.session.currentIdx);
    assert.deepEqual(after.session.learning, before.session.learning);
    assert.deepEqual(after.session.progress, before.session.progress);
    assert.deepEqual(after.session.notes, before.session.notes);
    assert.deepEqual(after.personalNotes, before.personalNotes);
  };
  const successful = result => {
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.value));
    assert.equal(result.value.filter(event => event.type === 'done').length, 1);
    assert.equal(result.value.at(-1).type, 'done');
    assert.equal(result.value.at(-1).action, 'wait');
    assert.ok(!result.value.some(event => event.type === 'error' || event.type === 'analysis'));
    const tutorMessages = result.value.filter(event => event.type === 'message' && event.message.role === 'tutor').map(event => event.message);
    assert.equal(tutorMessages[0].kind, 'quote');
    assert.equal(tutorMessages[0].content, 'incendiary');
    assert.equal(tutorMessages[0].paragraphIdx, 5);
    assert.equal(tutorMessages[0].speech, '');
    assert.ok(tutorMessages.some(message => message.language === 'zh-CN' && message.content.includes('用于引燃或纵火')));
    assert.ok(!tutorMessages.some(message => message.content.includes('campaign 是') || message.content.includes('develop 在')));
  };
  const failed = result => {
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.value), JSON.stringify(result.value));
    assert.ok(result.value.some(event => event.type === 'error'));
    assert.ok(!result.value.some(event => event.type === 'done' || event.type === 'analysis' || event.type === 'message'));
  };

  await configure('audit-plan', 'audit-selection-retry');
  const firstRequest = request();
  const firstCount = (await mainRequests('audit-selection-retry')).length;
  successful(await api(path + '/turn', 'POST', firstRequest));
  const attempts = (await mainRequests('audit-selection-retry')).slice(firstCount);
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    const prompt = attempt.messages[0].content;
    assert.ok(prompt.includes('学生本轮的讲解目标'));
    assert.ok(prompt.includes('【incendiary】'));
    assert.ok(prompt.includes('辅助文章证据（不是学生选中的讲解目标）'));
    assert.ok(prompt.includes(`[段落 ID ${fixture.selection.segments[0].paragraphId}，第 6 段`));
    assert.ok(!prompt.includes('[段落 ID ' + initial.reading.paragraphs[0].id + '，第 1 段'));
  }
  assert.equal((await rowsFor(firstRequest)).status, 'success');
  assert.equal((await rowsFor(firstRequest)).tutors, 3);
  assert.equal((await rowsFor(firstRequest)).users, 1);
  await unchanged(initial);
  const replay = await api(path + '/turn', 'POST', firstRequest);
  successful(replay);
  assert.equal((await mainRequests('audit-selection-retry')).length, firstCount + 2);
  assert.equal((await api(path + '/turn', 'POST', { ...firstRequest, selectionTask: 'grammar' })).status, 409);
  pass('reported incendiary failure is retried once, committed atomically and replayed without a new model call');

  for (const model of ['audit-selection-wrong', 'audit-selection-malformed', 'audit-selection-wrong-paragraph', 'audit-selection-analysis-note']) {
    await configure('audit-plan', model);
    const body = request();
    const before = (await mainRequests(model)).length;
    failed(await api(path + '/turn', 'POST', body));
    assert.equal((await mainRequests(model)).length - before, 2, model);
    assert.equal((await rowsFor(body)).status, 'failed');
    assert.equal((await rowsFor(body)).tutors, 0);
    await unchanged(initial);
  }
  pass('permanent wrong targets, incomplete tags, wrong paragraph IDs and analysis-note leakage never save or emit tutor output');

  for (const body of [request({ selectionTask: 'invalid' }), request({ selection: null }), request({ selectionTask: null }),
    request({ images: ['data:image/png;base64,aGVsbG8='] }), request({ intent: 'continue' }), request({ selection: { segments: [{ ...fixture.selection.segments[0], quote: 'invented' }] } })]) {
    assert.equal((await api(path + '/turn', 'POST', body)).status, 400);
    assert.equal(await rowsFor(body), undefined);
  }
  pass('invalid quick task combinations and unverified anchors are rejected before creating a turn');

  for (const model of ['audit-selection-provider-error', 'audit-selection-provider-truncated', 'audit-selection-timeout']) {
    await configure('audit-plan', model);
    const body = request();
    const before = (await mainRequests(model)).length;
    failed(await api(path + '/turn', 'POST', body));
    assert.equal((await mainRequests(model)).length - before, 1, model);
    assert.equal((await rowsFor(body)).tutors, 0);
  }
  await configure('audit-plan', 'audit-selection-repair-error');
  const speechBody = request();
  const speechCount = (await mainRequests('audit-selection-repair-error')).length;
  successful(await api(path + '/turn', 'POST', speechBody));
  assert.equal((await mainRequests('audit-selection-repair-error')).length - speechCount, 1);
  const speechRows = await sql("SELECT speech FROM reading_messages m JOIN reading_turns t ON m.turn_id=t.id WHERE t.session_id=$1 AND t.request_id=$2 AND m.language='zh-CN'", [fixture.id, speechBody.requestId]);
  assert.ok(speechRows.every(row => row.speech === ''));
  pass('provider failures, truncation, timeout and speech repair failure do not regenerate the selection answer');

  await configure('audit-plan', 'audit-selection-normal');
  const dbBody = request();
  const dbCount = (await mainRequests('audit-selection-normal')).length;
  await sql(`CREATE OR REPLACE FUNCTION audit_selection_reject_text() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.session_id = ${fixture.id} AND NEW.role = 'tutor' AND NEW.kind = 'text' THEN RAISE EXCEPTION 'audit selection write failure'; END IF;
    RETURN NEW; END $$`);
  await sql('DROP TRIGGER IF EXISTS audit_selection_reject_text ON reading_messages');
  await sql('CREATE TRIGGER audit_selection_reject_text BEFORE INSERT ON reading_messages FOR EACH ROW EXECUTE FUNCTION audit_selection_reject_text()');
  try {
    failed(await api(path + '/turn', 'POST', dbBody));
    assert.equal((await mainRequests('audit-selection-normal')).length - dbCount, 1);
    assert.equal((await rowsFor(dbBody)).tutors, 0);
    assert.equal((await rowsFor(dbBody)).status, 'failed');
  } finally {
    await sql('DROP TRIGGER audit_selection_reject_text ON reading_messages');
    await sql('DROP FUNCTION audit_selection_reject_text()');
  }
  pass('a database failure rolls back even the first quote without generating a second answer');

  await configure('audit-plan', 'audit-selection-slow');
  const cancelBody = request();
  const abort = new AbortController();
  const cancelCount = (await mainRequests('audit-selection-slow')).length;
  const inflight = fetch('http://127.0.0.1:3107' + path + '/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cancelBody), signal: abort.signal }).then(response => response.text()).catch(error => error.name);
  for (let i = 0; i < 50 && (await mainRequests('audit-selection-slow')).length === cancelCount; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await mainRequests('audit-selection-slow')).length, cancelCount + 1);
  assert.equal((await api(path + '/turn', 'POST', request())).status, 409);
  abort.abort();
  assert.equal(await inflight, 'AbortError');
  for (let i = 0; i < 100 && (await rowsFor(cancelBody))?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await rowsFor(cancelBody)).status, 'cancelled');
  assert.equal((await rowsFor(cancelBody)).tutors, 0);
  assert.equal((await mainRequests('audit-selection-slow')).length, cancelCount + 1);
  await configure('audit-plan', 'audit-selection-normal');
  successful(await api(path + '/turn', 'POST', request()));
  await unchanged(initial);
  pass('concurrent turns receive 409 and cancelling a buffered candidate releases its lock without retry or tutor output');

  for (const [task, text] of [['vocabulary', '请解释我选中的词语在此处的含义和语境。'], ['grammar', '请分析我选中句子的语法结构和关键用法。'], ['meaning', '请用简洁中文说明我选中内容的句意。']]) {
    const legacy = request({ selectionTask: undefined, text });
    const result = await api(path + '/turn', 'POST', legacy);
    assert.equal(result.value.at(-1).type, 'done');
    const hash = createHash('sha256').update(JSON.stringify({ text, images: [], phase: 'free_reading', focus: null, intent: null, selection: fixture.selection, paragraphIdx: 0, stateRevision: initial.session.learning.stateRevision })).digest('hex');
    assert.equal((await sql('SELECT input_hash FROM reading_turns WHERE session_id=$1 AND request_id=$2', [fixture.id, legacy.requestId]))[0].input_hash, hash, task);
  }
  const historical = request({ selectionTask: undefined, text: '请解释我选中的词语在此处的含义和语境。', paragraphIdx: 5 });
  const historicalHash = createHash('sha256').update(JSON.stringify({ text: historical.text, images: [], phase: historical.phase, focus: null, intent: null, selection: fixture.selection, paragraphIdx: 5, stateRevision: historical.stateRevision })).digest('hex');
  const historicTurn = (await sql("INSERT INTO reading_turns (session_id,request_id,input_hash,phase,status,action) VALUES ($1,$2,$3,'free_reading','success','wait') RETURNING id", [fixture.id, historical.requestId, historicalHash]))[0];
  await sql("INSERT INTO reading_messages (session_id,turn_id,paragraph_idx,role,kind,language,content) VALUES ($1,$2,5,'tutor','text','zh-CN','旧版保留回复')", [fixture.id, historicTurn.id]);
  const historicCount = (await mainRequests('audit-selection-normal')).length;
  const history = await api(path + '/turn', 'POST', historical);
  assert.equal(history.value[0].message.content, '旧版保留回复');
  assert.equal(history.value.at(-1).type, 'done');
  assert.equal((await mainRequests('audit-selection-normal')).length, historicCount);
  pass('all legacy shortcuts infer their task without changing old hashes and pre-existing successful replies remain replayable');

  const preparation = await api(path + '/analysis', 'POST', { action: 'start', requestId: randomUUID(), stateRevision: initial.session.learning.stateRevision });
  assert.ok([200, 202].includes(preparation.status));
  for (let i = 0; i < 100; i++) {
    const status = (await api(path + '/analysis-status')).value;
    if (status.status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const analysis = (await api(path)).value;
  assert.equal(analysis.session.learning.phase, 'article_analysis');
  assert.equal(analysis.session.learning.currentFocus, 'structure');
  const inAnalysis = request({ phase: 'article_analysis', stateRevision: analysis.session.learning.stateRevision, focus: 'structure' });
  successful(await api(path + '/turn', 'POST', inAnalysis));
  await unchanged(analysis);
  assert.equal((await api(path + '/turn', 'POST', { ...inAnalysis, requestId: randomUUID(), focus: null })).status, 409);
  assert.equal((await api(path + '/turn', 'POST', { ...inAnalysis, requestId: randomUUID(), focus: 'writing' })).status, 409);
  for (const selectionTask of ['grammar', 'meaning']) {
    const result = await api(path + '/turn', 'POST', { ...inAnalysis, requestId: randomUUID(), selectionTask });
    assert.equal(result.value.at(-1).type, 'done');
    await unchanged(analysis);
  }
  pass('all three quick actions work in article analysis while preserving bookmark, focus, learner notes and revision guards');

  const japanese = await selectionFixture(api, tutor.id, 'ja');
  const ja = await api(`/api/reading-sessions/${japanese.id}/turn`, 'POST', { requestId: randomUUID(), phase: 'free_reading', stateRevision: 0, paragraphIdx: 0, selection: japanese.selection, selectionTask: 'vocabulary', text: '请解释选中词语。' });
  assert.equal(ja.value.at(-1).type, 'done');
  assert.equal(ja.value[0].message.language, 'ja');
  assert.equal(ja.value[0].message.content, '明らか');
  await configure('audit-plan', 'audit-selection-japanese-retry');
  const japaneseCount = (await mainRequests('audit-selection-japanese-retry')).length;
  const repairedJapanese = await api(`/api/reading-sessions/${japanese.id}/turn`, 'POST', { requestId: randomUUID(), phase: 'free_reading', stateRevision: 0, paragraphIdx: 0, selection: japanese.selection, selectionTask: 'vocabulary', text: '请解释选中词语。' });
  assert.equal(repairedJapanese.value.at(-1).type, 'done');
  const japaneseAttempts = (await mainRequests('audit-selection-japanese-retry')).slice(japaneseCount);
  assert.equal(japaneseAttempts.length, 2);
  assert.ok(japaneseAttempts[1].messages[0].content.includes('中文解释必须有完整的中文含义'));
  assert.ok(!repairedJapanese.value.some(event => event.type === 'message' && event.message.language === 'zh-CN' && event.message.content.includes('明らか')));
  await configure('audit-plan', 'audit-selection-normal');
  const across = { segments: [anchorFor(analysis.reading.paragraphs[4], 'Fifth'), ...fixture.selection.segments] };
  const multi = await api(path + '/turn', 'POST', { ...inAnalysis, requestId: randomUUID(), selection: across, selectionTask: 'meaning' });
  assert.equal(multi.value.at(-1).type, 'done');
  assert.deepEqual(multi.value.filter(event => event.type === 'message' && event.message.kind === 'quote').map(event => event.message.content), ['Fifth', 'incendiary']);
  await unchanged(analysis);
  pass('Japanese repeated phrases and multi-paragraph selected quotes keep their exact visible-text anchors; mixed-language explanations are regenerated once');

  fs.writeFileSync('output/audit/reading-selection-api-results.json', JSON.stringify({ report: checks, fixture: { sessionId: fixture.id, readingId: fixture.readingId }, japanese: { sessionId: japanese.id } }, null, 2));
}
