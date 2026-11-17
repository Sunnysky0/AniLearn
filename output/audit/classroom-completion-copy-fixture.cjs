// Copies one user's saved classroom into the disposable audit database; never writes the source database.
const { loadEnvConfig } = require('@next/env');
const { Pool } = require('pg');
loadEnvConfig(process.cwd());
const source = new Pool({ connectionString: process.env.DATABASE_URL });
const targetUrl = new URL(process.env.DATABASE_URL);
targetUrl.pathname = '/anilearn_audit_20261007';
const target = new Pool({ connectionString: targetUrl.href });
(async () => {
  try {
    const s = (await source.query('SELECT * FROM sessions WHERE id=$1', [25])).rows[0];
    if (!s?.snapshot || s.plan.units.length !== 1) throw new Error('Expected a one-unit classroom snapshot');
    const messages = (await source.query('SELECT role,kind,content,speech,problem_idx,attachments,created_at FROM messages WHERE session_id=$1 ORDER BY id', [25])).rows;
    const boards = (await source.query('SELECT problem_idx,title,blocks FROM boards WHERE session_id=$1', [25])).rows;
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('INSERT INTO sessions(paper_id,tutor_id,current_idx,status,progress,snapshot,coverage,completion_confirmations,plan,plan_revision) VALUES(1,1,$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [s.current_idx, s.status, s.progress, s.snapshot, s.coverage, s.completion_confirmations, s.plan, s.plan_revision])).rows[0];
      for (const m of messages) await client.query('INSERT INTO messages(session_id,role,kind,content,speech,problem_idx,attachments,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [row.id, m.role, m.kind, m.content, m.speech, m.problem_idx, JSON.stringify(m.attachments), m.created_at]);
      for (const b of boards) await client.query('INSERT INTO boards(session_id,problem_idx,title,blocks) VALUES($1,$2,$3,$4)', [row.id, b.problem_idx, b.title, JSON.stringify(b.blocks)]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ fixtureId: row.id, messageCount: messages.length, boardCount: boards.length }));
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } finally { await source.end(); await target.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
