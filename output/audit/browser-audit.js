async (page) => {
  const results = [];
  const api = async (url, method, data) => {
    const r = await page.request.fetch('http://127.0.0.1:3107' + url, { method, data });
    return r.json();
  };
  const settings = await api('/api/settings', 'GET');
  const setChat = model => ({ models: { ...settings.models, chat: { ...settings.models.chat, model } } });
  const initial = await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 });
  await page.goto('http://127.0.0.1:3107/classroom/' + initial.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.getByRole('button', { name: '老师更新了板书', exact: true }).waitFor();
  if (await page.getByRole('button', { name: '继续上课', exact: true }).isVisible()) await page.getByRole('button', { name: '继续上课', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  results.push(await page.evaluate(() => {
    const chat = document.querySelector('main > section').getBoundingClientRect();
    const board = document.querySelector('.board-frame').getBoundingClientRect();
    return { test: 'classroom desktop layout', chatWidth: chat.width, boardWidth: board.width, chatLeft: chat.x, boardLeft: board.x, formulas: document.querySelectorAll('.katex').length, formulaErrors: document.querySelectorAll('.katex-error').length };
  }));
  await page.screenshot({ path: 'output/playwright/fix-classroom.png', fullPage: true });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  const download = await dl;
  await download.saveAs('output/audit/fix-exported-notes.md');
  results.push({ test: 'notes export', outcome: 'pass', filename: download.suggestedFilename() });
  await api('/api/settings', 'PUT', { fish: { apiKey: 'audit-fake-fish-key', enabled: true }, ...setChat('audit-teach') });
  const session = await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 });
  const sampleRate = 8000;
  const duration = 4;
  const wav = Buffer.alloc(44 + sampleRate * duration * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const tts = [];
  await page.route('**/api/tts', async route => {
    tts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.addInitScript(() => {
    window.__auditAudio = [];
    const OriginalAudio = window.Audio;
    window.Audio = function(...args) { const a = new OriginalAudio(...args); window.__auditAudio.push(a); return a; };
  });
  await page.goto('http://127.0.0.1:3107/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => window.__auditAudio.some(a => a.currentTime > 0.1));
  const observations = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(550);
    observations.push(await page.evaluate(() => ({ time: window.__auditAudio[0]?.currentTime, duration: window.__auditAudio[0]?.duration, text: [...document.querySelectorAll('main > section .md')].map(e => e.textContent), boardHeadings: document.querySelectorAll('.chalk-scroll h2').length, katexErrors: document.querySelectorAll('.katex-error').length })));
  }
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await page.waitForTimeout(500);
  const stop = await page.evaluate(() => ({ stopped: window.__auditAudio.every(a => a.paused), boardHeadings: document.querySelectorAll('.chalk-scroll h2').length, messageCount: document.querySelectorAll('main > section .md').length }));
  const before = tts.length;
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.waitForTimeout(700);
  results.push({ test: 'Japanese TTS and text reveal with 4-second dummy audio', observations, ttsRequests: tts, stopped: stop });
  results.push({ test: 'muted mode skips TTS', outcome: tts.length === before ? 'pass' : 'fail', requestsBefore: before, requestsAfter: tts.length });
  await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await page.unroute('**/api/tts');
  await api('/api/settings', 'PUT', { fish: { enabled: false }, ...setChat('audit-next') });
  const nextSession = await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 });
  await page.goto('http://127.0.0.1:3107/classroom/' + nextSession.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('本课学习计划已完成'), null, { timeout: 30000 });
  results.push({ test: 'next starts next problem automatically', outcome: 'pass', sessionId: nextSession.id });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/fix-mobile.png', fullPage: true });
  results.push(await page.evaluate(() => ({ test: 'mobile layout', outcome: document.documentElement.scrollWidth <= innerWidth ? 'pass' : 'fail', viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth })));
  await page.evaluate(r => localStorage.setItem('audit-results', JSON.stringify(r)), results);
  return results;
}
