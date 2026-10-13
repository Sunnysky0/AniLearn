import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import nextEnv from '@next/env';
import { recoveryEpub } from './book-fixture.cjs';

const base = 'http://127.0.0.1:3107';
const mock = 'http://127.0.0.1:4107';
const report = [];
const pass = test => report.push({ test, outcome: 'pass' });
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let value;
  try { value = response.headers.get('content-type')?.includes('ndjson') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(raw); }
  catch { throw new Error(`Invalid response at ${path}, status ${response.status}`); }
  return { status: response.status, value };
}
const ok = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.value).slice(0, 400)); return result.value; };
async function sql(query, params = []) { const r = await fetch(mock + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) }); assert.equal(r.status, 200); return r.json(); }
async function waitStatus(path, expected, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = ok(await api(path)); if (value.status === expected) return value; if (value.status === 'failed' && expected !== 'failed') throw new Error(value.error); await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out waiting for ${expected} at ${path}`);
}
async function configure(model = 'audit-book-normal') {
  ok(await api('/api/settings', 'PUT', { connections: [{ id: 'books', name: '隔离典籍模型', protocol: 'openai-compatible', baseUrl: mock + '/v1', apiKey: 'books-audit-dummy-key' }], models: { chat: { connectionId: 'books', model }, analysis: { connectionId: 'books', model } }, fish: { enabled: false } }));
}
function bodyFor(bundle, changes = {}) {
  const learning = bundle.session.chapters.find(chapter => chapter.chapterId === bundle.session.currentChapterId).learning;
  return { requestId: randomUUID(), versionId: bundle.session.versionId, chapterId: bundle.session.currentChapterId, phase: learning.phase, stateRevision: learning.stateRevision, focus: learning.currentFocus, text: '请结合原文解释这里的论证。', ...changes };
}
function done(result) { const events = ok(result); assert.ok(Array.isArray(events)); assert.equal(events.at(-1).type, 'done', JSON.stringify(events).slice(0, 400)); return events; }
async function main() {
  await configure(); const tutors = ok(await api('/api/tutors')); const tutor = tutors[0]; assert.ok(tutor);
  const beforeRequests = (await (await fetch(mock + '/requests')).json()).length;
  const listing = ok(await api('/api/books')); const plato = listing.books.find(book => book.builtinKey === 'selected-dialogues-of-plato');
  assert.ok(plato && plato.status === 'ready'); assert.equal(plato.language, 'en'); assert.equal(plato.kind, 'thought');
  const repeated = ok(await api('/api/books')); assert.equal(repeated.books.filter(book => book.builtinKey === plato.builtinKey).length, 1);
  assert.equal((await (await fetch(mock + '/requests')).json()).length, beforeRequests);
  let material = ok(await api(`/api/books/${plato.id}?versionId=${plato.currentVersionId}`)); const originalVersion = material.version.id;
  const mainChapters = material.chapters.filter(chapter => chapter.role === 'main');
  assert.deepEqual(mainChapters.map(chapter => chapter.title.toLowerCase()), ['ion', 'protagoras', 'phaedrus', 'symposium', 'apology']);
  for (const chapter of mainChapters) { const doc = ok(await api(`/api/books/${plato.id}/versions/${originalVersion}/chapters/${chapter.id}`)); assert.ok(doc.blocks.length > 30); assert.ok(doc.blocks.reduce((n, block) => n + block.anchorText.length, 0) > 10000); }
  const firstDocument = ok(await api(`/api/books/${plato.id}/versions/${originalVersion}/chapters/${mainChapters[0].id}`));
  assert.ok(Object.keys(firstDocument.footnotes).length > 100); assert.ok(firstDocument.blocks.some(block => JSON.stringify(block.nodes).includes('footnote')));
  const image = await fetch(base + plato.coverUrl); assert.equal(image.status, 200); assert.ok(image.headers.get('content-type').startsWith('image/'));
  pass('built-in Plato idempotency, five complete dialogues, old-style footnotes and cover');
  const created = ok(await api('/api/book-sessions', 'POST', { bookId: plato.id, versionId: originalVersion, tutorId: tutor.id })); const sid = created.id;
  let bundle = ok(await api(`/api/book-sessions/${sid}`)); assert.equal(bundle.document.unitId, mainChapters[0].id); assert.equal(bundle.messages.length, 0);
  assert.equal((await (await fetch(mock + '/requests')).json()).length, beforeRequests);
  const block = bundle.document.blocks.find(block => block.anchorText.length > 100 && block.kind === 'paragraph'); assert.ok(block);
  const quote = block.anchorText.slice(0, 20).trim(); const quoteStart = block.anchorText.indexOf(quote);
  const anchor = { version: 2, documentKey: bundle.document.key, unitId: bundle.document.unitId, segments: [{ blockId: block.id, start: quoteStart, end: quoteStart + quote.length, quote, prefix: block.anchorText.slice(0, quoteStart), suffix: block.anchorText.slice(quoteStart + quote.length, quoteStart + quote.length + 36) }] };
  const position = { documentKey: bundle.document.key, unitId: bundle.document.unitId, blockId: block.id, offset: 10, viewportOffset: 50 };
  ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'bookmark', chapterId: mainChapters[0].id, position }));
  const request = bodyFor(bundle, { anchor, selectionTask: 'meaning' }); const events = done(await api(`/api/book-sessions/${sid}/turn`, 'POST', request));
  const tutorEvents = events.filter(event => event.type === 'message' && event.message.role === 'tutor');
  assert.equal(tutorEvents[0].message.kind, 'quote'); assert.equal(tutorEvents[0].message.content, quote); assert.equal(tutorEvents[0].message.speech, '');
  const replay = done(await api(`/api/book-sessions/${sid}/turn`, 'POST', request)); assert.deepEqual(replay.filter(event => event.type === 'message').map(event => event.message.id), events.filter(event => event.type === 'message').map(event => event.message.id));
  bundle = ok(await api(`/api/book-sessions/${sid}`)); assert.deepEqual(bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id).position, position);
  assert.equal(bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id).learning.readingConfirmedAt, null);
  assert.equal((await api(`/api/book-sessions/${sid}/turn`, 'POST', { ...request, text: 'changed request' })).status, 409);
  assert.equal((await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle, { anchor: { ...anchor, documentKey: 'obsolete' } }))).status, 400);
  const attachment = 'data:image/png;base64,' + fs.readFileSync('public/avatars/rin.png').toString('base64');
  const imageEvents = done(await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle, { text: '', images: [attachment] })));
  const userImage = imageEvents.find(event => event.type === 'message' && event.message.role === 'user').message;
  assert.equal(userImage.attachmentCount, 1); assert.ok(!userImage.attachments[0].startsWith('data:'));
  const restoredImage = await fetch(base + userImage.attachments[0]); assert.equal(restoredImage.status, 200); assert.equal(restoredImage.headers.get('content-type'), 'image/png');
  assert.equal((await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle, { text: '超'.repeat(4001) }))).status, 400);
  bundle = ok(await api(`/api/book-sessions/${sid}`));
  const notes = [];
  for (const kind of ['annotation', 'chapter', 'book']) notes.push(ok(await api(`/api/book-sessions/${sid}/notes`, 'POST', { kind, chapterId: mainChapters[0].id, clientId: randomUUID(), content: '我的个人笔记不会被导师覆盖。', ...(kind === 'annotation' ? { anchor } : {}) })));
  const updated = ok(await api(`/api/book-sessions/${sid}/notes/${notes[0].id}`, 'PATCH', { revision: notes[0].revision, content: '修订后的私人批注。' }));
  assert.equal((await api(`/api/book-sessions/${sid}/notes/${notes[0].id}`, 'PATCH', { revision: notes[0].revision, content: '过期内容' })).status, 409);
  const second = ok(await api('/api/book-sessions', 'POST', { bookId: plato.id, versionId: originalVersion, tutorId: tutors[1]?.id ?? tutor.id }));
  assert.equal(ok(await api(`/api/book-sessions/${second.id}/notes`)).notes.find(note => note.id === updated.id).content, updated.content);
  assert.equal((await api(`/api/book-sessions/${sid}/summary`, 'POST', { requestId: randomUUID() })).status, 409);
  pass('silent session, exact selection, success replay, independent bookmark, stale notes and cross-tutor ownership');
  const count = bundle.messages.length; await configure('audit-book-selection-wrong');
  const rejected = ok(await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle, { anchor, selectionTask: 'meaning' })));
  assert.ok(rejected.some(event => event.type === 'error')); assert.ok(!rejected.some(event => event.type === 'message' && event.message.role === 'tutor'));
  assert.equal(ok(await api(`/api/book-sessions/${sid}`)).messages.filter(message => message.role === 'tutor').length, bundle.messages.filter(message => message.role === 'tutor').length);
  assert.ok(count > 0); await configure();
  // Put conspicuous later-chapter data into owned fixtures to assert context isolation.
  await sql("UPDATE book_chapter_states SET learning=jsonb_set(jsonb_set(learning,'{memory}',to_jsonb('FUTURE-CHAPTER-SENTINEL'::text)),'{readingConfirmedAt}',to_jsonb('now'::text)) WHERE session_id=$1 AND chapter_id=$2", [sid, mainChapters[4].id]);
  ok(await api(`/api/book-sessions/${sid}/notes`, 'POST', { kind: 'book', clientId: randomUUID(), content: 'WHOLE-NOTE-SENTINEL' }));
  const contextStart = (await (await fetch(mock + '/requests')).json()).length;
  bundle = ok(await api(`/api/book-sessions/${sid}`)); done(await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle)));
  const modelInputs = (await (await fetch(mock + '/requests')).json()).slice(contextStart);
  assert.ok(!JSON.stringify(modelInputs).includes('FUTURE-CHAPTER-SENTINEL')); assert.ok(!JSON.stringify(modelInputs).includes('WHOLE-NOTE-SENTINEL'));
  pass('selection rejection is atomic and later chapter/private whole-book notes stay out of model context');
  let learning = bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id).learning;
  ok(await api(`/api/book-sessions/${sid}/analysis`, 'POST', { action: 'start', requestId: randomUUID(), chapterId: mainChapters[0].id, stateRevision: learning.stateRevision }));
  await waitStatus(`/api/book-sessions/${sid}/analysis-status`, 'ready');
  for (const focus of ['concepts', 'argument', 'implications']) {
    bundle = ok(await api(`/api/book-sessions/${sid}`)); const state = bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id);
    assert.equal(state.learning.currentFocus, focus); done(await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle)));
    bundle = ok(await api(`/api/book-sessions/${sid}`)); learning = bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id).learning;
    assert.ok(learning.analysisNotes[focus]); ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'confirm_focus', chapterId: mainChapters[0].id, stateRevision: learning.stateRevision }));
  }
  bundle = ok(await api(`/api/book-sessions/${sid}`)); done(await api(`/api/book-sessions/${sid}/turn`, 'POST', bodyFor(bundle, { intent: 'chapter_summary', text: '' })));
  bundle = ok(await api(`/api/book-sessions/${sid}`)); learning = bundle.session.chapters.find(chapter => chapter.chapterId === mainChapters[0].id).learning;
  assert.ok(learning.summary); assert.equal(learning.completedAt, null);
  ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'complete_analysis', chapterId: mainChapters[0].id, stateRevision: learning.stateRevision }));
  for (const chapter of mainChapters.slice(1)) {
    bundle = ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'chapter', chapterId: chapter.id }));
    learning = bundle.session.chapters.find(state => state.chapterId === chapter.id).learning;
    ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'confirm_reading', chapterId: chapter.id, stateRevision: learning.stateRevision }));
  }
  ok(await api(`/api/book-sessions/${sid}/summary`, 'POST', { action: 'start', requestId: randomUUID() }));
  assert.ok((await waitStatus(`/api/book-sessions/${sid}/summary-status`, 'ready')).summary);
  pass('explicit chapter focuses, chapter completion and whole-book summary after reading-only chapters');
  material = ok(await api(`/api/books/${plato.id}?versionId=${originalVersion}`));
  const edited = ok(await api(`/api/books/${plato.id}/versions/${originalVersion}`, 'PATCH', { revision: material.version.revision, chapters: material.version.chapters.map((chapter, index) => ({ ...chapter, title: index === 0 ? '校对后的前言' : chapter.title })) }));
  assert.notEqual(edited.version.id, originalVersion);
  const savedDraft = ok(await api(`/api/books/${plato.id}/versions/${edited.version.id}`, 'PATCH', { revision: edited.version.revision, chapters: edited.version.chapters }));
  assert.equal((await api(`/api/books/${plato.id}/versions/${edited.version.id}`, 'PATCH', { revision: edited.version.revision, chapters: edited.version.chapters })).status, 409);
  ok(await api(`/api/books/${plato.id}/versions/${edited.version.id}/confirm`, 'POST', { revision: savedDraft.version.revision }));
  assert.equal(ok(await api(`/api/book-sessions/${sid}`)).session.versionId, originalVersion);
  assert.equal(ok(await api('/api/books')).books.filter(book => book.builtinKey === plato.builtinKey).length, 1);
  const newVersionSession = ok(await api('/api/book-sessions', 'POST', { bookId: plato.id, tutorId: tutor.id }));
  const newVersionBundle = ok(await api(`/api/book-sessions/${newVersionSession.id}`));
  assert.equal(newVersionBundle.session.versionId, edited.version.id); assert.equal(newVersionBundle.notes.length, 0); assert.equal(newVersionBundle.messages.length, 0);
  pass('directory revisions publish a new immutable version and preserve old classrooms');
  // Hold only an owned audit connection, with an explicit database check.
  nextEnv.loadEnvConfig(process.cwd());
  const auditDatabaseUrl = new URL(process.env.DATABASE_URL); auditDatabaseUrl.pathname = '/anilearn_audit_20261007';
  const pool = new Pool({ connectionString: auditDatabaseUrl.href }); const connection = await pool.connect();
  try {
    assert.equal((await connection.query('SELECT current_database() AS db')).rows[0].db, 'anilearn_audit_20261007');
    await connection.query('SELECT pg_advisory_lock(17428,$1)', [sid]);
    assert.equal((await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'chapter', chapterId: mainChapters[0].id })).status, 409);
    await connection.query('SELECT pg_advisory_unlock(17428,$1)', [sid]);
    await connection.query('SELECT pg_advisory_lock(17429,$1)', [second.id]);
    const prior = ok(await api(`/api/book-sessions/${second.id}`)); const priorLearning = prior.session.chapters.find(chapter => chapter.chapterId === prior.session.currentChapterId).learning;
    assert.equal((await api(`/api/book-sessions/${second.id}/analysis`, 'POST', { action: 'start', requestId: randomUUID(), chapterId: prior.session.currentChapterId, stateRevision: priorLearning.stateRevision })).status, 409);
    const after = ok(await api(`/api/book-sessions/${second.id}`));
    assert.deepEqual(after.session.chapters.find(chapter => chapter.chapterId === prior.session.currentChapterId).learning, priorLearning);
    await sql("UPDATE book_chapter_states SET learning=jsonb_set(learning,'{readingConfirmedAt}',to_jsonb('now'::text)) WHERE session_id=$1", [second.id]);
    assert.equal((await api(`/api/book-sessions/${second.id}/summary`, 'POST', { action: 'start', requestId: randomUUID() })).status, 409);
    assert.equal(ok(await api(`/api/book-sessions/${second.id}/summary-status`)).status, 'idle');
  }
  finally { await connection.query('SELECT pg_advisory_unlock(17428,$1)', [sid]); await connection.query('SELECT pg_advisory_unlock(17429,$1)', [second.id]); connection.release(); await pool.end(); }
  ok(await api(`/api/book-sessions/${sid}`, 'PATCH', { action: 'chapter', chapterId: mainChapters[0].id }));
  pass('generation and chapter mutation respect independent advisory locks and release');
  for (const [fileName, filePath] of [['Plato upload.epub', 'books/Selected Dialogues of Plato.epub'], ['Plato conversion.mobi', '.anilearn/books-fixtures/plato.mobi']]) {
    const form = new FormData(); form.set('file', new File([fs.readFileSync(filePath)], fileName)); form.set('kind', 'thought'); form.set('requestId', randomUUID());
    const upload = await fetch(base + '/api/books', { method: 'POST', body: form }); assert.ok(upload.status === 202 || upload.status === 200); const added = await upload.json();
    await waitStatus(`/api/books/${added.book.id}/analysis-status`, 'review'); const review = ok(await api(`/api/books/${added.book.id}`));
    assert.ok(review.version.chapters.filter(chapter => chapter.role === 'main').length >= 5);
    ok(await api(`/api/books/${added.book.id}/versions/${review.version.id}/confirm`, 'POST', { revision: review.version.revision }));
    const retriedUpload = await fetch(base + '/api/books', { method: 'POST', body: form });
    assert.equal(retriedUpload.status, 200); assert.equal((await retriedUpload.json()).book.id, added.book.id);
  }
  pass('real multipart EPUB and Calibre MOBI conversion import, directory review and publication');
  const recoveryForm = new FormData(); recoveryForm.set('file', new File([recoveryEpub()], 'recovery.epub')); recoveryForm.set('kind', 'thought');
  const recoveryUpload = await fetch(base + '/api/books', { method: 'POST', body: recoveryForm }); assert.equal(recoveryUpload.status, 202); const recoveryBook = await recoveryUpload.json();
  await waitStatus(`/api/books/${recoveryBook.book.id}/analysis-status`, 'review'); const recoveryMaterial = ok(await api(`/api/books/${recoveryBook.book.id}`));
  ok(await api(`/api/books/${recoveryBook.book.id}/versions/${recoveryMaterial.version.id}/confirm`, 'POST', { revision: recoveryMaterial.version.revision }));
  const recoverySession = ok(await api('/api/book-sessions', 'POST', { bookId: recoveryBook.book.id, tutorId: tutor.id }));
  let recoveryBundle = ok(await api(`/api/book-sessions/${recoverySession.id}`)); const recoveryChapter = recoveryBundle.session.currentChapterId;
  await configure('audit-book-chunk-once');
  ok(await api(`/api/book-sessions/${recoverySession.id}/analysis`, 'POST', { action: 'start', requestId: randomUUID(), chapterId: recoveryChapter, stateRevision: 0 }));
  const failedPreparation = await waitStatus(`/api/book-sessions/${recoverySession.id}/analysis-status`, 'failed'); assert.ok(failedPreparation.completedChunks > 0 && failedPreparation.completedChunks < failedPreparation.totalChunks);
  assert.ok(!JSON.stringify(failedPreparation).includes('Recovery paragraph'));
  // Only the harness-owned child restarts. Production on port 3000 is outside this harness.
  assert.equal((await fetch(mock + '/restart', { method: 'POST' })).status, 200);
  const restartUntil = Date.now() + 30000; let health = false;
  while (Date.now() < restartUntil) { try { health = (await fetch(base + '/api/health')).ok; } catch {} if (health) break; await new Promise(resolve => setTimeout(resolve, 150)); }
  assert.ok(health, 'Owned preview failed to restart');
  recoveryBundle = ok(await api(`/api/book-sessions/${recoverySession.id}`)); assert.equal(recoveryBundle.session.chapters.find(chapter => chapter.chapterId === recoveryChapter).analysis.status, 'failed');
  await configure(); const preparationRequests = (await (await fetch(mock + '/requests')).json()).length;
  ok(await api(`/api/book-sessions/${recoverySession.id}/analysis`, 'POST', { action: 'resume', requestId: randomUUID(), chapterId: recoveryChapter }));
  await waitStatus(`/api/book-sessions/${recoverySession.id}/analysis-status`, 'ready');
  const resumedRequests = (await (await fetch(mock + '/requests')).json()).slice(preparationRequests).filter(request => String(request.messages[0].content).includes('[BOOK_CHUNK]'));
  assert.equal(resumedRequests.length, failedPreparation.totalChunks - failedPreparation.completedChunks);
  pass('long chapter failure survives actual owned process restart and resumes only unsaved chunks');
  const badForm = new FormData(); badForm.set('file', new File([new Uint8Array([1, 2, 3])], 'broken.epub')); badForm.set('kind', 'thought');
  const badResponse = await fetch(base + '/api/books', { method: 'POST', body: badForm }); const bad = await badResponse.json(); assert.equal(badResponse.status, 202);
  assert.ok((await waitStatus(`/api/books/${bad.book.id}/analysis-status`, 'failed')).resumable);
  pass('broken import retains a resumable failure without publishing incomplete content');
  const noteBeforeMigration = (await sql('SELECT content,revision FROM book_personal_notes WHERE id=$1', [updated.id]))[0];
  const migration = fs.readFileSync('docs/migrations/20261013-books-shared-reader.sql', 'utf8').split(';').filter(statement => statement.trim());
  for (let run = 0; run < 2; run++) for (const statement of migration) await sql(statement);
  assert.deepEqual((await sql('SELECT content,revision FROM book_personal_notes WHERE id=$1', [updated.id]))[0], noteBeforeMigration);
  pass('additive migration can be reapplied without altering saved classrooms or notes');
  fs.writeFileSync('output/audit/books-browser-fixture.json', JSON.stringify({ bookId: plato.id, versionId: originalVersion, tutorId: tutor.id, chapterIds: mainChapters.map(chapter => chapter.id) }));
}
try { await main(); }
catch (error) { report.push({ test: 'books API audit', outcome: 'fail', error: error.message, stack: error.stack }); process.exitCode = 1; }
finally { fs.writeFileSync('output/audit/books-api-results.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
