async (page) => {
  const api = async (url, method, data) => (await page.request.fetch('http://127.0.0.1:3107' + url, { method, data })).json();
  await api('/api/settings', 'PUT', { fish: { enabled: false }, providers: { openai: { chatModel: 'audit-teach' } } });
  const s = await api('/api/sessions', 'POST', { paperId: 1, tutorId: 1 });
  const submitted = [];
  const observe = request => {
    if (request.url().endsWith('/turn')) submitted.push(request.postDataJSON());
  };
  page.on('request', observe);
  await page.goto('http://127.0.0.1:3107/classroom/' + s.id);
  await page.getByRole('button', { name: '开始上课', exact: true }).click();
  await page.getByRole('button', { name: '老师更新了板书', exact: true }).waitFor();
  await page.getByRole('button', { name: '给我一点提示', exact: true }).click();
  await page.getByRole('button', { name: '能再讲一遍吗？', exact: true }).click();
  await page.waitForTimeout(700);
  if (await page.getByRole('button', { name: '停止讲解', exact: true }).isVisible()) await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await page.waitForTimeout(500);
  const result = { test: 'two inputs during board interruption window', submitted, firstInputLost: !submitted.some(p => p.text === '给我一点提示'), secondInputSubmitted: submitted.some(p => p.text === '能再讲一遍吗？') };
  await page.evaluate(r => localStorage.setItem('audit-interruption-results', JSON.stringify([r])), result);
  page.off('request', observe);
  return result;
}
