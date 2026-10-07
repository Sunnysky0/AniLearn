async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('UI audit requires the isolated harness');
  const results = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = async (path, method, data) => {
    const response = await page.request.fetch(base + path, { method, data });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()}`);
    return response.json();
  };
  const pass = (test, details = {}) => results.push({ test, outcome: 'pass', ...details });
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };

  await api('/api/settings', 'PUT', {
    provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', chatModel: 'audit-teach', analysisModel: 'audit-normal' } },
    fish: { enabled: false }, autoContinue: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/settings');
  await page.getByRole('radio', { name: 'OpenAI', exact: true }).waitFor();
  for (const provider of ['Anthropic', 'Grok', 'Gemini', 'OpenAI']) {
    await page.getByRole('radio', { name: provider, exact: true }).check();
    ensure(await page.getByRole('radio', { name: provider, exact: true }).isChecked(), 'Provider selection failed');
  }
  await page.getByLabel('对话模型（讲课）', { exact: true }).fill('audit-teach');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  ensure(!(await page.locator('body').innerText()).includes('audit-dummy-key-only'), 'Raw key is visible');
  pass('settings provider radio controls and saved form; key remains masked');

  await page.goto(base + '/tutors/new');
  await page.getByLabel('导师名字', { exact: true }).fill('设计验收导师');
  await page.getByLabel('任教学科', { exact: true }).selectOption('数学');
  await page.getByLabel('标签', { exact: true }).fill('数学、严谨');
  await page.getByLabel('一句话简介', { exact: true }).fill('逐题推导，认真讲解');
  await page.getByLabel('性格', { exact: true }).fill('沉稳严谨');
  await page.getByLabel('教学风格', { exact: true }).fill('先做后讲，完整推导');
  await page.getByLabel('开场白', { exact: true }).fill('你好，我们开始学习。');
  await page.getByRole('button', { name: '保存导师', exact: true }).click();
  await page.waitForURL(base + '/tutors');
  const tutor = (await api('/api/tutors', 'GET')).find(t => t.name === '设计验收导师');
  ensure(tutor && tutor.personality === '沉稳严谨' && tutor.teachingStyle === '先做后讲，完整推导', 'Tutor UI did not persist');
  await page.goto(base + '/tutors/' + tutor.id);
  await page.getByLabel('开场白', { exact: true }).fill('你好，让我们从条件开始。');
  await page.getByRole('button', { name: '保存导师', exact: true }).click();
  await page.waitForURL(base + '/tutors');
  ensure((await api('/api/tutors/' + tutor.id, 'GET')).greeting === '你好，让我们从条件开始。', 'Tutor edit failed');
  pass('tutor created and edited through actual form controls');

  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles('output/audit/two-pages.pdf');
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  await page.getByLabel('试卷名称', { exact: true }).fill('高考数学 · 函数、方程与解析几何综合练习');
  await page.getByRole('button', { name: '后移', exact: true }).first().click();
  await page.screenshot({ path: 'output/playwright/redesign-upload-preview.png', fullPage: true });
  await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).click();
  await page.waitForURL(/\/papers\/\d+$/);
  await page.getByRole('button', { name: '开始一对一学习', exact: true }).waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('已解析'));
  const paperId = Number(page.url().split('/').at(-1));
  const paper = await api('/api/papers/' + paperId, 'GET');
  ensure(paper.paper.pageCount === 2 && paper.problems.length === 2, 'PDF analysis failed');
  await page.getByRole('button', { name: '查看答案与解析', exact: true }).first().click();
  await page.getByText('详细解析', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/redesign-paper-detail.png', fullPage: true });
  pass('two-page PDF preview, reorder, upload and analysis; answer expansion', { paperId });
  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles('public/avatars/darjeeling.png');
  await page.getByText('已添加 1 页', { exact: true }).waitFor();
  pass('image upload preview');
  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles('output/audit/seventeen-pages.pdf');
  await page.getByText(/PDF 共 17 页，单份试卷最多 12 页/).waitFor();
  ensure(await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).isDisabled(), 'Oversized PDF can submit');
  pass('oversized PDF explicitly rejected');

  const routes = ['/', '/papers', '/papers/new', '/papers/' + paperId, '/tutors', '/tutors/' + tutor.id, '/settings'];
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    for (const route of routes) {
      await page.goto(base + route);
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth, content: document.documentElement.scrollWidth,
        fonts: [getComputedStyle(document.body).fontFamily, getComputedStyle(document.querySelector('h1')).fontFamily],
        brokenImages: [...document.images].filter(image => image.complete && !image.naturalWidth).length,
        rounded: [...document.querySelectorAll('button, input, textarea, select, img, main, section, article')].filter(e => getComputedStyle(e).borderTopLeftRadius !== '0px').length,
      }));
      ensure(metrics.content <= metrics.viewport, `${route} overflows at ${width}: ${metrics.content}`);
      ensure(metrics.rounded === 0, `${route} has rounded UI`);
      ensure(metrics.brokenImages === 0, `${route} has broken images`);
      ensure(metrics.fonts[0].includes('Noto Sans SC Variable') && metrics.fonts[1].includes('Noto Serif SC Variable'), 'Wrong fonts');
      const name = route === '/' ? 'home' : route.startsWith('/papers/') && route !== '/papers/new' ? 'paper' : route.startsWith('/tutors/') ? 'tutor-editor' : route.slice(1).replaceAll('/', '-');
      await page.screenshot({ path: `output/playwright/redesign-${name}-${width}.png`, fullPage: true });
      pass(`layout ${name} ${width}`, metrics);
    }
  }

  await api('/api/settings', 'PUT', { fish: { enabled: false }, autoContinue: false, providers: { openai: { chatModel: 'audit-teach' } } });
  const session = await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id });
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.getByRole('button', { name: '老师更新了板书', exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'));
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    if (width < 1024) {
      await page.getByRole('tab', { name: '对话', exact: true }).click();
      await page.getByRole('tab', { name: '对话', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      ensure(await page.getByRole('tab', { name: '板书', exact: true }).getAttribute('aria-selected') === 'true', 'Tab keyboard navigation failed');
      await page.getByRole('tab', { name: '对话', exact: true }).click();
      await page.screenshot({ path: `output/playwright/redesign-classroom-chat-${width}.png` });
      await page.getByRole('tab', { name: '板书', exact: true }).click();
    }
    const metrics = await page.evaluate(() => {
      const chat = document.getElementById('chat-panel');
      const board = document.getElementById('board-panel');
      return { viewport: innerWidth, content: document.documentElement.scrollWidth, chatWidth: chat.getBoundingClientRect().width, boardWidth: board.getBoundingClientRect().width,
        chatMounted: !!chat.querySelector('textarea'), boardMounted: !!board.querySelector('.chalk'), formulaErrors: document.querySelectorAll('.katex-error').length,
        bottom: Math.max(chat.getBoundingClientRect().bottom, board.getBoundingClientRect().bottom), height: innerHeight };
    });
    ensure(metrics.content <= metrics.viewport && metrics.bottom <= metrics.height + 1, 'Classroom viewport overflow');
    ensure(metrics.chatMounted && metrics.boardMounted && !metrics.formulaErrors, 'Panels or formulas invalid');
    if (width >= 1024) ensure(metrics.chatWidth >= 320 && metrics.chatWidth <= 400 && metrics.boardWidth > metrics.chatWidth, 'Desktop ratio invalid');
    await page.screenshot({ path: `output/playwright/redesign-classroom-${width}.png` });
    pass(`classroom ${width}`, metrics);
  }
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs('output/audit/redesign-exported-notes.md');
  pass('blackboard notes export');
  await page.getByRole('button', { name: '重点', exact: true }).click();
  await page.getByRole('button', { name: '显示参考答案', exact: true }).click();
  await page.getByRole('button', { name: '关闭题目面板', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '重点', exact: true }).click();
  ensure(await page.getByRole('button', { name: '显示参考答案', exact: true }).isVisible(), 'Answer did not reset on problem switch');
  await page.getByRole('button', { name: '关闭题目面板', exact: true }).click();
  pass('blackboard overlays, problem paging and hidden-answer reset');

  const observedInputs = [];
  const observe = request => { if (request.url().endsWith('/turn')) observedInputs.push(request.postDataJSON()?.text); };
  page.on('request', observe);
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.getByRole('button', { name: '能再讲一遍吗？', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'), null, { timeout: 30000 });
  for (let i = 0; i < 30 && !observedInputs.includes('能再讲一遍吗？'); i++) await page.waitForTimeout(300);
  ensure(observedInputs.indexOf('给我一点提示') >= 0 && observedInputs.indexOf('能再讲一遍吗？') > observedInputs.indexOf('给我一点提示'), 'Interrupted inputs lost or reordered');
  page.off('request', observe);
  pass('two interrupted student inputs preserved in order');

  await api('/api/settings', 'PUT', { fish: { enabled: true, apiKey: 'audit-fake-fish-key' } });
  const voiceSession = await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id });
  const sampleRate = 8000, duration = 4;
  const wav = Buffer.alloc(44 + sampleRate * duration * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const tts = [];
  await page.route('**/api/tts', async route => { tts.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }); });
  await page.addInitScript(() => {
    window.__auditAudio = [];
    const AudioClass = window.Audio;
    window.Audio = function(...args) { const audio = new AudioClass(...args); window.__auditAudio.push(audio); return audio; };
  });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto(base + '/classroom/' + voiceSession.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => window.__auditAudio.some(audio => audio.currentTime > 0.1));
  const chatHandle = await page.locator('#chat-panel').elementHandle();
  const boardHandle = await page.locator('#board-panel').elementHandle();
  await page.getByRole('tab', { name: '板书', exact: true }).click();
  await page.waitForTimeout(700);
  const audioState = await page.evaluate(() => ({ time: window.__auditAudio[0].currentTime, paused: window.__auditAudio[0].paused }));
  ensure(audioState.time > 0.6 && !audioState.paused, 'Panel switch interrupted playback');
  ensure(await chatHandle.evaluate(element => element === document.getElementById('chat-panel')), 'Chat remounted');
  ensure(await boardHandle.evaluate(element => element === document.getElementById('board-panel')), 'Board remounted');
  await page.waitForTimeout(4000);
  ensure(await page.getByRole('tab', { name: '板书', exact: true }).getAttribute('aria-selected') === 'true', 'Fresh board changed active tab');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  const reveal = await page.locator('#chat-panel .md').allTextContents();
  ensure(reveal.some(text => text.includes('先试着解')), 'Chinese reveal missing');
  await page.getByRole('button', { name: '静音', exact: true }).click();
  if (await page.getByRole('button', { name: '停止讲解', exact: true }).isVisible()) await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  const ttsCount = tts.length;
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.waitForTimeout(900);
  ensure(tts.length === ttsCount, 'Muted mode synthesizes audio');
  ensure(tts.every(request => /[ぁ-ゖァ-ヺ]/.test(request.text)), 'Non-Japanese speech requested');
  pass('mock audio playback and Chinese reveal survive mobile tabs; fresh board keeps selected tab; muted skips TTS', { audioState, ttsCount });
  await page.goto(base + '/papers');
  ensure(await page.evaluate(() => window.__auditAudio.every(audio => audio.paused)), 'Audio not paused on unmount');
  await page.unroute('**/api/tts');
  pass('classroom unmount pauses audio');
  ensure(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  await page.evaluate(data => localStorage.setItem('redesign-ui-results', JSON.stringify(data)), { results, errors, paperId, tutorId: tutor.id, sessionId: session.id });
  return { passed: results.length, errors, paperId, tutorId: tutor.id, sessionId: session.id, results };
}
