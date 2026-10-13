import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:3107';
const mock = 'http://127.0.0.1:4107';
const marker = '.anilearn/books-live-smoke';
const results = [];
let savedSettings;
let stage = 'load configured services';
class ServiceUnavailable extends Error {}
async function sql(query, params = []) {
  const response = await fetch(mock + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) });
  if (!response.ok) throw new Error('Owned fixture operation failed');
  return response.json();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(280000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const text = await response.text();
  return response.headers.get('content-type')?.includes('ndjson') ? text.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(text);
}
try {
  // Read the production settings row only. Capture in memory; never print,
  // persist, or copy its secrets/environment files into the working checkout.
  const read = spawnSync('docker', ['exec', 'anilearn-postgres-1', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT data FROM app_settings WHERE id=1"'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (read.status !== 0) throw new ServiceUnavailable('Original configuration database is stopped or unavailable; it was not started for this validation.');
  const configured = JSON.parse(read.stdout.trim());
  const binding = configured.models?.chat;
  const connection = configured.connections?.find(item => item.id === binding?.connectionId);
  if (!connection?.apiKey?.trim()) throw new ServiceUnavailable('Configured database model key unavailable');
  savedSettings = (await sql('SELECT data FROM app_settings WHERE id=1'))[0].data;
  const isolated = { connections: [connection], models: { chat: binding, analysis: binding }, fish: configured.fish, autoContinue: false };
  await sql('UPDATE app_settings SET data=$1::jsonb WHERE id=1', [JSON.stringify(isolated)]);
  fs.mkdirSync('.anilearn', { recursive: true }); fs.writeFileSync(marker, 'owned live validation');
  const fixture = JSON.parse(fs.readFileSync('output/audit/books-browser-fixture.json', 'utf8'));
  stage = 'create isolated Plato classroom';
  const created = await api('/api/book-sessions', 'POST', { bookId: fixture.bookId, versionId: fixture.versionId, tutorId: fixture.tutorId });
  const bundle = await api(`/api/book-sessions/${created.id}`);
  const block = bundle.document.blocks.find(item => item.kind === 'paragraph' && /ION:/.test(item.anchorText) && item.anchorText.length > 30)
    ?? bundle.document.blocks.find(item => item.kind === 'paragraph' && item.anchorText.length > 100);
  assert.ok(block);
  const end = Math.min(220, block.anchorText.length);
  const quote = block.anchorText.slice(0, end).trim();
  const start = block.anchorText.indexOf(quote);
  const anchor = { version: 2, documentKey: bundle.document.key, unitId: bundle.document.unitId, segments: [{ blockId: block.id, start, end: start + quote.length, quote, prefix: block.anchorText.slice(Math.max(0, start - 36), start), suffix: block.anchorText.slice(start + quote.length, start + quote.length + 36) }] };
  const learning = bundle.session.chapters.find(item => item.chapterId === bundle.session.currentChapterId).learning;
  stage = 'Gemini exact-quote explanation';
  const started = Date.now();
  const events = await api(`/api/book-sessions/${created.id}/turn`, 'POST', { requestId: randomUUID(), versionId: fixture.versionId, chapterId: bundle.document.unitId, phase: learning.phase, stateRevision: learning.stateRevision, focus: learning.currentFocus, anchor, selectionTask: 'meaning', text: '' });
  assert.equal(events.at(-1).type, 'done');
  const messages = events.filter(event => event.type === 'message' && event.message.role === 'tutor').map(event => event.message);
  assert.equal(messages[0].kind, 'quote'); assert.equal(messages[0].content, quote); assert.equal(messages[0].speech, '');
  const explanation = messages.filter(message => message.kind === 'text');
  assert.ok(explanation.length > 0 && explanation.every(message => /\p{Script=Han}/u.test(message.content)));
  results.push({ test: stage, outcome: 'pass', model: binding.model, elapsedMs: Date.now() - started, sessionId: created.id, quote, explanations: explanation.map(message => ({ content: message.content, speech: message.speech })) });
  stage = 'Fish Japanese speech';
  if (!configured.fish?.enabled || !configured.fish?.apiKey?.trim()) throw new Error('Configured database Fish key unavailable');
  const message = explanation.find(item => item.speech); assert.ok(message);
  const response = await fetch(base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message.speech, voiceId: bundle.tutor.voiceId }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    results.push({ test: stage, outcome: 'fail', status: response.status, reason: String(detail.error ?? 'TTS request failed').replace(/(?:sk-|Bearer\s+)\S+/gi, '[redacted]').slice(0, 240) });
    process.exitCode = 1;
  } else {
    assert.ok(response.headers.get('content-type')?.includes('audio/'));
    const audio = Buffer.from(await response.arrayBuffer()); assert.ok(audio.length > 500);
    fs.mkdirSync('output/playwright', { recursive: true }); fs.writeFileSync('output/playwright/books-live-speech.mp3', audio);
    results.push({ test: stage, outcome: 'pass', bytes: audio.length, artifact: 'output/playwright/books-live-speech.mp3', listeningReview: 'not performed' });
  }
} catch (error) {
  results.push({ test: stage, outcome: error instanceof ServiceUnavailable ? 'unverified' : 'fail', reason: error instanceof ServiceUnavailable ? error.message : String(error.message).replace(/(?:sk-|Bearer\s+)\S+/gi, '[redacted]').slice(0, 300) });
  if (!(error instanceof ServiceUnavailable)) process.exitCode = 1;
} finally {
  if (savedSettings) await sql('UPDATE app_settings SET data=$1::jsonb WHERE id=1', [JSON.stringify(savedSettings)]);
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  fs.writeFileSync('output/audit/books-live-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
