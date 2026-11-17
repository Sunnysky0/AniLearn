async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit harness');
  const sql = async (query, params = []) => {
    const res = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql: query, params } });
    if (!res.ok()) throw new Error('Fixture SQL failed');
    return res.json();
  };
  const [{ id, digest }] = await sql('SELECT id,md5(coverage::text) AS digest FROM sessions ORDER BY id DESC LIMIT 1');
  let modelCalls = 0;
  const turnBodies = [];
  page.on('request', request => { if (request.url().endsWith('/turn')) turnBodies.push(request.postDataJSON()); if (request.url().endsWith('/api/tts')) modelCalls++; });
  const before = (await (await page.request.get('http://127.0.0.1:4107/requests')).json()).length;
  await page.goto(base + '/classroom/' + id);
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  await page.getByRole('button', { name: '我懂了，下一题', exact: true }).click();
  await page.getByText('本课学习计划已完成', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  await page.getByText('本题已由你本人确认完成。', { exact: true }).waitFor();
  const [after] = await sql('SELECT status,md5(coverage::text) AS digest,completion_confirmations FROM sessions WHERE id=$1', [id]);
  if (after.status !== 'completed' || after.digest !== digest || !after.completion_confirmations['0']) throw new Error('Confirmation or coverage persistence failed');
  if (turnBodies.filter(body => body.intent === 'complete_problem').length !== 1 || modelCalls || (await (await page.request.get('http://127.0.0.1:4107/requests')).json()).length !== before) throw new Error('Manual confirmation unexpectedly invoked a model or TTS');
  await page.screenshot({ path: 'output/playwright/classroom-session25-confirmed.png' });
  return '复制的课堂25已确认最后一题，刷新保留确认且原coverage不变';
}
