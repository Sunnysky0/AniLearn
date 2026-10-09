async (page) => {
  const base = 'http://127.0.0.1:3107';
  if (!page.url().startsWith(base)) throw new Error('Requires isolated audit runtime');
  const report = [];
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(base + path, { method, data });
    if (!response.ok()) throw new Error(path + ': ' + response.status());
    return response.json();
  };
  const sql = async (query, params) => {
    const response = await page.request.post('http://127.0.0.1:4107/sql', { data: { sql: query, params } });
    if (!response.ok()) throw new Error('Isolated fixture failed');
    return response.json();
  };
  const long = Array.from({ length: 24 }, (_, i) => `\\frac{x^{${i + 1}}}{${i + 1}}`).join('+');
  const samples = [
    ['vector', '$\\vec{a}+\\vec{b}=\\vec{c}$'],
    ['arrows', '$\\overrightarrow{AB}+\\overrightarrow{BC}=\\overrightarrow{AC}$'],
    ['accents', '$\\hat{x},\\widehat{ABC},\\bar{x},\\overline{AB},\\dot{x},\\ddot{x}$'],
    ['fractions', '$x_1^2+\\frac{1}{1+\\frac{1}{x}}+\\sqrt[3]{x^2+1}$'],
    ['operators', '$$\\sum_{k=1}^n k=\\frac{n(n+1)}{2},\\quad\\int_0^1 x^2\\,dx=\\frac{1}{3}$$'],
    ['matrix', '$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$'],
    ['cases', '$$\\begin{cases}x+y=1\\\\x-y=0\\end{cases}$$'],
    ['aligned', "$$\\begin{aligned}f(x)&=x^2\\\\f'(x)&=2x\\end{aligned}$$"],
    ['display-long', '$$' + long + '$$'],
    ['inline-long', '长公式 $' + long + '$ 结束。'],
  ];
  const markdown = samples.map(([name, source]) => '## ' + name + '\n' + source).join('\n\n') +
    '\n\n- $$x+1$$\n- **$$x+2$$**\n\n> \\[x+3\\]\n\n| 公式 |\n| --- |\n| $$x+4$$ |\n\n' +
    '代码 `\\(x+1\\)`\n\n```tex\n\\[x^2\\]\n```\n\n价格 \\$5，公式 $x+\\text{\\$5}$。';
  await api('/api/settings', 'PUT', { provider: 'openai', fish: { enabled: false }, autoContinue: false,
    providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', analysisModel: 'audit-source', chatModel: 'audit-teach' } } });
  const paper = await api('/api/papers', 'POST', { title: '数学排版回归', subject: '数学' });
  await api(`/api/papers/${paper.id}/pages`, 'POST', { dataUrl: 'data:text/markdown;base64,' + Buffer.from(markdown).toString('base64') });
  const analysis = await page.request.post(base + `/api/papers/${paper.id}/analyze`, { data: {} });
  if (!(await analysis.text()).includes('"type":"done"')) throw new Error('Analysis fixture failed');
  await sql('UPDATE problems SET content=$1, answer=$2, solution=$1 WHERE paper_id=$3 AND idx=0', [markdown, '$\\vec{a}$', paper.id]);
  const tutors = await api('/api/tutors');
  const session = await api('/api/sessions', 'POST', { paperId: paper.id, tutorId: tutors[0].id });
  await sql('INSERT INTO boards(session_id,problem_idx,title,blocks) VALUES($1,0,$2,$3::jsonb)',
    [session.id, '数学公式', JSON.stringify(samples.map(([name, source]) => ({ id: name, md: '## ' + name + '\n' + source })))]);
  for (const [name, source] of samples) {
    await sql('INSERT INTO messages(session_id,role,kind,content,problem_idx) VALUES($1,$2,$3,$4,0)',
      [session.id, 'tutor', 'text', name + '\n\n' + source]);
  }
  await page.goto(base + '/classroom/' + session.id);
  await page.getByRole('button', { name: '继续上课', exact: true }).click();

  async function checkLayout(label) {
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const visible = (element) => element.getClientRects().length > 0;
      const scrolls = [...document.querySelectorAll('.math-scroll,.katex-display')].filter(visible);
      const long = scrolls.filter((element) => element.scrollWidth > element.clientWidth + 2);
      const unreachable = long.filter((element) => {
        element.scrollLeft = 0;
        const first = element.querySelector('.katex-html .base');
        const left = first?.getBoundingClientRect().left;
        element.scrollLeft = element.scrollWidth;
        const last = [...element.querySelectorAll('.katex-html .base')].at(-1);
        const right = last?.getBoundingClientRect().right;
        const box = element.getBoundingClientRect();
        const failed = getComputedStyle(element).overflowX !== 'auto' || left < box.left - 2 || right > box.right + 2;
        element.scrollLeft = 0;
        return failed;
      });
      const vectors = [...document.querySelectorAll('.accent-body .overlay svg')].filter(visible).map((svg) => {
        const accent = svg.closest('.accent');
        const letter = accent?.querySelector('.mord.mathnormal');
        if (!letter) return null;
        return { arrowBottom: svg.getBoundingClientRect().bottom, letterBottom: letter.getBoundingClientRect().bottom,
          positioned: getComputedStyle(svg.closest('.accent-body')).position === 'relative' };
      }).filter(Boolean);
      const clipped = scrolls.filter((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll('.mathnormal,.accent-body svg,.sqrt svg')].some((symbol) => {
          const rect = symbol.getBoundingClientRect();
          return rect.height > 0 && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
        });
      });
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        errors: [...document.querySelectorAll('.katex-error')].filter(visible).length,
        long: long.length, unreachable: unreachable.length, clipped: clipped.length,
        arrowsCorrect: vectors.every((vector) => vector.positioned && vector.arrowBottom < vector.letterBottom - 2),
        vectors: vectors.length, fractionsSized: [...document.querySelectorAll('.sizing.reset-size6.size3')].filter(visible)
          .every((element) => parseFloat(getComputedStyle(element).fontSize) < parseFloat(getComputedStyle(element.closest('.katex')).fontSize)),
        formulas: [...document.querySelectorAll('.katex')].filter(visible).length };
    });
    if (metrics.documentWidth > metrics.width || metrics.errors || !metrics.long || metrics.unreachable || metrics.clipped || !metrics.arrowsCorrect || !metrics.fractionsSized) {
      throw new Error(label + ': ' + JSON.stringify(metrics));
    }
    report.push({ test: label, outcome: 'pass', ...metrics });
  }

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width < 1024) await page.getByRole('tab', { name: '对话', exact: true }).click();
    await checkLayout('classroom chat ' + width);
    await page.screenshot({ path: `output/playwright/math-chat-${width}.png`, fullPage: true });
    if (width < 1024) await page.getByRole('tab', { name: '板书', exact: true }).click();
    await checkLayout('classroom board ' + width);
    await page.screenshot({ path: `output/playwright/math-board-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await checkLayout('fullscreen board');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base + '/papers/' + paper.id);
    await page.getByRole('button', { name: '查看答案与解析', exact: true }).first().click();
    await checkLayout('paper content and solution ' + width);
    await page.screenshot({ path: `output/playwright/math-paper-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Markdown 第 1 页' }).click();
    await page.getByRole('dialog', { name: /第 1 页原文/ }).waitFor();
    await page.getByRole('dialog').locator('.katex').first().waitFor();
    await checkLayout('Markdown source preview ' + width);
    const code = await page.getByRole('dialog').locator('pre').innerText();
    if (code.trim() !== '\\[x^2\\]') throw new Error('Code source was rewritten');
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  }
  const baseline = await page.evaluate(() => {
    const formula = document.querySelector('.math-inline').cloneNode(true);
    const container = document.createElement('div');
    container.className = 'math-markdown md';
    container.style.cssText = 'position:absolute;visibility:hidden;width:500px';
    const wrapped = document.createElement('p');
    const native = document.createElement('p');
    for (const paragraph of [wrapped, native]) {
      const text = document.createElement('span');
      text.textContent = '文字';
      paragraph.append(text);
    }
    wrapped.append(formula);
    native.append(formula.querySelector('.katex').cloneNode(true));
    container.append(wrapped, native);
    document.body.append(container);
    const delta = (paragraph) => paragraph.querySelector('.mathnormal').getBoundingClientRect().top - paragraph.firstChild.getBoundingClientRect().top;
    const result = { baselineDifference: Math.abs(delta(wrapped) - delta(native)), lineHeightDifference: Math.abs(wrapped.offsetHeight - native.offsetHeight) };
    container.remove();
    return result;
  });
  if (baseline.baselineDifference > 1 || baseline.lineHeightDifference > 1) throw new Error('Short formula baseline changed: ' + JSON.stringify(baseline));
  report.push({ test: 'short formula matches native KaTeX baseline and line height', outcome: 'pass', ...baseline });
  await page.evaluate((data) => localStorage.setItem('math-browser-results', JSON.stringify(data)), { paperId: paper.id, sessionId: session.id, report });
  return report;
}
