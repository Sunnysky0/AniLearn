async (page) => {
  // Run only after the owned audit runtime and the serial books API suite are ready.
  // Playwright CLI: run-code --filename output/audit/browser-books.js
  // No test runner, filesystem imports, application mutations or production ports.
  const base = 'http://127.0.0.1:3107';
  const mock = 'http://127.0.0.1:4107';
  const results = [], turns = [], tts = [], pageErrors = [], failedRequests = [];
  const nonce = Date.now().toString(36);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const pass = (test, details = {}) => results.push({ test, outcome: 'pass', ...details });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = text => text.replace(/\s+/gu, ' ').trim();
  const nodes = values => values.flatMap(node => [node, ...nodes(node.children || [])]);
  const nodeText = values => values.map(node => node.type === 'break' ? '\n' : node.text || nodeText(node.children || [])).join('');
  const samePosition = (left, right) => left && right && left.documentKey === right.documentKey && left.unitId === right.unitId && left.blockId === right.blockId && left.offset === right.offset && Math.abs(left.viewportOffset - right.viewportOffset) < 2;
  const stop = () => page.getByRole('button', { name: '停止讲解', exact: true });
  const composer = () => page.getByRole('textbox', { name: '课堂消息', exact: true });
  const sourceBlock = id => page.locator('[data-reader-block="' + id + '"]');
  const nativeSource = id => sourceBlock(id).locator('[data-reading-paragraph-text]');
  let turnMode = 'normal', ttsMode = 'normal', voiceSequence = 0, bookId, sessionId, readingId, readingSessionId, originalSettings;

  async function api(path, method = 'GET', data) {
    assert(path.startsWith('/api/'), 'Only isolated API paths are allowed');
    const response = await page.request.fetch(base + path, { method, data });
    const raw = await response.text();
    let value;
    try { value = response.headers()['content-type']?.includes('application/x-ndjson') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(raw); }
    catch { throw new Error('Invalid response at ' + path + ', status ' + response.status()); }
    assert(response.ok(), path + ': ' + response.status() + ' ' + JSON.stringify(value).slice(0, 300));
    return value;
  }
  async function sql(query, params = []) {
    const response = await page.request.post(mock + '/sql', { data: { sql: query, params } });
    assert(response.ok(), 'Owned SQL fixture failed: ' + response.status());
    return response.json();
  }
  async function until(read, predicate, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await pause(150); }
    throw new Error('Timed out: ' + label);
  }
  const bundle = () => api('/api/book-sessions/' + sessionId);
  const learning = value => value.session.chapters.find(chapter => chapter.chapterId === value.session.currentChapterId).learning;
  const bookmark = value => value.session.chapters.find(chapter => chapter.chapterId === value.session.currentChapterId).position;
  async function settleBookmark() {
    await pause(850);
    return until(bundle, value => !!bookmark(value), 'saved book bookmark');
  }
  async function idle() {
    await stop().waitFor({ state: 'hidden', timeout: 45000 });
    const alerts = (await page.getByRole('alert').allTextContents()).map(text => text.trim()).filter(Boolean);
    assert(alerts.length === 0, 'Classroom displayed an error: ' + alerts.join(' | '));
  }
  async function openTutor() {
    if (await page.getByRole('button', { name: '打开导师', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导师', exact: true }).click();
    await page.locator('#reading-tutor-panel').waitFor({ state: 'visible' });
  }
  async function closeTutor() {
    if (await page.getByRole('button', { name: '收起导师', exact: true }).isVisible()) await page.getByRole('button', { name: '收起导师', exact: true }).click();
  }
  async function mute() {
    if (await page.getByRole('button', { name: '静音', exact: true }).isVisible()) await page.getByRole('button', { name: '静音', exact: true }).click();
    await page.getByRole('button', { name: '开启语音', exact: true }).waitFor();
  }
  async function unmute() {
    if (await page.getByRole('button', { name: '开启语音', exact: true }).isVisible()) await page.getByRole('button', { name: '开启语音', exact: true }).click();
    await page.getByRole('button', { name: '静音', exact: true }).waitFor();
  }
  async function bookTab(label) {
    await page.getByRole('navigation', { name: '典籍阅读内容' }).getByRole('button', { name: label, exact: true }).click();
  }
  async function send(text) {
    const count = turns.length;
    await openTutor(); await composer().fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    return lastTurnAfter(count);
  }
  async function nativeWord(id, word) {
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[aria-label="阅读正文"]').dispatchEvent('wheel', { deltaY: 0 });
    await nativeSource(id).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForFunction(({ id }) => {
      const root = document.querySelector('[aria-label="阅读正文"]');
      const element = document.querySelector('[data-reading-paragraph-text][data-paragraph-id="' + id + '"]');
      if (!root || !element) return false;
      const rootRect = root.getBoundingClientRect(); const rect = element.getBoundingClientRect();
      return rect.bottom > rootRect.top && rect.top < rootRect.bottom;
    }, { id });
    const rect = await nativeSource(id).evaluate((element, target) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (text.parentElement?.closest('[data-reader-ignore],rt')) continue;
        const start = text.textContent.indexOf(target);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 1);
        const bounds = range.getBoundingClientRect();
        if (bounds.width && bounds.height) return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      }
      throw new Error('Native selection word is absent: ' + target);
    }, word);
    await page.mouse.dblclick(rect.x, rect.y);
    assert(await page.evaluate(() => window.getSelection()?.toString().trim()) === word, 'Native mouse selected a different word');
    await page.getByRole('toolbar', { name: '原文选区操作' }).waitFor();
  }
  async function recordedTurn(requestId) {
    await page.waitForFunction(id => window.__booksQa.turns.some(turn => turn.requestId === id && (turn.events || turn.error)), requestId, { timeout: 45000 });
    const response = await page.evaluate(id => window.__booksQa.turns.find(turn => turn.requestId === id), requestId);
    assert(response.status === 200 && Array.isArray(response.events), 'Turn did not finish with a valid NDJSON response');
    assert(response.events.at(-1)?.type === 'done', 'Turn failed or ended prematurely');
    return response.events;
  }
  async function lastTurnAfter(count) {
    await until(async () => turns.length, length => length > count, 'new browser turn');
    return turns.at(-1);
  }
  async function targetRect(position) {
    return page.evaluate(value => {
      const scroller = document.querySelector('[aria-label="阅读正文"]');
      const block = [...document.querySelectorAll('[data-reader-block]')].find(element => element.dataset.readerBlock === value.blockId);
      if (!scroller || !block) return null;
      const leaf = [...block.querySelectorAll('[data-reader-start]')].find(element => Number(element.dataset.readerStart) <= value.offset && Number(element.dataset.readerEnd) > value.offset);
      if (!leaf) return null;
      const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
      let offset = value.offset - Number(leaf.dataset.readerStart);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (offset >= text.textContent.length) { offset -= text.textContent.length; continue; }
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, Math.min(text.textContent.length, offset + 1));
        const rect = range.getBoundingClientRect();
        return { viewport: rect.top - scroller.getBoundingClientRect().top, char: text.textContent.slice(offset, offset + 1), height: rect.height };
      }
      return null;
    }, position);
  }
  async function fit(mobile) {
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('#reading-tutor-panel').getBoundingClientRect();
      const article = document.querySelector('[aria-label="阅读正文"]').getBoundingClientRect();
      const input = document.querySelector('textarea[aria-label="课堂消息"]')?.getBoundingClientRect();
      const sendButton = document.querySelector('button[aria-label="发送消息"]')?.getBoundingClientRect();
      const rect = value => value && ({ left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height });
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, panel: rect(panel), article: rect(article), input: rect(input), send: rect(sendButton), width: innerWidth, height: innerHeight };
    });
    assert(!layout.overflow, 'Horizontal page overflow');
    assert(layout.input && layout.input.left >= -1 && layout.input.right <= layout.width + 1 && layout.send.bottom <= layout.height + 1, 'Composer is outside the viewport');
    if (mobile) assert(layout.panel.width >= layout.width - 2 && layout.panel.top > 100 && layout.panel.bottom <= layout.height + 1, 'Mobile tutor is not a usable bottom panel');
    else assert(layout.panel.right <= layout.article.left + 2 && layout.article.width > layout.panel.width, 'Desktop tutor is not on the left of the larger reader');
    return layout;
  }

  const currentUrl = page.url();
  assert(currentUrl === 'about:blank' || new URL(currentUrl).origin === base, 'Refusing a browser attached to a different origin');
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (/\/api\/(book|reading)-sessions\/\d+\/turn$/.test(request.url())) turns.push({ ...request.postDataJSON(), url: request.url() });
    if (request.url().endsWith('/api/tts')) tts.push(request.postDataJSON());
    assert(!/^https?:\/\/(?:localhost|127\.0\.0\.1):3000\b/.test(request.url()), 'Production port was requested');
  });
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(() => {
    const qa = window.__booksQa = { turns: [], requests: [], plays: [], ended: [], created: [], revoked: [], uploads: [], loseNextUpload: false, active: 0, peak: 0 };
    const blobs = new WeakMap(), urls = new Map();
    const fetchOriginal = window.fetch;
    window.fetch = async function (...args) {
      const path = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      let payload = null;
      if (typeof args[1]?.body === 'string') { try { payload = JSON.parse(args[1].body); } catch { /* Other requests are not JSON contracts. */ } }
      const speech = path.endsWith('/api/tts') ? { speech: payload.text, at: performance.now() } : null;
      if (speech) { qa.requests.push(speech); qa.peak = Math.max(qa.peak, ++qa.active); }
      try {
        const response = await fetchOriginal.apply(this, args);
        if (path === '/api/books' && args[1]?.body instanceof FormData) {
          const value = await response.clone().json();
          qa.uploads.push({ requestId: args[1].body.get('requestId'), bookId: value.book?.id, versionId: value.version?.id, status: response.status, error: value.error });
          if (response.ok && qa.loseNextUpload) {
            qa.loseNextUpload = false;
            return new Response(JSON.stringify({ error: '模拟响应丢失，请再次提交相同电子书。' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
          }
        }
        if (speech) { speech.ready = performance.now(); speech.status = response.status; }
        if (/\/(?:book|reading)-sessions\/\d+\/turn$/.test(path)) {
          const record = { requestId: payload.requestId, status: response.status };
          qa.turns.push(record);
          void response.clone().text().then(text => { try { record.events = text.trim().split('\n').filter(Boolean).map(JSON.parse); } catch { record.error = 'invalid NDJSON'; } }).catch(error => { record.error = error.name; });
        }
        return response;
      } catch (error) { if (speech) speech.error = error.name; throw error; }
      finally { if (speech) qa.active--; }
    };
    const originalBlob = Response.prototype.blob;
    Response.prototype.blob = async function () { const blob = await originalBlob.call(this); const speech = this.headers.get('x-audit-speech'); if (speech) blobs.set(blob, decodeURIComponent(speech)); return blob; };
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (blob) { const url = create.call(this, blob); const speech = blobs.get(blob); urls.set(url, speech); qa.created.push(url); return url; };
    URL.revokeObjectURL = function (url) { qa.revoked.push(url); return revoke.call(this, url); };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { const speech = urls.get(this.src); qa.plays.push({ speech, at: performance.now() }); this.addEventListener('ended', () => qa.ended.push({ speech, at: performance.now() }), { once: true }); return play.call(this); };
  });
  const wav = Buffer.alloc(44 + 8000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/tts', async route => {
    const body = route.request().postDataJSON(), mode = ttsMode;
    const delay = mode === 'slow' ? 3500 : body.text.includes('まず') ? 650 : body.text.includes('次に') ? 100 : 200;
    await pause(delay);
    if (mode === 'failure' && body.text.includes('まず')) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收语音回退' }) }).catch(() => {});
    else await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav, headers: { 'x-audit-speech': encodeURIComponent(body.text) } }).catch(() => {});
  });
  await page.route('**/api/book-sessions/*/turn', async route => {
    const mode = turnMode;
    if (mode === 'normal') { await route.continue(); return; }
    const response = await route.fetch();
    const raw = await response.text();
    if (!response.ok()) { await route.fulfill({ response, body: raw }); return; }
    let events = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    if (mode === 'layout' || mode === 'goodbye') await pause(1800);
    if (mode === 'voice') {
      const sequence = ++voiceSequence; let index = 0;
      events = events.map(event => event.type === 'message' && event.message.role === 'tutor' && event.message.language === 'zh-CN' ? { ...event, message: { ...event.message, speech: index++ === 0 ? `[calm fixture${sequence}] まず、本文の主張を確かめましょう。` : `[calm fixture${sequence}] 次に、理由と結論を区別しましょう。` } } : event);
    }
    await route.fulfill({ response, body: events.map(event => JSON.stringify(event)).join('\n') + '\n' }).catch(() => {});
  });

  try {
    const database = await sql('SELECT current_database() AS db');
    assert(database[0].db === 'anilearn_audit_20261007', 'Fixture endpoint is not the owned audit database');
    originalSettings = await api('/api/settings');
    const connection = originalSettings.connections.find(item => item.baseUrl.replace(/\/$/, '') === mock + '/v1');
    assert(connection, 'A configured isolated mock connection is required');
    const configure = model => api('/api/settings', 'PUT', { models: { chat: { connectionId: connection.id, model }, analysis: { connectionId: connection.id, model: 'audit-book-normal' } }, fish: { enabled: true, apiKey: 'books-browser-dummy-fish' }, autoContinue: false });
    await configure('audit-book-normal');
    const listing = await api('/api/books');
    const plato = listing.books.find(book => book.builtinKey === 'selected-dialogues-of-plato');
    assert(plato?.status === 'ready', 'Default Plato is not ready'); bookId = plato.id;
    const tutors = await api('/api/tutors'); const tutor = tutors.find(item => item.name === '阿尔托莉雅') || tutors[0];
    const beforeModels = (await (await page.request.get(mock + '/requests')).json()).length;
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(base + '/books');
    await page.evaluate(() => localStorage.removeItem('anilearn:reader-preferences'));
    await page.locator('a[href="/books/' + bookId + '"]').click();
    await page.getByLabel('陪读导师').selectOption(String(tutor.id));
    await page.getByRole('button', { name: '开始新的阅读课堂', exact: true }).click();
    await page.waitForURL(/\/book-classroom\/\d+$/);
    sessionId = Number(page.url().split('/').at(-1));
    await page.locator('[data-reader-document]').waitFor();
    let saved = await bundle();
    assert(saved.session.tutorId === tutor.id && saved.messages.length === 0 && learning(saved).phase === 'free_reading', 'New UI classroom has incorrect tutor or teaching state');
    assert(turns.length === 0 && tts.length === 0, 'Silent book entry made a turn or TTS request');
    assert((await (await page.request.get(mock + '/requests')).json()).length === beforeModels, 'Silent entry called a model');
    pass('books shelf → detail → chosen tutor → new silent default-Plato classroom', { bookId, sessionId, versionId: saved.session.versionId });

    await mute();
    const document = saved.document; const originalBlocks = JSON.stringify(document.blocks);
    const wordBlock = document.blocks.find(block => block.kind === 'paragraph' && block.anchorText.length > 80 && /\b[A-Za-z]{8,}\b/.test(block.anchorText));
    assert(wordBlock, 'No native-selection prose block'); const word = /\b[A-Za-z]{8,}\b/.exec(wordBlock.anchorText)[0];
    await nativeWord(wordBlock.id, word); const origin = bookmark(await settleBookmark()); const turnCount = turns.length;
    await page.getByRole('button', { name: '解释词语', exact: true }).click();
    const selectedTurn = await lastTurnAfter(turnCount); const selectionEvents = await recordedTurn(selectedTurn.requestId); await idle();
    assert(selectedTurn.selectionTask === 'vocabulary' && selectedTurn.anchor?.segments.length === 1 && selectedTurn.anchor.segments[0].quote === word, 'Shortcut did not send the exact native selection');
    const quotes = selectionEvents.filter(event => event.type === 'message' && event.message.kind === 'quote');
    const explanations = selectionEvents.filter(event => event.type === 'message' && event.message.language === 'zh-CN' && event.message.role === 'tutor');
    assert(quotes.length === 1 && quotes[0].message.content === word && !quotes[0].message.speech, 'Selected quote changed or acquired speech');
    assert(explanations.length >= 2 && explanations.every(event => /[\u4e00-\u9fff]/u.test(event.message.content)), 'Shortcut lacks short Chinese explanations');
    assert(tts.length === 0 && samePosition(bookmark(await bundle()), origin), 'Muted shortcut synthesized speech or moved the bookmark');
    pass('native word selection, exact anchor/foreign quote, Chinese bubbles, mute and independent bookmark', { word, bubbles: explanations.length });

    turnMode = 'layout'; const layoutCount = turns.length;
    await send('请再解释这一段的主张和理由。验收编号：' + nonce); await stop().waitFor();
    await bookTab('我的笔记'); await bookTab('原文'); await closeTutor(); await openTutor();
    const layoutTurn = await lastTurnAfter(layoutCount); await recordedTurn(layoutTurn.requestId); await idle(); turnMode = 'normal';
    assert(!failedRequests.some(request => request.url.endsWith('/book-sessions/' + sessionId + '/turn')), 'A layout switch canceled the active turn');
    assert((await bundle()).messages.some(message => message.role === 'user' && message.content.includes(nonce)), 'Layout-switched turn was not saved');
    assert(tts.length === 0, 'Muted layout-switched turn made TTS');
    pass('notes/source and tutor layout switches preserve an active streamed turn');

    await closeTutor(); await nativeWord(wordBlock.id, word);
    await page.getByRole('button', { name: '添加批注', exact: true }).click();
    const annotation = '原处批注：这个词要联系上下文理解。' + nonce;
    const annotationDialog = page.getByRole('dialog', { name: '添加原文批注' });
    assert(clean(await annotationDialog.locator('blockquote').innerText()) === word, 'Annotation quote changed');
    await page.getByRole('textbox', { name: '批注内容' }).fill(annotation);
    await annotationDialog.getByRole('button', { name: '保存批注', exact: true }).click(); await annotationDialog.waitFor({ state: 'hidden' });
    await until(bundle, value => value.notes.some(note => note.kind === 'annotation' && note.content === annotation), 'anchored annotation save');
    const inline = sourceBlock(wordBlock.id).locator('details').filter({ hasText: annotation });
    await inline.locator('summary').click(); assert(await inline.getByText(annotation, { exact: false }).isVisible(), 'Annotation is absent from its source block');
    await bookTab('我的笔记');
    const chapterNote = '本章笔记：区分诗人的灵感与可论证的知识。' + nonce;
    const bookNote = '全书笔记：比较五篇对话的问题与论证。' + nonce;
    await page.getByRole('textbox', { name: '本章笔记', exact: true }).fill(chapterNote);
    await page.getByRole('button', { name: '保存本章笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '全书笔记', exact: true }).fill(bookNote);
    await page.getByRole('button', { name: '保存全书笔记', exact: true }).click();
    await until(bundle, value => value.notes.some(note => note.kind === 'chapter' && note.content === chapterNote) && value.notes.some(note => note.kind === 'book' && note.content === bookNote), 'both notebooks saved');
    await page.reload(); await page.locator('[data-reader-document]').waitFor(); await mute(); await bookTab('我的笔记');
    assert(await page.getByRole('textbox', { name: '本章笔记', exact: true }).inputValue() === chapterNote, 'Chapter notebook failed refresh recovery');
    assert(await page.getByRole('textbox', { name: '全书笔记', exact: true }).inputValue() === bookNote, 'Book notebook failed refresh recovery');
    assert((await page.getByRole('textbox', { name: '编辑原文批注' }).all()).length > 0, 'Annotation editor disappeared on refresh');
    assert((await bundle()).notes.some(note => note.content === annotation && note.anchor.segments[0].quote === word), 'Annotation lost its original anchor');
    assert(JSON.stringify((await bundle()).document.blocks) === originalBlocks, 'Personal notes modified book source');
    await page.screenshot({ path: 'output/playwright/books-notes.png', scale: 'css' });
    pass('source-owned annotation and chapter/book notebooks save, refresh and preserve immutable source');

    await bookTab('原文'); saved = await bundle();
    const noteEntry = Object.entries(saved.document.footnotes).find(([, note]) => nodeText(note.nodes).includes('In ancient Greece, poetry was performed before an audience'));
    assert(noteEntry, 'Real Plato note 1 is missing');
    const referenceBlock = saved.document.blocks.find(block => nodes(block.nodes).some(node => node.type === 'footnote' && node.target === noteEntry[0]));
    await nativeSource(referenceBlock.id).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sourceBlock(referenceBlock.id).getByRole('button', { name: /^查看注释/ }).click();
    const footnote = page.getByRole('dialog', { name: '脚注' }); await footnote.waitFor();
    assert((await footnote.innerText()).includes('In ancient Greece'), 'Footnote popup lost source prose');
    const beforeInspect = bookmark(await settleBookmark());
    await footnote.getByRole('link', { name: '1', exact: true }).click();
    await page.getByRole('button', { name: '回到阅读位置', exact: true }).waitFor();
    assert(samePosition(bookmark(await bundle()), beforeInspect), 'Footnote backlink overwrote the reading bookmark');
    await page.getByRole('button', { name: '回到阅读位置', exact: true }).click();
    if (await page.getByRole('button', { name: '关闭脚注' }).isVisible()) await page.getByRole('button', { name: '关闭脚注' }).click();
    pass('real EPUB2 footnote popup and backlink use temporary inspection');

    await closeTutor();
    const loadedIds = await page.locator('[data-reader-block]').evaluateAll(elements => elements.map(element => element.dataset.readerBlock));
    const later = saved.document.blocks.find((block, index) => index >= loadedIds.length && !loadedIds.includes(block.id) && block.kind === 'paragraph' && block.anchorText.trim().length > 90);
    assert(later, 'Fixture did not exercise an unloaded book block'); const query = later.anchorText.trim().slice(0, 52);
    const searchOrigin = bookmark(await settleBookmark());
    await page.getByRole('button', { name: '搜索本章全文', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索本章', exact: true }).fill(query);
    await page.getByRole('region', { name: '本章全文搜索' }).getByRole('button').filter({ hasText: query }).first().click();
    await sourceBlock(later.id).waitFor(); await page.getByRole('button', { name: '回到阅读位置', exact: true }).waitFor();
    assert(samePosition(bookmark(await bundle()), searchOrigin), 'Full-chapter search overwrote a bookmark');
    await page.getByRole('button', { name: '回到阅读位置', exact: true }).click();
    const targetBefore = await targetRect(searchOrigin); assert(targetBefore?.height > 0, 'Original reading character is not visible after return');
    await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.getByRole('button', { name: '黑体', exact: true }).click();
    await page.getByRole('slider', { name: '字号', exact: true }).focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
    await page.getByRole('slider', { name: '正文宽度', exact: true }).focus(); await page.keyboard.press('Home');
    await page.getByRole('button', { name: '关闭阅读面板', exact: true }).click(); await pause(500);
    const targetAfter = await targetRect(searchOrigin);
    assert(targetAfter?.char === targetBefore.char && Math.abs(targetAfter.viewport - targetBefore.viewport) < 12, 'Font/column-width changes lost the same reading character: ' + JSON.stringify({ searchOrigin, targetBefore, targetAfter }));
    assert(await page.locator('[data-reading-article]').evaluate(element => getComputedStyle(element).fontFamily.includes('Sans')), 'Selected font did not apply');
    await openTutor(); const grip = page.getByRole('separator', { name: '调整导师面板宽度' });
    const beforeWidth = Number(await grip.getAttribute('aria-valuenow')); const gripRect = await grip.boundingBox();
    await page.mouse.move(gripRect.x + gripRect.width / 2, gripRect.y + gripRect.height / 2); await page.mouse.down();
    await page.mouse.move(gripRect.x + gripRect.width / 2 + 80, gripRect.y + gripRect.height / 2, { steps: 10 }); await page.mouse.up(); await pause(450);
    assert(Number(await grip.getAttribute('aria-valuenow')) > beforeWidth + 40, 'Tutor pane drag did not change width');
    const afterDrag = await targetRect(searchOrigin);
    assert(afterDrag?.char === targetBefore.char && Math.abs(afterDrag.viewport - targetBefore.viewport) < 12, 'Tutor resize lost the same reader character');
    const desktop = await fit(false); await page.screenshot({ path: 'output/playwright/books-desktop.png', scale: 'css' });
    pass('search unloaded book blocks, preserve inspection bookmark, font/width anchor and left tutor drag', { targetBlock: later.id, desktop });

    await page.setViewportSize({ width: 390, height: 844 }); await pause(500); await openTutor();
    const mobile = await fit(true); await composer().fill('手机输入框可以使用'); assert(await composer().inputValue() === '手机输入框可以使用', 'Mobile composer is unusable'); await composer().fill('');
    await page.screenshot({ path: 'output/playwright/books-mobile.png', scale: 'css' });
    await page.locator('#reading-tutor-panel').getByRole('button', { name: '关闭导师面板', exact: true }).click();
    assert(await page.locator('#reading-tutor-panel').isHidden(), 'Mobile tutor panel did not close');
    await page.setViewportSize({ width: 1366, height: 768 }); await pause(500); await openTutor();
    pass('390×844 bottom tutor panel, usable composer, close control and no page overflow', { mobile });

    const resetVoice = () => page.evaluate(() => { const qa = window.__booksQa; qa.requests = []; qa.plays = []; qa.ended = []; qa.active = 0; qa.peak = 0; });
    const voice = () => page.evaluate(() => window.__booksQa);
    await unmute(); turnMode = 'voice'; ttsMode = 'normal'; await resetVoice();
    await send('请给两个简短的阅读提示。'); await stop().waitFor(); const fifoTurn = turns.at(-1); await recordedTurn(fifoTurn.requestId); await idle();
    let audio = await voice();
    assert(audio.requests.length === 2 && audio.peak === 2, 'Book TTS was not prefetched in parallel');
    assert(audio.requests[1].ready < audio.requests[0].ready, 'Audio fixture did not synthesize out of order');
    assert(audio.plays.length === 2 && audio.plays.every((play, index) => play.speech === audio.requests[index].speech), 'Book playback did not remain FIFO');
    assert(audio.requests[1].at < audio.ended[0].at && audio.plays[1].at >= audio.ended[0].at, 'Synthesis/playback ordering is incorrect');
    pass('book parallel voice prefetch, out-of-order synthesis and FIFO reveal/playback', { requests: audio.requests.length, peak: audio.peak, audio: 'deterministic WAV; distinct Japanese scripts in browser stream fixture' });

    ttsMode = 'slow'; await resetVoice(); await send('先开始讲解，随后我要中断。'); await stop().waitFor();
    await page.waitForFunction(() => window.__booksQa.requests.length === 2);
    await stop().click(); await stop().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__booksQa.active === 0);
    audio = await voice(); assert(audio.requests.some(request => request.error === 'AbortError') && audio.plays.length === 0, 'Interruption did not cancel pending synthesis');
    assert(await page.getByRole('link', { name: '退出阅读', exact: true }).getAttribute('href') === '/books', 'Direct exit was unavailable after cancellation');
    pass('book interruption cancels pending synthesis and keeps direct exit available');
    ttsMode = 'failure'; await resetVoice(); await send('语音失败时仍请显示完整文字。'); await stop().waitFor(); const fallbackTurn = turns.at(-1);
    const fallbackEvents = await recordedTurn(fallbackTurn.requestId); await idle(); audio = await voice();
    assert(audio.requests.some(request => request.status === 503) && audio.plays.length === 1, 'Speech failure did not use text fallback and continue the queue');
    const fallbackChinese = fallbackEvents.filter(event => event.type === 'message' && event.message.role === 'tutor' && event.message.language === 'zh-CN').map(event => clean(event.message.content));
    const renderedChinese = (await page.locator('#reading-tutor-panel .md').allTextContents()).slice(-fallbackChinese.length).map(clean);
    assert(JSON.stringify(renderedChinese) === JSON.stringify(fallbackChinese), 'Fallback failed to reveal full Chinese bubbles');
    pass('book failed speech reveals full text and plays the next message');
    turnMode = 'normal'; ttsMode = 'normal'; await mute();

    await bookTab('原文'); await page.getByRole('button', { name: '确认已读完本章', exact: true }).click();
    await until(bundle, value => !!learning(value).readingConfirmedAt && learning(value).phase === 'free_reading', 'explicit reading confirmation');
    await page.getByRole('button', { name: '已读完，开始导读', exact: true }).click();
    await until(() => api('/api/book-sessions/' + sessionId + '/analysis-status'), value => value.status === 'ready', 'whole-chapter preparation', 120000);
    await page.getByRole('button', { name: '直接讲解', exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '直接讲解', exact: true }).click(); await stop().waitFor(); const firstFocusTurn = turns.at(-1); await recordedTurn(firstFocusTurn.requestId); await idle();
    saved = await bundle(); assert(learning(saved).currentFocus === 'concepts' && learning(saved).analysisNotes.concepts && !learning(saved).completedAt, 'First focus did not remain explicitly incomplete');
    await page.getByRole('button', { name: '这个角度已理解', exact: true }).click();
    await until(bundle, value => learning(value).focusStatus.concepts === 'confirmed' && learning(value).currentFocus === 'argument', 'first focus confirmation');
    for (const focus of ['argument', 'implications']) {
      saved = await bundle(); const state = learning(saved);
      assert(state.currentFocus === focus, 'Focus order changed');
      const events = await api('/api/book-sessions/' + sessionId + '/turn', 'POST', { requestId: 'browser-' + nonce + '-' + focus, versionId: saved.session.versionId, chapterId: saved.session.currentChapterId, phase: state.phase, stateRevision: state.stateRevision, focus, text: '请直接讲解当前角度，结合原文证据。' });
      assert(events.at(-1).type === 'done', 'Fixture focus turn failed'); saved = await bundle();
      await api('/api/book-sessions/' + sessionId, 'PATCH', { action: 'confirm_focus', versionId: saved.session.versionId, chapterId: saved.session.currentChapterId, stateRevision: learning(saved).stateRevision });
    }
    await page.reload(); await page.locator('[data-reader-document]').waitFor(); await mute(); await bookTab('本章导读');
    await page.getByRole('button', { name: '生成本章总结', exact: true }).click(); await stop().waitFor(); const summaryTurn = turns.at(-1); await recordedTurn(summaryTurn.requestId); await idle();
    assert(!learning(await bundle()).completedAt, 'Summary implicitly completed the chapter');
    await page.getByRole('button', { name: '明确完成本章', exact: true }).click();
    await until(bundle, value => !!learning(value).completedAt, 'explicit chapter completion');
    await page.getByText('本章导读已完成', { exact: true }).waitFor();
    const previousChapter = (await bundle()).session.currentChapterId; const beforeNext = { turns: turns.length, tts: tts.length };
    await page.getByRole('button', { name: '进入下一章', exact: true }).click();
    saved = await until(bundle, value => value.session.currentChapterId !== previousChapter, 'next chapter');
    await page.locator('[data-reader-document]').waitFor();
    assert(learning(saved).phase === 'free_reading' && !learning(saved).readingConfirmedAt && turns.length === beforeNext.turns && tts.length === beforeNext.tts, 'Next chapter was not silent free reading');
    assert(saved.session.chapters.find(chapter => chapter.chapterId === previousChapter).learning.completedAt, 'Completed chapter state was lost');
    pass('reading → prepared chapter → direct first-focus lecture → explicit focus and chapter completion → silent next chapter');

    await unmute(); const exitState = JSON.stringify(learning(saved)); const beforeExit = { turns: turns.length, tts: tts.length };
    await page.getByRole('link', { name: '退出阅读', exact: true }).click(); await page.waitForURL(base + '/books');
    assert(turns.length === beforeExit.turns && tts.length === beforeExit.tts, 'Direct exit requested a tutor reply or speech');
    assert(JSON.stringify(learning(await bundle())) === exitState, 'Direct exit changed next-chapter learning progress');
    await page.waitForFunction(() => window.__booksQa.created.every(url => window.__booksQa.revoked.includes(url)));
    pass('direct exit preserves progress, returns to the bookshelf without a tutor turn and revokes cached URLs');

    // A successful server upload with a lost browser response must reuse the
    // requestId, including while the first MOBI conversion is still running.
    for (const fixture of [
      { file: 'books/Selected Dialogues of Plato.epub', name: 'EPUB' },
      { file: '.anilearn/books-fixtures/plato.mobi', name: 'MOBI' },
    ]) {
      const title = fixture.name + ' 上传重试验收 ' + nonce;
      await page.goto(base + '/books/new');
      // Preserve native multipart file bytes; route.fetch omits CDP file data.
      await page.evaluate(() => { window.__booksQa.uploads = []; window.__booksQa.loseNextUpload = true; });
        await page.getByLabel('选择电子书', { exact: true }).setInputFiles(fixture.file);
        await page.getByLabel('书名（留空读取电子书信息）', { exact: true }).fill(title);
        await page.getByRole('button', { name: '导入并整理目录', exact: true }).click();
        await page.getByRole('alert').getByText('模拟响应丢失，请再次提交相同电子书。', { exact: true }).waitFor({ timeout: 120000 });
        await page.getByRole('button', { name: '导入并整理目录', exact: true }).click();
        await page.waitForFunction(() => window.__booksQa.uploads.length === 2, null, { timeout: 120000 });
        const uploads = await page.evaluate(() => window.__booksQa.uploads);
        assert(uploads.every(upload => upload.status >= 200 && upload.status < 300 && upload.requestId && upload.bookId), 'Real upload failed: ' + JSON.stringify(uploads));
        assert(uploads[0].requestId === uploads[1].requestId && uploads[0].bookId === uploads[1].bookId && uploads[0].versionId === uploads[1].versionId, 'UI retry created a duplicate book/version');
        await page.waitForURL(base + '/books/' + uploads[0].bookId);
        await until(() => api('/api/books/' + uploads[0].bookId + '/analysis-status'), status => { assert(status.status !== 'failed', 'Retry import failed: ' + status.error); return status.status === 'review'; }, 'retry import review', 120000);
        await page.getByRole('textbox', { name: '章节 1 标题', exact: true }).waitFor({ timeout: 15000 });
        const reviewMaterial = await api('/api/books/' + uploads[0].bookId);
        assert(await page.getByRole('textbox', { name: /^章节 \d+ 标题$/ }).count() === reviewMaterial.version.chapters.length, 'Import transition lost the directory response');
        assert((await api('/api/books')).books.filter(book => book.title === title).length === 1, 'Retry left duplicate library entries');
        pass(fixture.name + ' UI upload retries a lost successful response with the same requestId/book/version', uploads[0]);
    }

    // Split a newly created local chapter again, then merge and split it.
    const directory = await api('/api/books/' + bookId);
    const reviewDraft = await api('/api/books/' + bookId + '/versions/' + directory.book.currentVersionId, 'PATCH', { revision: (await api('/api/books/' + bookId + '?versionId=' + directory.book.currentVersionId)).version.revision, chapters: (await api('/api/books/' + bookId + '?versionId=' + directory.book.currentVersionId)).version.chapters });
    await page.goto(base + '/books/' + bookId + '?versionId=' + reviewDraft.version.id);
    const beforeSplit = await api('/api/books/' + bookId + '?versionId=' + reviewDraft.version.id);
    const splitIndex = beforeSplit.version.chapters.findIndex(chapter => chapter.blockIds.length > 50);
    assert(splitIndex >= 0, 'Missing chapter for corrected-directory flow');
    const openSplitAt = async index => { await page.getByRole('button', { name: '拆章', exact: true }).nth(index).click(); await page.getByRole('combobox', { name: '拆章原文位置', exact: true }).waitFor(); };
    await openSplitAt(splitIndex); await page.getByRole('button', { name: '拆成两章', exact: true }).click();
    await openSplitAt(splitIndex + 1); await page.getByRole('button', { name: '拆成两章', exact: true }).click();
    assert(await page.getByRole('textbox', { name: /^章节 \d+ 标题$/ }).count() === beforeSplit.version.chapters.length + 2, 'Repeated split lost the new local chapter');
    await page.getByRole('button', { name: '与下一章合并', exact: true }).nth(splitIndex + 1).click();
    await openSplitAt(splitIndex + 1);
    const mergedDraft = await api('/api/books/' + bookId + '?versionId=' + reviewDraft.version.id);
    const previewOptions = await page.getByRole('combobox', { name: '拆章原文位置', exact: true }).locator('option').count();
    assert(previewOptions === mergedDraft.version.chapters[splitIndex + 1].blockIds.length - 1, 'Merged chapter split preview omitted merged-in blocks');
    await page.getByRole('dialog', { name: '拆分章节' }).getByRole('button', { name: '取消', exact: true }).click();
    const oldVersions = await api('/api/books/' + bookId + '/versions');
    const historical = oldVersions.versions.find(version => version.status === 'ready' && version.id !== directory.book.currentVersionId);
    assert(historical, 'Missing published historical version');
    await page.getByRole('navigation', { name: '典籍内容版本' }).locator('a[href="/books/' + bookId + '?versionId=' + historical.id + '"]').click();
    await page.waitForURL(base + '/books/' + bookId + '?versionId=' + historical.id);
    await page.waitForFunction(href => document.querySelector('nav[aria-label="典籍内容版本"] a[href="' + href + '"]')?.getAttribute('aria-current') === 'page', '/books/' + bookId + '?versionId=' + historical.id);
    await page.getByRole('button', { name: '开始新的阅读课堂', exact: true }).click(); await page.waitForURL(/\/book-classroom\/\d+$/);
    const historySession = await api('/api/book-sessions/' + page.url().split('/').at(-1));
    assert(historySession.session.versionId === historical.id, 'History entry created a classroom against the current version');
    pass('completed import directory, repeated split, merged preview and published historical version entry');

    // Targeted old-article regression: a legacy snapshot, legacy notes and >100 paragraphs.
    await configure('audit-selection-retry');
    const boundaryText = 'Context before the loading boundary. '.repeat(16) + 'BATCHSTART ' + 'Evidence links the claim to its reasons. '.repeat(50) + ' BATCHEND.';
    const paragraphs = Array.from({ length: 180 }, (_, index) => ({ id: 'browser-article-' + nonce + '-' + index, page: 1,
      text: index === 5 ? 'I watched the campaign develop: undersea cables cut, incendiary devices hidden in cargo packages, and arson attacks.' : index === 99 ? boundaryText : index === 100 ? 'BATCHNEXT continues the thought in a newly loaded paragraph.' : index === 160 ? 'The AFTERHUNDRED harbor report explains how researchers recover a precise reading position after a long search.' : `Paragraph ${index + 1} follows the harbor researchers as they compare observations, explain their evidence, and revise their account of changing transport networks.` }));
    const createdReading = await sql('INSERT INTO readings (title,language,status,paragraphs,extracted) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id', ['Reader 外刊针对性回归 ' + nonce, 'en', 'ready', JSON.stringify(paragraphs), paragraphs.map(paragraph => paragraph.text).join('\n\n')]);
    readingId = createdReading[0].id;
    readingSessionId = (await api('/api/reading-sessions', 'POST', { readingId, tutorId: tutor.id })).id;
    const readingPath = '/api/reading-sessions/' + readingSessionId;
    const oldNote = '旧课堂笔记：原有的论证记录继续保留。' + nonce;
    await sql('UPDATE reading_sessions SET notes=$1::jsonb WHERE id=$2', [JSON.stringify({ '0': [oldNote] }), readingSessionId]);
    const paragraph = paragraphs[5], offset = paragraph.text.indexOf('incendiary');
    const legacySelection = { segments: [{ paragraphId: paragraph.id, start: offset, end: offset + 10, quote: 'incendiary', prefix: paragraph.text.slice(Math.max(0, offset - 36), offset), suffix: paragraph.text.slice(offset + 10, offset + 46) }] };
    const legacyAnnotation = '旧式选区批注可以继续回看。' + nonce;
    const oldAnnotation = await api(readingPath + '/notes', 'POST', { clientId: 'legacy-' + nonce, kind: 'annotation', content: legacyAnnotation, selection: legacySelection });
    await sql('UPDATE reading_personal_notes SET reader_anchor=NULL WHERE id=$1 AND session_id=$2', [oldAnnotation.id, readingSessionId]);
    const oldNotebook = '旧全文笔记：保留读后想法。' + nonce;
    await api(readingPath + '/notes', 'POST', { clientId: 'document-' + nonce, kind: 'document', content: oldNotebook });
    const beforeReading = { turns: turns.length, tts: tts.length, models: (await (await page.request.get(mock + '/requests')).json()).length };
    await page.goto(base + '/reading-classroom/' + readingSessionId); await page.locator('[data-reader-document]').waitFor(); await mute();
    assert(turns.length === beforeReading.turns && tts.length === beforeReading.tts && (await (await page.request.get(mock + '/requests')).json()).length === beforeReading.models, 'Old-article entry was not silent');
    const initialLoaded = await page.locator('[data-reader-block]').count();
    assert(initialLoaded === 100 && await sourceBlock(paragraphs[100].id).count() === 0, 'Reading fixture did not start at the real 100-block mount boundary');
    await nativeSource(paragraphs[99].id).evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const boundaryStart = await nativeSource(paragraphs[99].id).evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode, offset = text.textContent.indexOf('BATCHSTART');
        if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
        const scroller = document.querySelector('[aria-label="阅读正文"]');
        scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 110;
        const rect = range.getBoundingClientRect(); return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
      throw new Error('Boundary start is missing');
    });
    assert(await sourceBlock(paragraphs[100].id).count() === 0, 'Boundary fixture loaded next batch before the native drag began');
    const boundaryCount = turns.length;
    await page.mouse.move(boundaryStart.x, boundaryStart.y); await page.mouse.down();
    await page.mouse.move(boundaryStart.x + 8, boundaryStart.y);
    let destination;
    try {
      for (let attempt = 0; attempt < 15; attempt++) {
        await page.mouse.wheel(0, 420); await pause(80);
        if (!await sourceBlock(paragraphs[100].id).count()) continue;
        destination = await nativeSource(paragraphs[100].id).evaluate(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode, offset = text.textContent.indexOf('BATCHNEXT'); if (offset < 0) continue;
            const range = document.createRange(); range.setStart(text, offset + 8); range.setEnd(text, offset + 9);
            const rect = range.getBoundingClientRect(), scroller = document.querySelector('[aria-label="阅读正文"]').getBoundingClientRect();
            return rect.top > scroller.top + 20 && rect.bottom < scroller.bottom - 20 ? { x: rect.right - 1, y: rect.top + rect.height / 2 } : null;
          }
          return null;
        });
        if (destination) break;
      }
      assert(destination, 'Wheel during native selection did not load and reveal block 100');
      await page.mouse.move(destination.x, destination.y, { steps: 5 });
    } finally { await page.mouse.up(); }
    const boundaryQuote = await page.evaluate(() => window.getSelection()?.toString().trim());
    assert(boundaryQuote.includes('BATCHSTART') && boundaryQuote.includes('BATCHNEXT'), 'Native selection did not cross the real batch boundary');
    await page.getByRole('button', { name: '说明句意', exact: true }).click();
    const boundaryTurn = await lastTurnAfter(boundaryCount), boundaryEvents = await recordedTurn(boundaryTurn.requestId); await idle();
    assert(boundaryTurn.readerAnchor?.segments.length === 2 && boundaryTurn.readerAnchor.segments[0].blockId === paragraphs[99].id && boundaryTurn.readerAnchor.segments[1].blockId === paragraphs[100].id, 'Loaded-boundary anchor lost or reordered its two source segments');
    const boundaryQuotes = boundaryEvents.filter(event => event.type === 'message' && event.message.kind === 'quote').map(event => event.message.content);
    assert(JSON.stringify(boundaryQuotes) === JSON.stringify(boundaryTurn.readerAnchor.segments.map(segment => segment.quote)), 'Server did not accept the two exact boundary quotes');
    assert(await page.locator('[data-reader-block]').count() > initialLoaded, 'Boundary mouse wheel did not mount the next batch');
    pass('native mouse drag held across wheel-triggered 99/100 loading boundary preserves two exact source segments', { initialLoaded, segments: 2 });
    await closeTutor();
    await nativeWord(paragraph.id, 'incendiary'); await pause(850);
    const readingOrigin = (await api(readingPath)).session; const readingTurnCount = turns.length;
    await page.getByRole('button', { name: '解释词语', exact: true }).click();
    const readingTurn = await lastTurnAfter(readingTurnCount); const readingEvents = await recordedTurn(readingTurn.requestId); await idle();
    assert(readingTurn.selectionTask === 'vocabulary' && readingTurn.readerAnchor?.segments[0].quote === 'incendiary' && readingTurn.selection?.segments[0].quote === 'incendiary', 'Reader-to-legacy article anchor translation changed the selected word');
    assert(readingEvents.some(event => event.type === 'message' && event.message.kind === 'quote' && event.message.content === 'incendiary'), 'Article shortcut did not emit the exact selected quote');
    const afterReading = await api(readingPath);
    assert(afterReading.session.currentIdx === readingOrigin.currentIdx && samePosition(afterReading.session.readerPosition, readingOrigin.readerPosition), 'Article question changed its bookmark');
    assert(tts.length === beforeReading.tts, 'Muted article made TTS');
    await page.reload(); await page.locator('[data-reader-document]').waitFor(); await mute();
    await closeTutor();
    assert(await sourceBlock(paragraphs[160].id).count() === 0, 'Article search fixture was already mounted');
    await page.getByRole('button', { name: '搜索本章全文', exact: true }).click(); await page.getByRole('textbox', { name: '搜索本章', exact: true }).fill('AFTERHUNDRED');
    await page.getByRole('region', { name: '本章全文搜索' }).getByRole('button').filter({ hasText: 'AFTERHUNDRED' }).click();
    await sourceBlock(paragraphs[160].id).waitFor(); assert(await page.locator('[data-reader-block]').count() >= 161, 'Article did not load beyond 100 continuous paragraphs');
    assert(samePosition((await api(readingPath)).session.readerPosition, readingOrigin.readerPosition), 'Article inspection overwrote the original bookmark');
    await page.getByRole('button', { name: '从这里继续', exact: true }).click();
    const continued = await until(() => api(readingPath), value => value.session.currentIdx >= 155 && !!value.session.readerPosition, 'article continued bookmark');
    const recovery = continued.session.readerPosition; await page.reload(); await page.locator('[data-reader-document]').waitFor(); await mute();
    const recovered = await targetRect(recovery);
    assert(recovered?.height > 0 && Math.abs(recovered.viewport - recovery.viewportOffset) < 12, 'Article did not restore the saved character beyond paragraph 100');
    assert(samePosition((await api(readingPath)).session.readerPosition, recovery), 'Article refresh changed the durable position');
    await page.getByRole('tab', { name: '我的笔记', exact: true }).click();
    assert(await page.getByRole('textbox', { name: '全文笔记', exact: true }).inputValue() === oldNotebook, 'Old article notebook was lost');
    assert((await api(readingPath)).personalNotes.some(note => note.id === oldAnnotation.id && note.content === legacyAnnotation && note.readerAnchor === null), 'Legacy annotation storage was replaced');
    await page.getByRole('button', { name: /^历史课堂笔记与练习/ }).click(); assert(await page.getByText(oldNote, { exact: false }).isVisible(), 'Old tutor notes are not visible');
    await page.getByRole('button', { name: /^原文：incendiary$/ }).click();
    await page.getByRole('button', { name: '回到阅读位置', exact: true }).waitFor(); await sourceBlock(paragraph.id).waitFor();
    assert(await sourceBlock(paragraph.id).locator('details').filter({ hasText: legacyAnnotation }).count() === 1, 'Legacy selection annotation failed the shared reader adapter');
    assert(samePosition((await api(readingPath)).session.readerPosition, recovery), 'Legacy note inspection changed the saved long-article bookmark');
    await page.getByRole('button', { name: '回到阅读位置', exact: true }).click();
    pass('old article targeted regression: silent entry, native word, legacy anchor, >100-paragraph search/restore and old notes', { readingId, readingSessionId, paragraphs: paragraphs.length });
    assert(pageErrors.length === 0, 'Browser page errors: ' + pageErrors.join(' | '));
    pass('no uncaught browser errors and no production-origin requests');
    console.log('BOOKS_BROWSER_RESULTS=' + JSON.stringify({ results, ids: { bookId, sessionId, readingId, readingSessionId }, screenshots: ['output/playwright/books-desktop.png', 'output/playwright/books-mobile.png', 'output/playwright/books-notes.png'], liveVoice: false }));
    return results;
  } catch (error) {
    results.push({ test: 'browser-books', outcome: 'failed', error: error.message });
    await page.evaluate(value => localStorage.setItem('books-browser-results', JSON.stringify(value)), { results, ids: { bookId, sessionId, readingId, readingSessionId }, pageErrors });
    console.log('BOOKS_BROWSER_RESULTS=' + JSON.stringify({ results, ids: { bookId, sessionId, readingId, readingSessionId }, pageErrors }));
    throw error;
  } finally {
    await page.unroute('**/api/tts'); await page.unroute('**/api/book-sessions/*/turn');
    if (originalSettings) await api('/api/settings', 'PUT', { models: originalSettings.models, fish: { enabled: originalSettings.fish.enabled }, autoContinue: originalSettings.autoContinue });
  }
}
