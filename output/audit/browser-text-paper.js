async (page) => {
  const base = 'http://127.0.0.1:3107';
  const results = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (condition, test) => {
    if (!condition) throw new Error(test);
    results.push({ test, outcome: 'pass' });
  };
  const markdown = '# Markdown 中文试卷\n\n## 第 1 题\n\n解方程 $x+1=2$。\n\n**完整题干**，保留中文与公式。';
  const latex = '\\documentclass{ctexart}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n第 2 题：解方程 $x+2=4$，其中 $x\\in\\R$。\n\\end{document}';
  const settings = await page.request.put(base + '/api/settings', { data: { provider: 'openai', providers: { openai: { apiKey: 'audit-dummy-key-only', baseUrl: 'http://127.0.0.1:4107/v1', analysisModel: 'audit-source', chatModel: 'audit-teach' } }, fish: { enabled: false }, autoContinue: false } });
  check(settings.ok(), 'isolated mock configuration');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/papers/new');
  const input = page.locator('input[type=file]');
  check((await input.getAttribute('accept')).includes('.md') && (await input.getAttribute('accept')).includes('.tex'), 'file picker accepts Markdown and TeX');
  await input.setInputFiles([
    { name: '中文试卷.MD', mimeType: '', buffer: Buffer.from(markdown) },
    { name: '数学试卷.tex', mimeType: 'application/octet-stream', buffer: Buffer.from(latex) },
  ]);
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  check(await page.getByText(/完整题干/).isVisible(), 'Markdown UTF-8 preview shown before upload');
  check(await page.getByText(/newcommand/).isVisible(), 'TeX source preview shown before upload');
  await page.screenshot({ path: 'output/playwright/text-paper-upload-desktop.png', fullPage: true });
  await page.getByTitle('前移', { exact: true }).last().click();
  await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).click();
  await page.waitForURL(/\/papers\/\d+$/);
  await page.getByText('已解析', { exact: true }).waitFor();
  const paperId = Number(page.url().split('/').at(-1));
  const paper = await (await page.request.get(base + '/api/papers/' + paperId)).json();
  check(paper.paper.pageMimes.join(',') === 'text/x-tex,text/markdown' && paper.problems.length === 2, 'source order persisted and analysis completed');
  check(await page.locator('img[src*="/pages/"]').count() === 0, 'text thumbnails do not render broken images');
  await page.getByRole('button', { name: 'LaTeX 第 1 页' }).click();
  await page.getByRole('dialog').getByText(/newcommand/).waitFor();
  check(await page.getByRole('dialog').getByText(/第 2 题/).isVisible(), 'TeX original, macros and Chinese readable after upload');
  await page.screenshot({ path: 'output/playwright/text-paper-tex-preview.png', fullPage: true });
  await page.getByRole('button', { name: '关闭预览' }).click();
  await page.getByRole('button', { name: 'Markdown 第 2 页' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Markdown 中文试卷' }).waitFor();
  check(await page.getByRole('dialog').locator('.katex').count() > 0, 'Markdown math rendered in original preview');
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile Markdown preview has no page overflow');
  await page.screenshot({ path: 'output/playwright/text-paper-preview-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.goto(base + '/papers');
  check(await page.getByText('LaTeX', { exact: true }).count() > 0, 'paper library uses a TeX thumbnail');
  check(await page.locator('img[src*="/pages/"]').count() === 0, 'library text sources have no broken image');
  await page.goto(base + '/');
  check(await page.getByText('LaTeX', { exact: true }).count() > 0, 'home recent paper uses a TeX thumbnail');
  await page.goto(base + '/papers/' + paperId);
  await page.getByRole('button', { name: '开始一对一学习' }).click();
  await page.getByRole('button', { name: '进入教室' }).click();
  await page.waitForURL(/\/classroom\/\d+$/);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('两边减去'));
  await page.getByRole('tab', { name: '板书', exact: true }).click();
  check((await page.locator('body').innerText()).includes('等式性质'), 'text paper reaches classroom with chat and board');
  await page.goto(base + '/papers/new');
  await page.locator('input[type=file]').setInputFiles({ name: 'empty.md', mimeType: '', buffer: Buffer.from('  \n') });
  await page.getByText('文本文件为空，请检查试卷内容。').waitFor();
  check(await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).isDisabled(), 'empty text cannot be submitted');
  await page.locator('input[type=file]').setInputFiles({ name: 'wrong-encoding.tex', mimeType: '', buffer: Buffer.from([0xff, 0xfe, 0x31, 0x00]) });
  await page.getByText('无法读取文本编码，请将文件保存为 UTF-8 后上传。').waitFor();
  check(await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).isDisabled(), 'invalid encoding rejected before upload');
  await page.locator('input[type=file]').setInputFiles({ name: 'large.md', mimeType: '', buffer: Buffer.alloc(1_500_001, 65) });
  await page.getByText('文本文件过大，单个文件最多 1.5 MB。').waitFor();
  check(await page.getByRole('button', { name: '上传并开始 AI 解析', exact: true }).isDisabled(), 'oversized source rejected before upload');
  await page.locator('input[type=file]').setInputFiles([
    { name: '中文试卷.md', mimeType: '', buffer: Buffer.from(markdown) },
    { name: '数学试卷.tex', mimeType: '', buffer: Buffer.from(latex) },
  ]);
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile upload has no page overflow');
  await page.screenshot({ path: 'output/playwright/text-paper-upload-mobile.png', fullPage: true });
  check(errors.length === 0, 'no browser page errors');
  await page.evaluate((data) => localStorage.setItem('text-paper-browser-results', JSON.stringify(data)), results);
  return results;
}
