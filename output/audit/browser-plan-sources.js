async (page) => {
  const base = 'http://127.0.0.1:3107';
  const results = [], errors = [];
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  page.on('pageerror', error => errors.push(error.message));
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    ensure(response.ok(), path + ': ' + response.status()); return response.json();
  };
  const sql = async (query, params = []) => {
    const response = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql: query, params } });
    ensure(response.ok(), 'Isolated fixture query failed'); return response.json();
  };
  const settings = await api('/api/settings');
  const configure = (analysis = 'audit-plan') => api('/api/settings', 'PUT', {
    models: { chat: { ...settings.models.chat, model: 'audit-teach' }, analysis: { ...settings.models.analysis, model: analysis } }, fish: { enabled: false },
  });
  await configure();
  await page.setViewportSize({ width: 1440, height: 960 });
  const tutor = (await api('/api/tutors')).find(t => t.name === '阿尔托莉雅');
  const paper = await api('/api/papers', 'POST', { title: '课堂计划浏览器测试', subject: '数学' });
  await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:text/markdown;base64,' + Buffer.from('四道代表题').toString('base64') });
  const analyzed = await page.request.post(base + `/api/papers/${paper.id}/analyze`, { data: {} });
  ensure((await analyzed.text()).includes('"type":"done"'), 'Analysis failed');
  const session = await api('/api/sessions', 'POST', { paperId: paper.id, tutorId: tutor.id });
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.getByRole('button', { name: '老师更新了板书', exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('讲解档位').selectOption('challenge');
  await page.getByText('需要补充解析：第4题', { exact: true }).waitFor();
  let [stored] = await sql('select plan,pending_plan from sessions where id=$1', [session.id]);
  ensure(stored.plan.pace === 'focused' && stored.pending_plan.pace === 'challenge', 'Unconfirmed plan applied');
  await page.getByRole('button', { name: '取消调整', exact: true }).click();
  await page.getByText('需要补充解析：第4题', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByLabel('讲解档位').selectOption('challenge');
  await page.getByText('需要补充解析：第4题', { exact: true }).waitFor();
  await configure('audit-plan-incomplete');
  await page.getByRole('button', { name: '确认补充解析', exact: true }).click();
  await page.getByText('模型输出达到长度上限，内容未完成，请重试或更换模型。', { exact: true }).waitFor();
  [stored] = await sql('select plan,pending_plan from sessions where id=$1', [session.id]);
  ensure(stored.plan.pace === 'focused' && stored.pending_plan.pace === 'challenge', 'Failed plan replaced original');
  await configure();
  await page.getByRole('button', { name: '确认补充解析', exact: true }).click();
  await page.getByText('需要补充解析：第4题', { exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('select[aria-label="讲解档位"]').value === 'challenge');
  ensure(await page.getByLabel('讲解档位').inputValue() === 'challenge', 'Pace not updated');
  [stored] = await sql('select plan,current_idx,snapshot from sessions where id=$1', [session.id]);
  ensure(stored.current_idx === 2 && stored.snapshot.problems[3].analysis === 'ready', 'Supplement details or index missing');
  ensure((await page.getByRole('region', { name: '对话', exact: true }).innerText()).includes('第 3 题 · 方程式'), 'New divider missing from client chat');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '课程目录', exact: true }).click();
  await page.getByText('未纳入本课', { exact: true }).first().waitFor();
  await page.screenshot({ path: 'output/playwright/upgrade-plan-directory.png' });
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTitle('课堂设置', { exact: true }).click();
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Plan settings overflow on mobile');
  await page.screenshot({ path: 'output/playwright/upgrade-plan-mobile.png' });
  results.push({ test: 'classroom pace selection, explicit supplement, cancel, failure/retry, atomic update, divider and mobile layout', outcome: 'pass' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await api('/api/settings', 'PUT', { models: { chat: { ...settings.models.chat, model: 'audit-finish-full' }, analysis: { ...settings.models.analysis, model: 'audit-plan' } } });
  for (let i = 0; i < 2; i++) {
    const response = await page.request.post(base + `/api/sessions/${session.id}/turn`, { data: { planVersion: stored.plan.version } });
    ensure((await response.text()).includes('"type":"done"'), 'Could not complete selected plan');
  }
  await configure();
  await page.reload();
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('讲解档位').selectOption('advanced');
  await page.waitForFunction(() => document.querySelector('select[aria-label="讲解档位"]').value === 'advanced');
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Expanded goals kept completed exit state');
  [stored] = await sql('select status,progress from sessions where id=$1', [session.id]);
  ensure(stored.status === 'active' && stored.progress['2'] === 'active', 'Expanded goals did not reopen classroom');
  results.push({ test: 'completed plan can add goals and resume without retaining completed exit state', outcome: 'pass' });
  for (const source of ['pdf', 'image', 'text', 'paste']) {
    await page.goto(base + '/readings/new');
    await page.getByLabel('文章标题').fill(source + ' source browser test');
    if (source === 'pdf') await page.locator('input[type=file]').setInputFiles('output/audit/two-pages.pdf');
    if (source === 'image') await page.locator('input[type=file]').setInputFiles('public/avatars/artoria.png');
    if (source === 'text') await page.locator('input[type=file]').setInputFiles({ name: 'article.txt', mimeType: 'text/plain', buffer: Buffer.from('Scientists study how cities change.\n\nTheir work helps communities plan for the future.') });
    if (source === 'paste') await page.getByLabel('文章原文', { exact: true }).fill('Scientists study how cities change.\n\nTheir work helps communities plan for the future.');
    await page.getByRole('button', { name: '上传文章', exact: true }).click();
    await page.waitForURL(/\/readings\/\d+$/);
    const id = Number(page.url().split('/').at(-1));
    await page.getByRole('button', { name: '识别原文', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea').value.length > 10);
    await page.getByRole('button', { name: '确认原文', exact: true }).click();
    await page.getByText('原文已确认', { exact: true }).waitFor();
    const data = await api('/api/readings/' + id);
    ensure(data.reading.pageCount === (source === 'pdf' ? 2 : 1), 'Reading source page count mismatch');
    ensure(data.reading.paragraphs.length >= 2, 'Reading paragraph IDs missing');
    if (source === 'image') {
      await page.getByLabel('阅读导师').selectOption(String(tutor.id));
      await page.getByRole('button', { name: '开始导读', exact: true }).click();
      await page.waitForURL(/\/reading-classroom\/\d+$/);
      const readingSessionId = Number(page.url().split('/').at(-1));
      await page.getByRole('button', { name: '进入阅读课堂' }).click();
      await page.waitForFunction(() => !document.querySelector('button[aria-label="打断"]'));
      await page.getByRole('button', { name: '从此段阅读', exact: true }).nth(1).click();
      await page.getByText('第 2 段 · 陪伴导读', { exact: true }).waitFor();
      ensure((await api('/api/reading-sessions/' + readingSessionId)).session.progress['1'] === 'active', 'Jump did not activate unread paragraph');
    }
    results.push({ test: 'reading ' + source + ' upload, OCR/source review and stable paragraphs', outcome: 'pass' });
  }
  await page.goto(base + '/readings/new');
  await page.locator('input[type=file]').setInputFiles('output/audit/seventeen-pages.pdf');
  await page.getByText(/PDF 共 17 页，每篇文章最多 12 个来源页/).waitFor();
  ensure(await page.getByRole('button', { name: '上传文章', exact: true }).isDisabled(), 'Oversized article accepted');
  results.push({ test: 'reading PDF page limit rejects oversized source', outcome: 'pass' });
  ensure(errors.length === 0, errors.join('\n'));
  await page.evaluate(r => localStorage.setItem('upgrade-plan-source-results', JSON.stringify(r)), results);
  return results;
}
