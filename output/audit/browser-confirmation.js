async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit harness');
  const results = [];
  const requests = [];
  page.on('request', request => { if (request.url().endsWith('/turn')) requests.push(request.postDataJSON()); });
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    if (!response.ok()) throw new Error(`${path}: ${response.status()}`);
    return response.json();
  };
  const sql = async (query, params = []) => {
    const response = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql: query, params } });
    if (!response.ok()) throw new Error('Fixture SQL failed');
    return response.json();
  };
  const makeSession = async () => (await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 })).id;
  const enter = async id => {
    await page.goto(base + '/classroom/' + id);
    await page.getByRole('button', { name: '继续上课', exact: true }).click();
  };
  const saved = (await sql('SELECT data FROM app_settings WHERE id=1'))[0].data;
  const id = await makeSession();
  await sql('UPDATE sessions SET current_idx=1,progress=$2::jsonb WHERE id=$1', [id, JSON.stringify({ 0: 'done', 1: 'active' })]);
  await sql("INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,'tutor','text','这一步先观察等式两边的关系。',1)", [id]);
  await sql('DELETE FROM app_settings WHERE id=1');
  await enter(id);
  await page.getByRole('button', { name: '我懂了，下一题', exact: true }).click();
  await page.getByText('本课学习计划已完成', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  if (!await page.getByText('本人确认完成', { exact: true }).count() && !await page.getByText('本题已由你本人确认完成。', { exact: true }).count()) throw new Error('Confirmation missing after reload');
  const [finished] = await sql('SELECT status,completion_confirmations FROM sessions WHERE id=$1', [id]);
  if (finished.status !== 'completed' || !finished.completion_confirmations['1']) throw new Error('Confirmation not persisted');
  results.push('无模型配置时确认最后一题，刷新后保留本人确认');
  await sql('INSERT INTO app_settings(id,data) VALUES(1,$1::jsonb)', [JSON.stringify(saved)]);

  const slow = await makeSession();
  await sql("INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,'tutor','text','请先独立尝试解方程。',0)", [slow]);
  const settings = await api('/api/settings');
  await api('/api/settings', 'PUT', { autoContinue: false, models: { ...settings.models, chat: { ...settings.models.chat, model: 'audit-slow' } } });
  await enter(slow);
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor();
  const confirm = page.getByRole('button', { name: '我懂了，下一题', exact: true });
  await confirm.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'), null, { timeout: 30000 });
  const [after] = await sql('SELECT progress,current_idx,completion_confirmations FROM sessions WHERE id=$1', [slow]);
  if (after.progress['0'] !== 'done' || after.progress['1'] === 'done' || after.current_idx !== 1 || !after.completion_confirmations['0']) throw new Error('Interrupted confirmation advanced incorrectly');
  if (!requests.some(request => request.intent === 'complete_problem' && request.problemIdx === 0)) throw new Error('Confirmation target missing');
  results.push('生成中连点确认通过有序中断完成原题且不推进后续题');
  await page.screenshot({ path: 'output/playwright/classroom-confirmation.png' });
  return results;
}
