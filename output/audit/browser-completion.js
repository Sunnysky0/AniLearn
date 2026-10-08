async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit harness');
  const results = [];
  const errors = [];
  const sent = [];
  const tts = [];
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const pass = test => results.push({ test, outcome: 'pass' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/turn')) sent.push(request.postDataJSON()); });
  const api = async (path, method = 'GET', data) => {
    const res = await page.request.fetch(base + path, { method, data });
    ensure(res.ok(), path + ': ' + res.status());
    return res.json();
  };
  const sql = async (sql, params = []) => {
    const res = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql, params } });
    ensure(res.ok(), 'Fixture SQL failed');
    return res.json();
  };
  const model = chatModel => api('/api/settings', 'PUT', {
    provider: 'openai', autoContinue: true,
    providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', chatModel } },
    fish: { apiKey: 'audit-fake-fish-key', enabled: true },
  });
  const session = async () => {
    const s = await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 });
    await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,\'tutor\',\'text\',\'请先独立尝试解方程。\',0)', [s.id]);
    return s;
  };
  const enter = async id => {
    await page.goto(base + '/classroom/' + id);
    await page.getByRole('button', { name: '继续上课', exact: true }).click();
  };
  const idle = () => page.waitForFunction(() => !document.body.innerText.includes('停止讲解'), null, { timeout: 30000 });
  const sampleRate = 8000, seconds = 4;
  const wav = Buffer.alloc(44 + sampleRate * seconds * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/tts', async route => {
    tts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.addInitScript(() => {
    window.__completionAudio = [];
    const Original = window.Audio;
    window.Audio = function(...args) { const a = new Original(...args); window.__completionAudio.push(a); return a; };
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await model('audit-goodbye-next');
  const s = await session();
  await enter(s.id);
  const count = sent.length;
  await page.getByRole('button', { name: '就到这里吧，再见', exact: true }).click();
  await page.getByRole('button', { name: '返回首页', exact: true }).waitFor();
  ensure(await page.getByRole('button', { name: '返回首页', exact: true }).isDisabled(), 'Return unlocked while thinking');
  await page.waitForFunction(() => window.__completionAudio.some(a => a.currentTime > 0.5));
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Return unlocked during audio');
  await page.screenshot({ path: 'output/playwright/completion-speaking-desktop.png' });
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor({ timeout: 20000 });
  ensure(sent.length === count + 1, 'Goodbye auto-continued');
  ensure(tts.at(-1).text.startsWith('[calm]'), 'Emotion missing');
  const [{ progress, status }] = await sql('SELECT progress,status FROM sessions WHERE id=$1', [s.id]);
  ensure(progress['0'] === 'active' && status === 'active', 'Goodbye completed problem');
  ensure(await page.getByRole('button', { name: '老师更新了板书', exact: true }).count() === 0, 'Goodbye wrote board');
  pass('goodbye retains progress and suppresses next; return waits for audio, reveal and queue');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('tab', { name: '板书', exact: true }).click();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).isVisible(), 'Return hidden on mobile board');
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overflow');
  await page.screenshot({ path: 'output/playwright/completion-return-mobile-board.png' });
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/completion-return-mobile-chat.png' });
  await page.getByRole('link', { name: '返回首页', exact: true }).click();
  await page.waitForURL(base + '/');
  pass('return is visible in mobile chat and board and navigates home');

  await model('audit-goodbye');
  await enter(s.id);
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Page-local goodbye survived reload');
  await page.getByRole('button', { name: '就到这里吧，再见', exact: true }).click();
  await page.waitForFunction(() => window.__completionAudio.some(a => a.currentTime > 0.3));
  await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await idle();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Stopping unlocked return');
  pass('goodbye state is page-local and stopping playback does not unlock return');

  await page.getByRole('button', { name: '静音', exact: true }).click();
  const ttsBefore = tts.length;
  await model('audit-goodbye-error');
  await page.getByRole('button', { name: '就到这里吧，再见', exact: true }).click();
  await page.getByRole('button', { name: '重试', exact: true }).waitFor({ timeout: 20000 });
  await idle();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Failed goodbye unlocked');
  await model('audit-goodbye');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor({ timeout: 20000 });
  ensure(sent.at(-1).intent === 'goodbye' && sent.at(-1).text === '', 'Retry lost intent or duplicated student text');
  ensure(tts.length === ttsBefore, 'Muted goodbye requested speech');
  pass('failed goodbye retry retains intent; muted reply unlocks after text fallback');

  await model('audit-goodbye');
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await idle();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'New input retained return');
  pass('continuing conversation clears goodbye return');

  const turnUrl = '**/api/sessions/' + s.id + '/turn';
  const message = { id: 999999, role: 'tutor', kind: 'text', content: '好，下次见。', speech: '', problemIdx: 0, attachments: [], createdAt: new Date().toISOString() };
  await page.route(turnUrl, route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'message', message }) + '\n' }));
  await page.getByRole('button', { name: '就到这里吧，再见', exact: true }).click();
  await page.getByText('导师回复提前结束，请重试。', { exact: true }).waitFor();
  await idle();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Premature EOF unlocked return');
  await page.unroute(turnUrl);
  pass('client rejects premature stream EOF without successful done');

  const currentSession = { ...s, currentIdx: 0, status: 'active', progress: { 0: 'active' }, paperId: 1, tutorId: 1 };
  await page.route(turnUrl, route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done', action: 'wait', intent: 'goodbye', session: currentSession }) + '\ninvalid\n' }));
  await page.getByRole('button', { name: '就到这里吧，再见', exact: true }).click();
  await page.getByText('导师回复格式不完整，请重试。', { exact: true }).waitFor();
  await idle();
  ensure(await page.getByRole('link', { name: '返回首页', exact: true }).count() === 0, 'Invalid trailing stream unlocked return');
  await page.unroute(turnUrl);
  pass('success done followed by malformed stream still cannot unlock return');

  await model('audit-teach');
  const queueStart = sent.length;
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await page.getByRole('button', { name: '停止讲解', exact: true }).waitFor();
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.getByRole('button', { name: '能再讲一遍吗？', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('停止讲解'), null, { timeout: 30000 });
  const inputs = sent.slice(queueStart).map(p => p.text).filter(Boolean);
  ensure(inputs.indexOf('给我一点提示') >= 0 && inputs.indexOf('能再讲一遍吗？') > inputs.indexOf('给我一点提示'), 'Queued input lost or reordered');
  pass('interruption preserves multiple student inputs in order');

  await model('audit-finish-full');
  const finished = await session();
  await sql('UPDATE sessions SET current_idx=1,progress=$2::jsonb WHERE id=$1', [finished.id, JSON.stringify({ 0: 'done', 1: 'active' })]);
  await enter(finished.id);
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await page.getByRole('link', { name: '返回首页', exact: true }).waitFor({ timeout: 30000 });
  ensure(await page.getByText('整张试卷已学完', { exact: true }).isVisible(), 'Natural finish missing');
  pass('natural whole-paper completion exposes home return after playback');
  ensure(errors.length === 0, errors.join('; '));
  await page.evaluate(results => localStorage.setItem('completion-browser-results', JSON.stringify(results)), results);
  await page.unroute('**/api/tts');
  return results;
}
