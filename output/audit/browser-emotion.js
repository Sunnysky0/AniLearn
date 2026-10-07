async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Emotion browser audit requires the isolated harness');
  const results = [];
  const errors = [];
  const tts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const pass = (test, details = {}) => results.push({ test, outcome: 'pass', ...details });
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    ensure(response.ok(), `${method} ${path}: ${response.status()}`);
    return response.json();
  };
  await api('/api/settings', 'PUT', {
    provider: 'openai', autoContinue: false,
    providers: { openai: { apiKey: 'emotion-browser-dummy-key', baseUrl: 'http://127.0.0.1:4107/v1', analysisModel: 'audit-normal', chatModel: 'audit-emotion' } },
    fish: { enabled: true, apiKey: 'emotion-browser-fake-fish-key' },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/settings');
  await page.getByLabel('对话模型（讲课）', { exact: true }).fill('audit-emotion');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  ensure((await api('/api/settings')).providers.openai.chatModel === 'audit-emotion', 'Settings save failed');
  pass('settings form saves classroom model');

  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles('output/audit/two-pages.pdf');
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  await page.getByLabel('试卷名称', { exact: true }).fill('情绪标签回归试卷');
  await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).click();
  await page.waitForURL(/\/papers\/\d+$/);
  await page.getByRole('button', { name: '开始一对一学习', exact: true }).waitFor();
  await page.getByText('已解析', { exact: true }).waitFor();
  const paperId = Number(page.url().split('/').at(-1));
  const paper = await api('/api/papers/' + paperId);
  ensure(paper.paper.pageCount === 2 && paper.problems.length === 2, 'Upload and analysis failed');
  pass('two-page PDF preview, upload and analysis');

  const tutors = await api('/api/tutors');
  const tutor = tutors[0];
  const session = await api('/api/sessions', 'POST', { paperId, tutorId: tutor.id });
  const sampleRate = 8000, duration = 4;
  const wav = Buffer.alloc(44 + sampleRate * duration * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/tts', async (route) => {
    tts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.addInitScript(() => {
    window.__emotionAudio = [];
    const AudioClass = window.Audio;
    window.Audio = function(...args) {
      const audio = new AudioClass(...args);
      window.__emotionAudio.push(audio);
      return audio;
    };
  });
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => window.__emotionAudio.some((audio) => audio.currentTime > 0.4));
  const early = await page.locator('#chat-panel .md').allTextContents();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'), null, { timeout: 20000 });
  const final = await page.locator('#chat-panel .md').allTextContents();
  ensure(early.join('').length < final.join('').length, 'Text did not reveal progressively with audio');
  ensure(tts.length === 2, 'Expected two short speech requests');
  ensure(tts[0].text.startsWith('[curious] '), 'Existing leading emotion was changed');
  ensure(tts[1].text.startsWith(tutor.voiceStyle + ' '), 'Missing leading cue did not get tutor base style');
  ensure(tts[1].text.includes('ここで [emphasis] 両辺') && tts[1].text.includes('引きます。[break]'), 'Inline controls moved or disappeared');
  ensure(final.join('').includes('先试着解') && final.join('').includes('两边减去'), 'Chinese chat missing');
  const board = await page.locator('#board-panel').innerText();
  ensure(board.includes('等式性质'), 'Board missing');
  ensure(!/\[(curious|emphasis|break)\]/.test(final.join('') + board), 'Speech cues leaked into chat or board');
  ensure(await page.locator('.katex-error').count() === 0, 'Broken formula rendering');
  await page.screenshot({ path: 'output/playwright/emotion-classroom-desktop.png' });
  pass('Chinese short bubbles reveal with mock audio; board renders; leading emotion and inline emphasis/pause survive TTS', { early, final, requests: tts });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '板书', exact: true }).click();
  ensure(await page.getByRole('tab', { name: '板书', exact: true }).getAttribute('aria-selected') === 'true', 'Mobile board tab failed');
  await page.waitForFunction(() => [...document.querySelectorAll('#board-panel .chalk-in')].every((element) => Number(getComputedStyle(element).opacity) >= 0.99));
  await page.screenshot({ path: 'output/playwright/emotion-classroom-mobile.png' });
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overflow');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '静音', exact: true }).click();
  const beforeMuted = tts.length;
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'));
  ensure(tts.length === beforeMuted, 'Muted mode requested audio');
  pass('mobile chat/board tabs and muted text-only flow');
  await page.goto(base + '/papers');
  const countAfterLeave = tts.length;
  await page.waitForTimeout(300);
  ensure(tts.length === countAfterLeave, 'TTS continued after unmount');
  await page.unroute('**/api/tts');
  ensure(errors.length === 0, errors.join('; '));
  pass('classroom unmount stops pending voice; no browser errors');
  const report = { passed: results.length, errors, results };
  await page.evaluate((data) => localStorage.setItem('emotion-browser-results', JSON.stringify(data)), report);
  return report;
}
