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
    await page.getByRole('button', { name: '上传文章并自动识别', exact: true }).click();
    await page.waitForURL(/\/readings\/\d+$/);
    const id = Number(page.url().split('/').at(-1));
    await page.getByText('识别完成，请校对后确认', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="当前页校对原文"]')?.value.length > 10);
    await page.getByRole('button', { name: '确认全部原文', exact: true }).click();
    await page.getByText('文章原文已确认', { exact: true }).waitFor();
    const data = await api('/api/readings/' + id);
    ensure(data.reading.pageCount === (source === 'pdf' ? 2 : 1), 'Reading source page count mismatch');
    const [storedReading] = await sql('select status, jsonb_array_length(paragraphs) as paragraph_count from readings where id=$1', [id]);
    ensure(storedReading.status === 'ready' && storedReading.paragraph_count >= 2, 'Reading paragraphs were not confirmed');
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
  for (const [name, pages] of [['seventeen-pages.pdf', 17], ['hundred-pages.pdf', 100]]) {
    const uploadPage = await page.context().newPage();
    await uploadPage.goto(base + '/readings/new');
    await uploadPage.locator('input[type=file]').setInputFiles('output/audit/' + name);
    await uploadPage.getByText(`共 ${pages} 个来源页 · 不限页数`, { exact: true }).waitFor({ timeout: 180000 });
    await uploadPage.getByRole('button', { name: '上传文章并自动识别', exact: true }).click();
    await uploadPage.waitForURL(/\/readings\/\d+$/);
    const id = Number(uploadPage.url().split('/').at(-1));
    await uploadPage.close();
    await page.goto(base + '/readings');
    const deadline = Date.now() + 60000;
    let status;
    while (Date.now() < deadline) {
      status = await api(`/api/readings/${id}/analysis-status`);
      if (status.status === 'review' || status.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ensure(status?.status === 'review' && status.completedPages === pages, `${pages}-page OCR did not finish after leaving the article page`);
    await page.goto(base + '/readings/' + id);
    await page.getByRole('button', { name: '确认全部原文', exact: true }).click();
    await page.getByText('文章原文已确认', { exact: true }).waitFor();
    const [storedReading] = await sql('select status, (select count(*)::int from reading_sources where reading_id=$1) as source_count, jsonb_array_length(paragraphs) as paragraph_count from readings where id=$1', [id]);
    ensure(storedReading.status === 'ready' && storedReading.source_count === pages && storedReading.paragraph_count === pages * 2, `${pages}-page article did not preserve all pages and paragraphs`);
    if (pages === 100) {
      await page.screenshot({ path: 'output/playwright/reading-hundred-page-review.png', fullPage: true });
      await page.getByLabel('阅读导师').selectOption(String(tutor.id));
      await page.getByRole('button', { name: '开始导读', exact: true }).click();
      await page.waitForURL(/\/reading-classroom\/\d+$/);
      await page.getByRole('button', { name: '进入阅读课堂' }).click();
      await page.locator('#paragraph-0').waitFor();
      ensure(await page.locator('[id^="paragraph-"]').count() === 50, 'Long reading rendered more than one 50-paragraph group');
      await page.getByLabel('段落组').selectOption('1');
      await page.locator('#paragraph-50').waitFor();
      ensure(await page.locator('[id^="paragraph-"]').count() === 50 && await page.locator('#paragraph-99').count() === 1, 'Long reading did not switch to the next 50-paragraph group');
      await page.screenshot({ path: 'output/playwright/reading-fifty-paragraph-group.png' });
    }
    results.push({ test: `${pages}-page PDF uploads without a cap, completes in the background after closing its tab and confirms in source order`, outcome: 'pass' });
  }
  await page.goto(base + '/readings/new');
  await page.getByLabel('文章标题').fill('混合来源上传续传测试');
  const image = await (await page.request.get(base + '/avatars/artoria.png')).body();
  const mixedFiles = [
    { name: 'first-page.md', mimeType: 'text/markdown', buffer: Buffer.from('First source page stays first.') },
    ...Array.from({ length: 12 }, (_, index) => ({ name: `page-${index + 2}.png`, mimeType: 'image/png', buffer: image })),
  ];
  await page.locator('input[type=file]').setInputFiles(mixedFiles);
  await page.getByText('共 13 个来源页 · 不限页数', { exact: true }).waitFor();
  let interrupted = false;
  await page.route('**/api/readings/*/sources', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    if (body.idx === 4 && !interrupted) {
      interrupted = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传中断' }) });
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button', { name: '上传文章并自动识别', exact: true }).click();
  await page.getByRole('alert').getByText('模拟上传中断', { exact: true }).waitFor();
  ensure(interrupted, 'Upload retry fixture did not interrupt a source page');
  await page.getByRole('button', { name: '续传未完成来源', exact: true }).click();
  await page.waitForURL(/\/readings\/\d+$/);
  await page.unroute('**/api/readings/*/sources');
  const mixedId = Number(page.url().split('/').at(-1));
  await page.getByText('识别完成，请校对后确认', { exact: true }).waitFor({ timeout: 30000 });
  const mixedSources = await api(`/api/readings/${mixedId}`);
  ensure(mixedSources.sources.length === 13 && mixedSources.sources[0].mime === 'text/markdown' && mixedSources.sources[1].mime === 'image/jpeg', 'Mixed source order or MIME was not preserved');
  ensure((await api(`/api/readings/${mixedId}/analysis-status`)).completedPages === 13, 'Mixed upload did not finish every page');
  results.push({ test: '13 mixed sources upload in order without a cap, retry idempotently after interruption and auto-analyze after the last page', outcome: 'pass' });
  ensure(errors.length === 0, errors.join('\n'));
  await page.evaluate(r => localStorage.setItem('upgrade-plan-source-results', JSON.stringify(r)), results);
  return results;
}
