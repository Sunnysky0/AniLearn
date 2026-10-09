import assert from 'node:assert/strict';
import fs from 'node:fs';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/anilearn_audit_20261007';
process.env.DATABASE_URL = url.href;
const sql = async (query, params = []) => {
  const response = await fetch('http://127.0.0.1:4107/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) });
  assert.equal(response.status, 200); return response.json();
};
const [original] = await sql("select id from tutors where name='阿尔托莉雅' and is_preset=true");
assert.ok(original);
const before = await sql('select id,tutor_id from sessions where tutor_id=$1 order by id', [original.id]);
assert.ok(before.length);
await sql("update tutors set name='小樱',avatar='/avatars/sakura.png',voice_id='legacy',subject='英语',tags='[\"英语\",\"语文\"]'::jsonb where id=$1", [original.id]);
await sql("update tutors set personality=replace(personality,'对概念、证据和推导要求严谨','对物理概念和推导要求严谨'),teaching_style=replace(teaching_style,'先建立思考框架，辨明条件与依据，再规范推导','先建立物理模型，做受力/运动/能量分析，再规范推导') where name='远坂凛' and is_preset=true");
const { ensureSeed, listTutors } = await import('../../src/lib/server/data.ts');
const { pool } = await import('../../src/db/index.ts');
try {
  await ensureSeed();
  const tutors = await listTutors();
  const artoria = tutors.find(t => t.id === original.id);
  assert.equal(artoria.name, '阿尔托莉雅');
  assert.equal(artoria.avatar, '/avatars/artoria.png');
  assert.equal(artoria.voiceId, '4aa42286f3844a29a243e2ebd29f815f');
  assert.equal(artoria.subject, undefined);
  const after = await sql('select id,tutor_id from sessions where tutor_id=$1 order by id', [original.id]);
  assert.deepEqual(after, before);
  const rin = tutors.find(t => t.name === '远坂凛');
  assert.ok(!rin.personality.includes('对物理概念') && !rin.teachingStyle.includes('先建立物理模型'));
  const report = [{ test: 'legacy Sakura migrates in place; ID and session associations retained; preset subject wording removed', outcome: 'pass' }];
  fs.writeFileSync('output/audit/upgrade-tutor-migration-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await pool.end(); }
