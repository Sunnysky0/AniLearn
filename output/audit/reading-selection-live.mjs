import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import nextEnv from '@next/env';
import { anchorFor } from './reading-selection-api.mjs';

// This smoke runs source Route Handlers against the owned audit database so the
// deterministic harness's accelerated timeout does not limit real model calls.
const owner = JSON.parse(fs.readFileSync('audit-owner.json', 'utf8'));
assert.equal(owner.task, 'reading-selection-fix');
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const sourceUrl = new URL(process.env.DATABASE_URL);
assert.equal(sourceUrl.port, String(owner.postgresPort));
assert.equal(owner.composeProject, 'anilearn_selection_audit_20261012');
const auditUrl = new URL(sourceUrl);
auditUrl.pathname = '/anilearn_audit_20261007';
const source = new Client({ connectionString: sourceUrl.href });
const audit = new Client({ connectionString: auditUrl.href });
const results = [];
let priorSettings;
let appPool;
let failed = false;
try {
  await source.connect(); await audit.connect();
  assert.equal((await audit.query('SELECT current_database() AS name')).rows[0].name, 'anilearn_audit_20261007');
  await source.query('BEGIN READ ONLY');
  const liveSettings = (await source.query('SELECT data FROM app_settings WHERE id=1')).rows[0]?.data;
  const original = (await source.query("SELECT snapshot,tutor_id FROM reading_sessions WHERE snapshot->>'title' ILIKE '%russias-hybrid-war%' ORDER BY id LIMIT 1")).rows[0];
  assert.ok(liveSettings && original, 'Saved real configuration or reported material is unavailable');
  await source.query('ROLLBACK');
  priorSettings = (await audit.query('SELECT data FROM app_settings WHERE id=1')).rows[0].data;
  await audit.query('UPDATE app_settings SET data=$1 WHERE id=1', [liveSettings]);
  process.env.DATABASE_URL = auditUrl.href;
  const { POST } = await import('../../src/app/api/reading-sessions/[id]/turn/route.ts');
  const { initialReadingLearningState } = await import('../../src/lib/server/readings.ts');
  const { pool } = await import('../../src/db/index.ts');
  appPool = pool;
  const custom = (title, language, text) => ({ id: 0, title, language, status: 'ready', paragraphs: [{ id: 'live-p1', text, page: 1 }],
    extracted: text, overview: '', error: null, revision: 0, createdAt: new Date().toISOString(), pageCount: 1 });
  const cases = [
    { name: 'reported incendiary selection', reading: original.snapshot, quote: 'incendiary', expected: /燃烧|纵火|引燃|引火/ },
    { name: 'English bank in financial context', reading: custom('金融语境', 'en', 'She deposited her savings at the bank before applying for a loan.'), quote: 'bank', expected: /银行|金融机构/ },
    { name: 'Japanese 明らか selection', reading: custom('日语词义', 'ja', '証拠を確認すると、原因は明らかになった。'), quote: '明らか', expected: /明确|清楚|明白|明显|清晰|显然/ },
  ];
  for (const item of cases) {
    const reading = item.reading;
    const paragraph = reading.paragraphs.find(paragraph => paragraph.text.includes(item.quote));
    assert.ok(paragraph);
    const selection = { segments: [anchorFor(paragraph, item.quote)] };
    const material = (await audit.query("INSERT INTO readings (title,language,status,paragraphs,extracted) VALUES ($1,$2,'ready',$3,$4) RETURNING id", [reading.title, reading.language, JSON.stringify(reading.paragraphs), reading.extracted])).rows[0];
    const learning = initialReadingLearningState({ status: 'active', progress: { 0: 'active' }, notes: {} });
    learning.legacy = null;
    const session = (await audit.query('INSERT INTO reading_sessions (reading_id,tutor_id,snapshot,learning_state,progress) VALUES ($1,$2,$3,$4,$5) RETURNING id', [material.id, original.tutor_id, reading, learning, { 0: 'active' }])).rows[0];
    const requestId = randomUUID();
    const started = Date.now();
    const response = await POST(new Request('http://127.0.0.1:3107/api/reading-sessions/' + session.id + '/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, phase: 'free_reading', stateRevision: learning.stateRevision, paragraphIdx: 0, selection, selectionTask: 'vocabulary', text: `请解释原文中“${item.quote}”在此处的含义和语境。` }) }), { params: Promise.resolve({ id: String(session.id) }) });
    const events = (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
    const messages = events.filter(event => event.type === 'message').map(event => event.message);
    const Chinese = messages.filter(message => message.language === 'zh-CN').map(message => message.content);
    const entry = { test: item.name, model: liveSettings.models.chat.model, elapsedMs: Date.now() - started, outcome: 'fail', Chinese, quotes: messages.filter(message => message.kind === 'quote').map(message => message.content), speech: messages.filter(message => message.language === 'zh-CN').map(message => message.speech) };
    results.push(entry);
    assert.equal(response.status, 200);
    assert.equal(events.at(-1)?.type, 'done', events.find(event => event.type === 'error')?.error);
    assert.equal(entry.quotes[0], item.quote);
    assert.ok(item.expected.test(Chinese.join('\n')), 'Expected contextual meaning was absent');
    assert.equal((await audit.query('SELECT current_idx FROM reading_sessions WHERE id=$1', [session.id])).rows[0].current_idx, 0);
    entry.outcome = 'pass';
    console.log(JSON.stringify(entry));
  }
} catch (error) {
  failed = true;
  console.error('LIVE_SELECTION_SMOKE_FAILED: ' + error.message);
} finally {
  if (priorSettings) await audit.query('UPDATE app_settings SET data=$1 WHERE id=1', [priorSettings]);
  if (appPool) await appPool.end();
  await source.end(); await audit.end();
  fs.writeFileSync('output/audit/reading-selection-live-results.json', JSON.stringify({ results, outcome: failed ? 'fail' : 'pass' }, null, 2));
}
process.exit(failed ? 1 : 0);
