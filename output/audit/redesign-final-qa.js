async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit runtime');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('redesign-ui-results')));
  if (!saved) throw new Error('Run redesign-browser first');
  const api = async (path, method, data) => {
    const r = await page.request.fetch(base + path, { method, data });
    if (!r.ok()) throw new Error(`${path} failed`);
    return r.json();
  };
  const sql = async (query, params = []) => {
    const r = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql: query, params } });
    if (!r.ok()) throw new Error('Isolated SQL fixture failed');
    return r.json();
  };
  await api('/api/settings', 'PUT', { fish: { enabled: false }, autoContinue: false });
  const formula = '$$\n' + Array.from({ length: 24 }, (_, i) => `\\frac{x^{${i + 1}}}{${i + 1}}`).join('+') + '=0\n$$';
  const md = '## 一、条件与目标\n从题目给出的条件出发，逐步整理等式。\n\n' + formula + '\n\n> **定理**：等式两边同时进行相同的等价运算。\n\n## 二、规范推导\n- 明确未知数与取值范围\n- [x] 检查边界与符号\n\n| 条件 | 结论 |\n| --- | --- |\n| 等式性质 | 保持等价 |';
  await sql('UPDATE boards SET title=$1, blocks=$2::jsonb WHERE session_id=$3 AND problem_idx=0', ['函数与方程：从题设条件到规范推导的完整解题笔记', JSON.stringify([{ id: 'long-formula-qa', md }]), saved.sessionId]);
  await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,$2,$3,$4,0)', [saved.sessionId, 'tutor', 'text', '我们把关键条件逐项代入：\n\n' + formula]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/classroom/' + saved.sessionId);
  await page.getByRole('button', { name: '继续上课', exact: true }).click();
  const results = [];
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    if (width < 1024) {
      await page.getByRole('tab', { name: '对话', exact: true }).click();
      await page.screenshot({ path: `output/playwright/redesign-classroom-chat-${width}.png`, animations: 'disabled' });
      await page.getByRole('tab', { name: '板书', exact: true }).click();
    }
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth,
      formulaErrors: document.querySelectorAll('.katex-error').length,
      scrollableFormulas: [...document.querySelectorAll('.katex-display')].filter(e => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto').length,
      boardColor: getComputedStyle(document.querySelector('.chalk')).color,
      boardFont: getComputedStyle(document.querySelector('.chalk')).fontFamily,
    }));
    if (metrics.content > width || metrics.formulaErrors || !metrics.scrollableFormulas || !metrics.boardFont.includes('Noto Serif SC Variable')) throw new Error('Long formula layout failed: ' + JSON.stringify(metrics));
    await page.screenshot({ path: `output/playwright/redesign-classroom-${width}.png`, animations: 'disabled' });
    results.push({ test: `long title, formula, table and theorem board ${width}`, outcome: 'pass', ...metrics });
  }
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  results.push({ test: 'blackboard fullscreen enter and exit', outcome: 'pass' });
  await page.goto(base + '/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'output/playwright/redesign-home-1440.png', fullPage: true, animations: 'disabled' });
  const fonts = await page.evaluate(() => ({ loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
    resources: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.woff2')).map(r => r.name) }));
  if (!fonts.loaded.some(f => f.includes('Noto Sans SC Variable')) || !fonts.loaded.some(f => f.includes('Noto Serif SC Variable')) || !fonts.resources.length || fonts.resources.some(url => !url.startsWith(base))) throw new Error('Local font resources invalid');
  results.push({ test: 'actual font faces loaded locally', outcome: 'pass', fontFiles: fonts.resources.length });
  await page.evaluate(data => localStorage.setItem('redesign-final-qa', JSON.stringify(data)), results);
  return results;
}
