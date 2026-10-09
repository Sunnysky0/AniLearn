async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit runtime');
  const report = [];
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    if (!response.ok()) throw new Error('API ' + response.status());
    return response.json();
  };
  await api('/api/settings', 'PUT', { provider: 'openai', fish: { enabled: true, apiKey: 'audit-fake-fish-key' }, autoContinue: false,
    providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', analysisModel: 'audit-source', chatModel: 'audit-teach' } } });
  const paper = await api('/api/papers', 'POST', { title: '公式逐字显示', subject: '数学' });
  await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:text/markdown;base64,' + Buffer.from('解方程 $x+1=2$。').toString('base64') });
  const analysis = await page.request.post(base + `/api/papers/${paper.id}/analyze`, { data: {} });
  if (!(await analysis.text()).includes('"type":"done"')) throw new Error('Analysis failed');
  const tutors = await api('/api/tutors');
  const created = await api('/api/sessions', 'POST', { paperId: paper.id, tutorId: tutors[0].id });
  const response = await page.request.post('http://127.0.0.1:4107/sql', { data: {
    sql: 'SELECT id, paper_id AS "paperId", tutor_id AS "tutorId", current_idx AS "currentIdx", status, progress, created_at AS "createdAt", updated_at AS "updatedAt" FROM sessions WHERE id=$1',
    params: [created.id],
  } });
  const [session] = await response.json();
  const formula = '\\vec{a}+\\vec{b}=\\vec{c}';
  const content = '价格\\$5，先看向量 $' + formula + '$，再看 $x+\\text{\\$5}$。';
  const message = { id: 800001, role: 'tutor', kind: 'text', content, speech: '[calm] まず、ベクトルの関係を見てみましょう。',
    problemIdx: 0, attachments: [], createdAt: new Date().toISOString() };
  let turn = 0;
  await page.route('**/api/sessions/*/turn', async (route) => {
    turn++;
    const first = { ...message, id: 800000 + turn * 2 };
    const boardMessage = { ...first, id: first.id + 1, kind: 'board', speech: '' };
    const events = [{ type: 'message', message: first },
      { type: 'board', board: { problemIdx: 0, title: '向量', blocks: [{ id: 'math-voice', md: '$$' + formula + '$$' }] },
        blockId: 'math-voice', message: boardMessage },
      { type: 'done', action: 'wait', session }];
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: events.map((event) => JSON.stringify(event)).join('\n') + '\n' });
  });
  const sampleRate = 8000;
  const audio = Buffer.alloc(44 + sampleRate * 4 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  let syntheses = 0;
  await page.route('**/api/tts', async (route) => {
    syntheses++;
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: audio });
  });
  await page.addInitScript(() => {
    window.__mathAudio = [];
    const OriginalAudio = window.Audio;
    window.Audio = function (...args) { const audio = new OriginalAudio(...args); window.__mathAudio.push(audio); return audio; };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => window.__mathAudio.some((audio) => audio.currentTime > 0.1));
  const observations = [];
  for (let i = 0; i < 10; i++) {
    observations.push(await page.evaluate(() => ({ time: window.__mathAudio[0]?.currentTime,
      text: document.querySelector('.classroom-chat .md')?.innerText,
      formulas: [...document.querySelectorAll('.classroom-chat annotation')].map((element) => element.textContent),
      errors: document.querySelectorAll('.katex-error').length })));
    await page.waitForTimeout(380);
  }
  if (observations.some((sample) => sample.errors || sample.formulas.some((value) => ![formula, 'x+\\text{\\$5}'].includes(value)))) {
    throw new Error('Partial formula during reveal');
  }
  if (new Set(observations.map((sample) => sample.text)).size < 3) throw new Error('Text did not advance with audio');
  await page.getByRole('button', { name: '重播语音', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden' });
  if (await page.locator('.classroom-chat .katex').count() !== 2) throw new Error('Final formula missing');
  if (await page.locator('.classroom-board .katex-display').count() !== 1) throw new Error('Queued board formula missing');
  report.push({ test: 'escaped dollars and vectors reveal atomically with audio; board follows playback', outcome: 'pass', observations });
  await page.getByRole('button', { name: '重播语音', exact: true }).first().click();
  await page.waitForFunction(() => window.__mathAudio.length === 2 && window.__mathAudio[1].currentTime > 0.1);
  if (syntheses !== 1) throw new Error('Replay bypassed audio cache');
  report.push({ test: 'replay uses cached audio without changing formulas', outcome: 'pass' });
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.getByRole('button', { name: '开启语音', exact: true }).waitFor();
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('.classroom-chat .katex').length === 4);
  if (syntheses !== 1 || !(await page.evaluate(() => window.__mathAudio.every((audio) => audio.paused || audio.muted)))) throw new Error('Muted synthesis or playback: ' + syntheses);
  report.push({ test: 'muted formula reveal uses timer and skips audio', outcome: 'pass' });
  await page.getByRole('button', { name: '开启语音', exact: true }).click();
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await page.waitForFunction(() => {
    const audio = window.__mathAudio.at(-1);
    return audio && !audio.paused && audio.currentTime > 0.1;
  });
  await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await page.waitForFunction(() => window.__mathAudio.every((audio) => audio.paused));
  if (await page.locator('.katex-error').count()) throw new Error('Interrupted formula rendering failed');
  report.push({ test: 'interrupt flushes complete math tokens and pauses audio', outcome: 'pass' });
  await page.goto(base + '/papers');
  await page.unroute('**/api/sessions/*/turn');
  await page.unroute('**/api/tts');
  await api('/api/settings', 'PUT', { fish: { enabled: false } });
  await page.evaluate((data) => localStorage.setItem('math-voice-results', JSON.stringify(data)), report);
  return report;
}
