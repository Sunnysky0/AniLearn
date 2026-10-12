async (page) => {
  const base = 'http://127.0.0.1:3107';
  const results = [], sent = [], bookmarks = [], tts = [], consoleErrors = [];
  let lastBookmark = 0;
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    ensure(response.ok(), path + ': ' + response.status());
    if (response.headers()['content-type']?.includes('application/x-ndjson')) return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
    return response.json();
  };
  const settings = await api('/api/settings');
  const configure = model => api('/api/settings', 'PUT', { models: { ...settings.models, chat: { connectionId: 'chat', model } }, fish: { enabled: true, apiKey: 'reading-selection-mock-fish-key' } });
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('request', request => {
    if (/\/reading-sessions\/\d+\/turn$/.test(request.url())) sent.push(request.postDataJSON());
    if (/\/reading-sessions\/\d+$/.test(request.url()) && request.method() === 'PATCH') bookmarks.push(request.postDataJSON());
  });
  const wav = Buffer.alloc(44 + 8000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.unroute('**/api/tts');
  await page.route('**/api/tts', async route => { tts.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }); });
  await page.addInitScript(() => {
    if (window.__readingSelectionRecorderInstalled) return;
    window.__readingSelectionRecorderInstalled = true;
    window.__readingSelectionResponses = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (/\/reading-sessions\/\d+\/turn$/.test(response.url)) {
        void response.clone().text().then(text => window.__readingSelectionResponses.push({ text, status: response.status }));
      }
      return response;
    };
  });
  const responseCount = () => page.evaluate(() => window.__readingSelectionResponses.length);
  const collectedResponse = async count => {
    await page.waitForFunction(count => window.__readingSelectionResponses.length > count, count);
    return page.evaluate(() => window.__readingSelectionResponses.at(-1));
  };
  await configure('audit-selection-retry');
  const tutor = (await api('/api/tutors')).find(item => item.name === '阿尔托莉雅');
  const text = ['An unrelated opening.', 'Second paragraph.', 'Third paragraph.', 'Fourth paragraph.', 'Fifth paragraph.',
    'I watched the campaign develop: undersea cables cut, incendiary devices hidden in cargo packages, and arson attacks.'].join('\n\n');
  const material = await api('/api/readings', 'POST', { title: '实际划词验收', language: 'en', text });
  await api(`/api/readings/${material.id}/analyze`, 'POST', {});
  const review = await api(`/api/readings/${material.id}`);
  await api(`/api/readings/${material.id}`, 'PATCH', { revision: review.reading.revision, text });
  const created = await api('/api/reading-sessions', 'POST', { readingId: material.id, tutorId: tutor.id });
  const path = `/api/reading-sessions/${created.id}`;
  let bundle = await api(path);
  const paragraphId = bundle.reading.paragraphs[5].id;
  const source = page.locator(`[data-reading-paragraph-text][data-paragraph-id="${paragraphId}"]`);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(base + '/reading-classroom/' + created.id);
  await page.getByText('自由阅读 · 等待你的提问', { exact: true }).waitFor();
  await source.waitFor();
  ensure(sent.length === 0 && tts.length === 0, 'Silent entry made a turn or TTS request');

  const selectWord = async () => {
    await page.evaluate(() => document.fonts.ready);
    await source.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const rect = await source.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const start = node.textContent.indexOf('incendiary');
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error('Selection word is absent from rendered text');
    });
    await page.mouse.dblclick(rect.x, rect.y);
    // Native word selection can include the following space; the product trims it.
    ensure(await page.evaluate(() => window.getSelection()?.toString().trim()) === 'incendiary', 'Native mouse selection selected a different span');
    await page.getByRole('button', { name: '解释词语', exact: true }).waitFor();
    // Scrolling deliberately updates the reading bookmark. Wait for that update
    // before proving that the question itself leaves the bookmark unchanged.
    await page.waitForFunction(() => {
      const article = document.querySelector('[data-reading-article]');
      const scroller = article.parentElement;
      const first = [...article.querySelectorAll('[data-reading-paragraph]')].find(element => element.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 90);
      return document.querySelector('[aria-label="查看段落"]').value === first?.dataset.readingParagraph;
    });
    lastBookmark = Number(await page.getByRole('combobox', { name: '查看段落' }).inputValue());
    for (let attempt = 0; attempt < 100 && (await api(path)).session.currentIdx !== lastBookmark; attempt++) await new Promise(resolve => setTimeout(resolve, 30));
    ensure((await api(path)).session.currentIdx === lastBookmark, 'Scroll bookmark did not settle before the question');
  };
  const quick = async (label, task) => {
    await selectWord();
    const count = await responseCount();
    await page.getByRole('button', { name: label, exact: true }).click();
    const events = (await collectedResponse(count)).text.trim().split('\n').filter(Boolean).map(JSON.parse);
    await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
    const body = sent.at(-1);
    ensure(body.selectionTask === task && body.paragraphIdx === lastBookmark, 'Quick request changed task or bookmark');
    ensure(body.selection.segments[0].paragraphId === paragraphId && body.selection.segments[0].quote === 'incendiary', 'Quick request lost the selected anchor');
    ensure(body.text.includes('incendiary'), 'Displayed question omitted the selected text');
    return events;
  };
  const accepted = await quick('解释词语', 'vocabulary');
  ensure(accepted.at(-1).type === 'done', 'Retry did not complete');
  ensure(accepted[0].message.content === 'incendiary', 'Rejected context quote reached the browser');
  ensure(!accepted.some(event => event.type === 'message' && /campaign 是|develop 在/.test(event.message.content)), 'Wrong explanation reached the browser');
  ensure(tts.length > 0 && tts.every(item => item.text.includes('火をつける')), 'Rejected speech or foreign quote reached TTS');
  bundle = await api(path);
  ensure(bundle.session.currentIdx === lastBookmark && lastBookmark !== 5, 'Question moved the bookmark to selected paragraph');
  ensure(bookmarks.every(item => item.action !== 'bookmark' || item.currentIdx !== 5), 'Question issued a selected-paragraph bookmark update');
  await page.screenshot({ path: 'output/playwright/reading-selection-desktop.png' });
  results.push({ test: 'desktop real selection, one retry, accepted-only TTS and independent bookmark', outcome: 'pass' });
  const restoredBookmark = lastBookmark;
  await page.reload();
  await source.waitFor();
  ensure((await api(path)).session.currentIdx === restoredBookmark, 'Refresh lost bookmark');
  ensure((await page.getByText('原文选区：incendiary', { exact: true }).count()) === 1, 'Refresh lost the saved selection');

  await configure('audit-selection-normal');
  for (const [label, task] of [['分析语法', 'grammar'], ['说明句意', 'meaning']]) {
    ensure((await quick(label, task)).at(-1).type === 'done', label + ' failed');
  }
  results.push({ test: 'all three quick actions and refresh recovery', outcome: 'pass' });
  const readingState = (await api(path)).session.learning;
  await api(path + '/analysis', 'POST', { action: 'start', stateRevision: readingState.stateRevision, requestId: crypto.randomUUID() });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await api(path + '/analysis-status')).status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await page.reload(); await source.waitFor();
  const analysisBefore = (await api(path)).session;
  ensure(analysisBefore.learning.currentFocus === 'structure', 'Analysis fixture is not ready');
  ensure((await quick('解释词语', 'vocabulary')).at(-1).type === 'done', 'Analysis quick action failed');
  ensure(sent.at(-1).focus === 'structure', 'Analysis quick action omitted current focus');
  const analysisAfter = (await api(path)).session;
  ensure(JSON.stringify(analysisAfter.learning) === JSON.stringify(analysisBefore.learning), 'Quick action changed analysis state');
  ensure(analysisAfter.currentIdx === lastBookmark, 'Analysis question moved the bookmark');
  results.push({ test: 'article-analysis quick action retains current focus and learning state', outcome: 'pass' });

  await configure('audit-selection-wrong');
  const beforeError = (await api(path)).messages.length;
  const beforeTTS = tts.length;
  ensure((await quick('解释词语', 'vocabulary')).at(-1).type === 'error', 'Permanent invalid output was accepted');
  await page.getByRole('alert').filter({ hasText: '导师回复没有准确引用当前选区' }).waitFor();
  ensure(tts.length === beforeTTS, 'Rejected answer synthesized speech');
  ensure((await api(path)).messages.length === beforeError + 1, 'Rejected answer saved tutor messages');
  await page.screenshot({ path: 'output/playwright/reading-selection-rejected.png' });
  await configure('audit-selection-normal');
  const retryCount = await responseCount();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  ensure((await collectedResponse(retryCount)).text.includes('"type":"done"'), 'Manual retry failed');
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  results.push({ test: 'permanent failure has no tutor output/TTS and manual retry retains its selection', outcome: 'pass' });

  await selectWord();
  await page.getByRole('button', { name: '自由提问', exact: true }).click();
  await page.getByRole('textbox', { name: '课堂消息' }).fill('这里为什么使用这个形容词？');
  const freeCount = await responseCount();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  ensure((await collectedResponse(freeCount)).text.includes('"type":"done"'), 'Free-form selected question failed');
  ensure(sent.at(-1).selectionTask === undefined && sent.at(-1).selection.segments[0].quote === 'incendiary', 'Free-form selection incorrectly became a quick task');
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  results.push({ test: 'free-form selected questions preserve their original behavior', outcome: 'pass' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  ensure((await quick('解释词语', 'vocabulary')).at(-1).type === 'done', 'Mobile quick action failed');
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile page overflows horizontally');
  await page.screenshot({ path: 'output/playwright/reading-selection-mobile.png' });
  await page.reload();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await source.waitFor();
  ensure((await api(path)).session.currentIdx === lastBookmark, 'Mobile refresh lost bookmark');
  ensure(consoleErrors.length === 0, consoleErrors.join('\n'));
  results.push({ test: 'mobile layout, actual selection and refresh recovery', outcome: 'pass' });
  await page.unroute('**/api/tts');
  return { results, sessionId: created.id, ttsRequests: tts.length, sentTasks: sent.map(item => item.selectionTask ?? 'free-form'), consoleErrors };
}
