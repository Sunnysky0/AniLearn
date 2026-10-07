async (page) => {
  const base = 'http://127.0.0.1:3107';
  const report = [];
  const check = (condition, test) => { if (!condition) throw new Error(test); report.push({ test, outcome: 'pass' }); };
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    if (!response.ok()) throw new Error('API ' + response.status());
    return response.json();
  };
  await api('/api/settings', 'PUT', { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', chatModel: 'audit-teach', analysisModel: 'audit-source' } }, fish: { enabled: true, apiKey: 'audit-fake-fish-key' }, autoContinue: false });
  const paper = await api('/api/papers', 'POST', { title: 'Markdown 语音课堂', subject: '数学' });
  await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:text/markdown;base64,' + Buffer.from('# 数学\n1. 解方程 $x+1=2$。\n2. 解方程 $x+2=4$。').toString('base64') });
  const analysis = await page.request.post(base + `/api/papers/${paper.id}/analyze`, { data: {} });
  check((await analysis.text()).includes('"type":"done"'), 'text paper ready for voiced classroom');
  const tutors = await api('/api/tutors');
  const session = await api('/api/sessions', 'POST', { paperId: paper.id, tutorId: tutors[0].id });
  const sampleRate = 8000;
  const audio = Buffer.alloc(44 + sampleRate * 4 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  const speech = [];
  await page.route('**/api/tts', async (route) => {
    speech.push(route.request().postDataJSON().text);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: audio });
  });
  await page.addInitScript(() => {
    window.__textPaperAudio = [];
    const AudioOriginal = window.Audio;
    window.Audio = function(...args) { const audio = new AudioOriginal(...args); window.__textPaperAudio.push(audio); return audio; };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => window.__textPaperAudio.some((audio) => audio.currentTime > 0.1));
  const early = await page.evaluate(() => ({ text: document.body.innerText, time: window.__textPaperAudio[0].currentTime }));
  await page.waitForFunction(() => window.__textPaperAudio[0].currentTime > 2.5);
  const later = await page.evaluate(() => ({ text: document.body.innerText, time: window.__textPaperAudio[0].currentTime }));
  check(early.text !== later.text && later.time > early.time, 'Chinese reveal advances with mock audio playback');
  check(speech.length > 0 && speech.every((text) => /^\[.+?\]/.test(text) && /[\u3040-\u30ff]/.test(text)), 'TTS receives Japanese scripts with emotion cues');
  await page.getByRole('button', { name: '静音', exact: true }).click();
  const before = speech.length;
  const mutedTurn = page.waitForResponse((response) => response.url().endsWith('/turn'));
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await (await mutedTurn).finished();
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.body.innerText.includes('等式性质'));
  check(speech.length === before, 'muted text-paper classroom skips synthesis');
  check(await page.evaluate(() => window.__textPaperAudio.every((audio) => audio.paused)), 'muting and interruption pause audio');
  check(await page.locator('.katex-error').count() === 0, 'chat and board formulas have no rendering errors');
  await page.goto(base + '/papers');
  await page.unroute('**/api/tts');
  await api('/api/settings', 'PUT', { fish: { enabled: false } });
  return report;
}
