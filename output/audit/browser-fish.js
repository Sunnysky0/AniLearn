async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit runtime');
  const results = [];
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const api = async (fish) => {
    const response = await page.request.put(base + '/api/settings', { data: { fish } });
    ensure(response.ok(), 'Settings request failed');
    return response.json();
  };
  await api({ apiKey: 'fish-browser-dummy-key', enabled: true, proxyUrl: null });
  await page.addInitScript(() => {
    window.__fishTest = { audio: [], created: [], revoked: [], blocked: false };
    const OriginalAudio = window.Audio;
    window.Audio = function(...args) {
      const audio = new OriginalAudio(...args);
      const play = audio.play.bind(audio);
      audio.play = () => window.__fishTest.blocked
        ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : play();
      window.__fishTest.audio.push(audio);
      return audio;
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__fishTest.created.push(url); return url; };
    URL.revokeObjectURL = url => { window.__fishTest.revoked.push(url); revoke(url); };
  });
  await page.goto(base + '/settings');
  await page.waitForFunction(() => document.getElementById('fish-key').placeholder.includes('已配置'));
  await page.getByLabel('代理地址（可选）').fill('socks5://127.0.0.1:1080');
  const invalid = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  ensure((await invalid).status() === 400, 'Invalid proxy was accepted');
  await page.getByText(/代理地址必须为有效的 HTTP/).waitFor();
  await page.getByLabel('代理地址（可选）').fill('http://browser-user:browser-password@127.0.0.1:18081');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  const pub = await (await page.request.get(base + '/api/settings')).json();
  ensure(pub.fish.hasProxy && !JSON.stringify(pub).includes('browser-password') && !('proxyUrl' in pub.fish), 'Proxy leaked');
  await page.getByRole('button', { name: '清除 Fish Audio 代理', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="清除 Fish Audio 代理"]'));
  ensure(!(await (await page.request.get(base + '/api/settings')).json()).fish.hasProxy, 'Proxy not cleared');
  results.push({ test: 'proxy invalid/save/mask/clear through UI and persisted API', outcome: 'pass' });

  const wav = Buffer.alloc(44 + 8000 * 2 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const payloads = [];
  let mode = 'audio';
  await page.route('**/api/tts', async route => {
    payloads.push(route.request().postDataJSON());
    if (mode === 'credits') return route.fulfill({ status: 502, json: { error: 'Fish Audio (402)：账户余额不足。', code: 'FISH_HTTP_402' } });
    if (mode === 'stalled') {
      await new Promise(resolve => setTimeout(resolve, 16000));
      await route.abort().catch(() => {});
      return;
    }
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.waitForFunction(() => window.__fishTest.audio.some(a => a.currentTime > 0.1));
  ensure(payloads.at(-1).fresh === true, 'Preview used cache');
  await page.getByText('设置已保存，试听完成。', { exact: true }).waitFor();
  ensure(await page.evaluate(() => window.__fishTest.revoked.length === window.__fishTest.created.length), 'Completed audio URL not revoked');
  results.push({ test: 'fresh preview plays and cleans audio after completion', outcome: 'pass' });

  await page.evaluate(() => { window.__fishTest.blocked = true; });
  await page.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.getByRole('button', { name: '播放试听', exact: true }).waitFor();
  await page.evaluate(() => { window.__fishTest.blocked = false; });
  await page.getByRole('button', { name: '播放试听', exact: true }).click();
  await page.waitForFunction(() => window.__fishTest.audio.at(-1).currentTime > 0.1);
  await page.goto(base + '/papers');
  ensure(await page.evaluate(() => window.__fishTest.audio.every(a => a.paused) && window.__fishTest.created.length === window.__fishTest.revoked.length), 'Unmount did not clean audio');
  results.push({ test: 'blocked autoplay offers manual playback; unmount pauses and revokes', outcome: 'pass' });

  await page.goto(base + '/settings');
  await page.waitForFunction(() => document.getElementById('fish-key').placeholder.includes('已配置'));
  mode = 'credits';
  await page.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.getByText(/设置已保存，试听失败：.*余额不足/).waitFor();
  results.push({ test: 'synthesis errors retain saved status and display Chinese cause', outcome: 'pass' });
  mode = 'stalled';
  await page.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.getByText(/语音等待超时/).waitFor({ timeout: 20000 });
  ensure(await page.getByRole('button', { name: '保存并试听', exact: true }).isEnabled(), 'Timeout left preview stuck');
  results.push({ test: 'preview timeout clears loading and remains retryable', outcome: 'pass' });
  await page.unroute('**/api/tts');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings horizontal overflow');
    await page.screenshot({ path: `output/playwright/fish-audit-settings-${width}.png`, fullPage: true });
  }
  await page.evaluate(data => localStorage.setItem('fish-browser-results', JSON.stringify(data)), results);
  return results;
}
