async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Message splitting audit requires the isolated harness');
  const results = [], errors = [], tts = [];
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const pass = (test) => results.push({ test, outcome: 'pass' });
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  page.setDefaultTimeout(20000);
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    ensure(response.ok(), `${method} ${path}: ${response.status()}`);
    return response.json();
  };
  const waitAudio = () => page.waitForFunction(() => window.__splitAudio.some((a) => !a.paused && a.currentTime > 0.25));
  const waitPaused = () => page.waitForFunction(() => window.__splitAudio.every((a) => a.paused));
  await api('/api/settings', 'PUT', {
    connections: [{ id: 'split-audit', name: '分段审计', protocol: 'openai', baseUrl: 'http://127.0.0.1:4107/v1', apiKey: 'split-audit-dummy-key' }],
    models: { chat: { connectionId: 'split-audit', model: 'audit-teach' }, analysis: { connectionId: 'split-audit', model: 'audit-normal' } },
    autoContinue: false, fish: { enabled: true, apiKey: 'split-audit-fake-fish-key' },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/settings');
  await page.getByLabel('chat模型名称', { exact: true }).fill('audit-message-splitting');
  await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
  await page.getByText('模型设置已保存', { exact: true }).waitFor();
  ensure((await api('/api/settings')).models.chat.model === 'audit-message-splitting', 'Model binding was not saved');
  pass('settings saves the classroom model binding');

  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles('output/audit/two-pages.pdf');
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  await page.getByLabel('试卷名称', { exact: true }).fill('导师消息分段回归');
  await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).click();
  await page.waitForURL(/\/papers\/\d+$/);
  await page.getByRole('button', { name: '开始一对一学习', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '开始一对一学习')?.disabled);
  const paperId = Number(page.url().split('/').at(-1));
  const tutor = (await api('/api/tutors'))[0];
  const session = await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id });
  pass('two-page PDF uploads and publishes a classroom paper');

  const wav = Buffer.alloc(44 + 8000 * 2 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/tts', async (route) => {
    tts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.addInitScript(() => {
    window.__splitAudio = [];
    const Original = window.Audio;
    window.Audio = function(...args) { const audio = new Original(...args); window.__splitAudio.push(audio); return audio; };
  });
  try {
    await page.goto(base + '/classroom/' + session.id);
    await page.getByRole('button', { name: '开始上课', exact: true }).click();
    await waitAudio();
    const early = (await page.locator('#chat-panel .md').allTextContents()).join('');
    await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden' });
    const final = (await page.locator('#chat-panel .md').allTextContents()).join('');
    ensure(early.length < final.length, 'Exam text did not reveal with audio');
    ensure(tts.length === 3, 'Expected two screenshot bubbles and one unchanged short bubble');
    const savedResponse = await page.request.post('http://127.0.0.1:4107/sql', {
      data: { sql: "SELECT content FROM messages WHERE session_id=$1 AND role='tutor' AND kind='text' ORDER BY id", params: [session.id] },
    });
    ensure(savedResponse.ok(), 'Isolated fixture query failed');
    const saved = await savedResponse.json();
    ensure(saved.length === 3 && saved[0].content.endsWith('；') && saved[1].content.startsWith('二是在换元'), 'Saved screenshot boundaries are wrong');
    ensure(saved[1].content.includes('新元定义域'), 'Definition was split inside a word');
    ensure(saved[2].content.includes('接着代入检验。'), 'The short message was split again');
    ensure((await page.locator('#board-panel').innerText()).includes('等式性质'), 'Board did not render');
    ensure(await page.locator('.katex-error').count() === 0, 'Broken math rendering');
    await page.screenshot({ path: 'output/playwright/message-splitting-classroom.png' });
    pass('exam bubbles keep semantic boundaries, short messages and math while revealing with mock audio');

    await page.getByTitle('重播语音', { exact: true }).first().click();
    await waitAudio();
    await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '静音', exact: true }).click();
    const beforeMuted = tts.length;
    await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
    await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden' });
    ensure(tts.length === beforeMuted, 'Muted exam requested voice');
    await page.getByRole('button', { name: '开启语音', exact: true }).click();
    await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
    await waitAudio();
    await page.getByRole('button', { name: '停止讲解', exact: true }).click();
    await waitPaused();
    await page.goto(base + '/papers');
    pass('exam replay, muted text fallback and interruption stop audio');

    const source = 'Scientists study how cities change.';
    const reading = await api('/api/readings', 'POST', { title: '阅读消息分段回归', language: 'en', text: source });
    await api('/api/readings/' + reading.id, 'PATCH', { text: source, revision: reading.revision });
    const readingSession = await api('/api/reading-sessions', 'POST', { readingId: reading.id, tutorId: tutor.id });
    const beforeReading = tts.length;
    await page.goto(base + '/reading-classroom/' + readingSession.id);
    await page.getByRole('button', { name: '进入阅读课堂', exact: true }).click();
    await waitAudio();
    const readingEarly = (await page.locator('section').first().innerText()).length;
    await page.getByRole('button', { name: '打断', exact: true }).waitFor({ state: 'hidden' });
    const readingFinal = await page.locator('section').first().innerText();
    ensure(readingFinal.length > readingEarly, 'Reading text did not reveal with audio');
    const text = await page.locator('section').first().locator('.md').allTextContents();
    ensure(text[0].trim().endsWith('；') && text[1].includes('二是在换元') && text[1].includes('新元定义域'), 'Reading bubbles lost semantic boundaries');
    ensure(tts.length - beforeReading === 3, 'Reading synthesized a quote or missed a Chinese message');
    ensure(tts.slice(beforeReading).every((r) => !r.text.includes('Scientists')), 'Foreign quote was synthesized');
    await page.screenshot({ path: 'output/playwright/message-splitting-reading.png' });
    pass('reading classroom uses the shared boundaries and Japanese reveal without synthesizing quotes');
    await page.getByRole('button', { name: '重播语音', exact: true }).first().click();
    await waitAudio();
    await page.getByRole('button', { name: '重播语音', exact: true }).first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="重播语音"]')].every((button) => !button.disabled));
    await page.getByRole('button', { name: '静音', exact: true }).click();
    const beforeReadingMuted = tts.length;
    await page.getByLabel('向导师提问或作答').fill('请再解释一下。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '打断', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '打断', exact: true }).waitFor({ state: 'hidden' });
    ensure(tts.length === beforeReadingMuted, 'Muted reading requested voice');
    await page.getByRole('button', { name: '开启语音', exact: true }).click();
    await page.getByLabel('向导师提问或作答').fill('请继续讲解。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await waitAudio();
    await page.getByRole('button', { name: '打断', exact: true }).click();
    await waitPaused();
    await page.goto(base + '/papers');
    pass('reading replay, muted fallback, interruption and unmount stop voice');
    ensure(!errors.length, errors.join('\n'));
    await page.evaluate((data) => localStorage.setItem('message-splitting-browser-results', JSON.stringify(data)), { results, errors });
    return { results, errors };
  } finally {
    await page.unroute('**/api/tts');
    page.off('pageerror', onError);
  }
}
