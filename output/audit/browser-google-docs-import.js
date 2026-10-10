async (page) => {
  const base = 'http://127.0.0.1:3107';
  const results = [];
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const api = async path => {
    const response = await page.request.get(base + path);
    ensure(response.ok(), path + ': ' + response.status());
    return response.json();
  };
  const documentUrl = 'https://docs.google.com/document/d/1xYzabcdefghijkLMNOPqrstuvwxyz0123456789/edit?usp=sharing';
  let requestCount = 0;
  let lastRequest;
  await page.route('**/api/import/google-doc', async route => {
    requestCount++;
    lastRequest = route.request().postDataJSON();
    const path = lastRequest.url.includes('oversized=true') ? 'output/audit/seventeen-pages.pdf' : 'output/audit/two-pages.pdf';
    await route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'X-File-Name': encodeURIComponent('导入试卷.pdf') }, path });
  });

  const paperCount = (await api('/api/papers')).length;
  await page.goto(base + '/papers/new');
  await page.getByRole('heading', { name: '上传试卷', exact: true }).waitFor();
  await page.getByRole('button', { name: '从剪贴板添加', exact: true }).waitFor();
  await page.getByLabel('Google Docs 链接').fill(documentUrl);
  await page.getByRole('button', { name: '导入链接', exact: true }).click();
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  ensure(await page.getByLabel('试卷名称').inputValue() === '导入试卷', 'Paper title did not use the imported document name');
  ensure((await api('/api/papers')).length === paperCount, 'Paper import created a database record before submission');
  ensure(lastRequest?.url === documentUrl, 'Paper import sent the wrong Docs URL');
  results.push({ test: 'paper Google Docs link import, PDF pages, title fallback and staged-only behavior', outcome: 'pass' });

  const dispatchImagePaste = async () => page.evaluate((targetSelector) => {
    const data = new DataTransfer();
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2b8AAAAASUVORK5CYII=');
    data.items.add(new File([Uint8Array.from(binary, char => char.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    const target = targetSelector ? document.querySelector(targetSelector) : document.body;
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, 'body');

  await page.evaluate(() => {
    const data = new DataTransfer();
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2b8AAAAASUVORK5CYII=');
    data.items.add(new File([Uint8Array.from(binary, char => char.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    window.__clipboardImagePastePrevented = event.defaultPrevented;
  });
  await page.getByText('已添加 3 页', { exact: true }).waitFor();
  ensure(await page.evaluate(() => window.__clipboardImagePastePrevented), 'Paper image paste was not handled');
  results.push({ test: 'paper Ctrl+V image paste adds one image representation', outcome: 'pass' });

  const readingCount = (await api('/api/readings')).length;
  await page.goto(base + '/readings/new');
  await page.getByRole('heading', { name: '上传外刊', exact: true }).waitFor();
  await page.getByRole('button', { name: '从剪贴板添加', exact: true }).waitFor();
  await page.getByLabel('文章原文').fill('Original article text remains editable.');
  const ordinaryPastePrevented = await page.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="文章原文"]');
    const data = new DataTransfer();
    data.setData('text/plain', 'ordinary pasted text');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  ensure(!ordinaryPastePrevented, 'Article text field intercepted normal paste');
  await page.getByLabel('Google Docs 链接').fill(documentUrl);
  await page.getByRole('button', { name: '导入链接', exact: true }).click();
  await page.getByText(/已添加 3\/12 页/).waitFor();
  ensure(await page.getByLabel('文章标题').inputValue() === '导入试卷', 'Reading title did not use the imported document name');
  ensure(await page.locator('img').count() >= 2, 'Reading image previews are missing');
  ensure((await api('/api/readings')).length === readingCount, 'Reading import created a database record before submission');
  results.push({ test: 'reading Google Docs import, previews, normal text paste and staged-only behavior', outcome: 'pass' });

  await page.goto(base + '/readings/new');
  ensure(await dispatchImagePaste(), 'Reading image paste was not handled');
  await page.getByText(/已添加 1\/12 页/).waitFor();
  results.push({ test: 'reading Ctrl+V image paste adds a clipboard image', outcome: 'pass' });

  await page.evaluate(() => {
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2b8AAAAASUVORK5CYII=');
    const blob = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: 'image/png' });
    window.__clipboardReadTypes = [];
    Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: async () => [{
      types: ['image/png', 'image/jpeg', 'text/plain'],
      async getType(type) { window.__clipboardReadTypes.push(type); return type === 'image/png' ? blob : new Blob(['copied content'], { type }); },
    }] });
  });
  await page.getByRole('button', { name: '从剪贴板添加', exact: true }).click();
  await page.getByText(/已添加 2\/12 页/).waitFor();
  ensure(requestCount === 2, 'Clipboard button preferred the link or imported duplicate image formats');
  ensure(JSON.stringify(await page.evaluate(() => window.__clipboardReadTypes)) === JSON.stringify(['image/png']), 'Clipboard button read multiple representations of the same image');
  results.push({ test: 'clipboard button prefers one image representation over a copied link', outcome: 'pass' });

  await page.goto(base + '/papers/new');
  const keyboardUrl = documentUrl + '&source=clipboard';
  const linkPastePrevented = await page.evaluate(link => {
    const data = new DataTransfer();
    data.setData('text/plain', link);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, keyboardUrl);
  ensure(linkPastePrevented, 'Google Docs keyboard paste was not intercepted outside a text field');
  await page.getByText('已添加 2 页', { exact: true }).waitFor();
  ensure(lastRequest?.url === keyboardUrl, 'Keyboard paste imported a different Google Docs link');
  results.push({ test: 'Google Docs Ctrl+V imports a copied link', outcome: 'pass' });

  await page.goto(base + '/papers/new');
  await page.getByLabel('Google Docs 链接').fill(documentUrl + '&oversized=true');
  await page.getByRole('button', { name: '导入链接', exact: true }).click();
  await page.getByRole('region', { name: '剪贴板与 Google Docs 导入' }).getByText(/PDF 共 17 页/).first().waitFor();
  ensure(await page.getByRole('region', { name: '剪贴板与 Google Docs 导入' }).getByText(/已添加 0\/12 页/).count() === 1, 'Oversized Docs import changed the existing page list');
  results.push({ test: 'oversized Google Docs PDF is rejected as one batch', outcome: 'pass' });

  await page.unroute('**/api/import/google-doc');
  await page.evaluate(value => localStorage.setItem('google-docs-import-results', JSON.stringify(value)), results);
  return results;
}
