import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as learning from "@/lib/server/book-learning";
import * as anchors from "@/lib/reader/anchors";
import * as progressController from "./reading-progress";

const nativeRequire = createRequire(import.meta.url);
function compiledModule(path: string, dependencies: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", compiled)((name: string) => name in dependencies ? dependencies[name] : nativeRequire(name), loaded, loaded.exports);
  return loaded.exports;
}
function fixture() {
  const units = ["c1", "empty", "c2", "c3"].map((id, order) => ({ id, order, title: id, parentId: null, role: "main" as const, blockCount: id === "empty" ? 0 : 1 }));
  const document = { key: "book:2:version:3", title: "Chapter", language: "en", unitId: "c1", units,
    blocks: [{ id: "b1", kind: "paragraph" as const, anchorText: "current source passage", nodes: [{ type: "text" as const, text: "current source passage" }] }] };
  const state = { chapterId: "c1", learning: learning.initialBookLearning("thought"), position: null, analysisDraft: { ...learning.initialBookAnalysis("prep"), status: "ready", context: "Context" } };
  return { document, state, session: { id: 1, bookId: 2, versionId: 3, tutorId: 1, currentChapterId: "c1", status: "active", summary: "", summaryDraft: null, updatedAt: "now" }, tutor: { id: 1, name: "导师" } };
}
function componentHarness(options: { analysisPhase?: boolean; entryChapter?: string } = {}) {
  const bundle = fixture();
  if (options.analysisPhase) { bundle.state.learning = learning.changeBookLearning(bundle.state.learning, "thought", "start_analysis"); }
  const session = { ...bundle.session, chapters: ["c1", "c2", "c3"].map(chapterId => ({ chapterId, learning: bundle.state.learning, analysis: bundle.state.analysisDraft, position: null })) };
  const props = { book: { id: 2, title: "Book", kind: "thought" }, session, document: bundle.document, tutor: { ...bundle.tutor, avatar: "/tutor.png" }, messages: [], notes: [], initialReaderState: { documentKey: bundle.document.key, position: null }, initialBookmarks: [], llmReady: true, analysisReady: true, ttsReady: false };
  const slots: any[] = []; let cursor = 0; const pendingEffects: (() => void)[] = [];
  const equal = (a: unknown[], b: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
  const hooks = {
    useState(initial: any) { const id = cursor++; slots[id] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[id].value, (next: any) => { slots[id].value = typeof next === "function" ? next(slots[id].value) : next; }]; },
    useRef(initial: any) { const id = cursor++; slots[id] ??= { current: initial }; return slots[id]; },
    useCallback(callback: any, dependencies: unknown[]) { const id = cursor++; if (!slots[id] || !equal(slots[id].dependencies, dependencies)) slots[id] = { callback, dependencies }; return slots[id].callback; },
    useEffect(callback: any, dependencies: unknown[]) { const id = cursor++; if (!slots[id] || !equal(slots[id].dependencies, dependencies)) {
      const old = slots[id]; slots[id] = { dependencies, cleanup: old?.cleanup }; pendingEffects.push(() => { slots[id].cleanup?.(); slots[id].cleanup = callback(); });
    } },
  };
  const audio = { setEnabled() {}, cancelPending() {}, dispose() {}, retryFailed() {}, prefetch() {} };
  const speech = { controllerRef: { current: audio }, getController: () => audio };
  const defaultComponent = (name: string) => ({ __esModule: true, default: name });
  let visible = { documentKey: bundle.document.key, unitId: "c1", blockId: "b1", offset: 8, viewportOffset: 24 };
  const documents = new Map(["c1", "c2", "c3"].map(unitId => [unitId, { ...bundle.document, unitId }]));
  const savedPositions: any[] = [];
  const entry = { ...visible, unitId: options.entryChapter ?? "c1" };
  const progress = { ready: true, entryPosition: entry, position: entry, status: "saved", error: "", documents: { current: documents },
    chapterPositions: { current: { c1: { ...visible }, c2: { ...visible, unitId: "c2", offset: 12 } } as Record<string, typeof visible> },
    loadDocument: async (id: string) => documents.get(id), update(position: typeof visible) { savedPositions.push(position); progress.position = position; progress.chapterPositions.current[position.unitId] = position; }, retry() {} };
  const loaded = compiledModule("src/components/books/BookClassroom.tsx", {
    "@/lib/client/use-book-progress": { useBookProgress: () => progress }, "@/lib/client/use-reading-progress": { useReaderBookmarks: () => ({ bookmarks: [], create() {}, rename() {}, remove() {} }) },
    react: hooks, "react/jsx-runtime": { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
    "next/link": defaultComponent("Link"), "next/image": defaultComponent("Image"), "lucide-react": new Proxy({}, { get: (_target, name) => String(name) }),
    "@/components/reader/Reader": defaultComponent("Reader"), "@/components/reader/ReadingWorkspace": defaultComponent("Workspace"),
    "@/components/ClassroomComposer": { ClassroomComposer: "Composer" }, "@/components/Markdown": { Markdown: "Markdown" },
    "@/lib/client/chat-attachments": { useChatAttachments: () => ({ images: [], processing: false, error: "", addFiles() {}, removeImage() {}, clearImages() {}, clearError() {} }) },
    "@/lib/client/speech-audio": { useSpeechAudioController: () => speech }, "@/lib/client/tutor-playback": { revealTutorMessage: async () => undefined },
    "@/lib/text": { tokenizeForReveal: (text: string) => [...text] }, "@/lib/reader/anchors": anchors, "@/lib/reader/dom-selection": { currentReaderPosition: () => visible },
  });
  const render = () => { cursor = 0; const value = loaded.default(props); const reader = find(value, node => node?.type === "Reader"); if (reader) reader.props.handleRef.current = { getPosition: () => visible }; return value; };
  const runEffects = () => { for (const effect of pendingEffects.splice(0)) effect(); };
  const children = (node: any): any[] => Array.isArray(node) ? node : node && typeof node === "object" ? [node.props?.children, node.props?.tutor].filter(value => value != null) : [];
  const find = (node: any, predicate: (node: any) => boolean): any => { if (predicate(node)) return node; for (const child of children(node)) { const found = find(child, predicate); if (found) return found; } return null; };
  const text = (node: any): string => typeof node === "string" ? node : children(node).map(text).join(" ");
  let tree = render();
  return { session, documents, savedPositions, progress, ready: async () => { runEffects(); await settle(); tree = render(); runEffects(); await settle(); tree = render(); },
    payload: (chapterId: string) => ({ session: { ...session, currentChapterId: chapterId }, document: documents.get(chapterId), book: props.book, tutor: props.tutor, messages: [], notes: [] }), runEffects, render: () => { tree = render(); return tree; }, find: (type: string) => find(tree, node => node?.type === type), findLink: (href: string) => find(tree, node => node?.type === "Link" && node.props.href === href), text: () => text(tree), setVisible: (position: typeof visible) => { visible = position; }, visible: () => visible };
}
async function settle() { for (let index = 0; index < 10; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

test("book entry restores a different shared chapter without changing learning or starting a turn", async () => {
  const view = componentHarness({ entryChapter: "c2" }); const original = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(input), body });
    return Response.json(view.payload(body?.chapterId ?? new URL(String(input), "http://test").searchParams.get("chapterId")!));
  };
  try {
    await view.ready();
    const reader = view.find("Reader").props;
    assert.equal(reader.layout, "paged"); assert.equal(reader.contentKind, "book");
    assert.equal(reader.document.unitId, "c2"); assert.equal(reader.navigation.position.offset, 8);
    assert.equal(reader.entryPosition.unitId, "c2"); assert.equal(view.savedPositions.length, 0);
    assert.deepEqual(calls.filter(call => call.body).map(call => call.body.action), ["chapter"]);
    assert.ok(calls.every(call => !/turn|tts|analysis/.test(call.url)));
    assert.equal(view.payload("c2").session.chapters[1].learning.readingConfirmedAt, null);
  } finally { globalThis.fetch = original; }
});

test("bookmarks, chapter history and full-book start restore distinct canonical characters", async () => {
  const view = componentHarness(); const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    return Response.json(view.payload(body?.chapterId ?? new URL(String(input), "http://test").searchParams.get("chapterId")!));
  };
  try {
    await view.ready(); const entry = view.find("Reader").props.entryPosition;
    view.find("Reader").props.onUnitChange("c2", false); await settle(); view.render();
    assert.equal(view.find("Reader").props.navigation.position.offset, 12);
    const bookmark = { ...entry, unitId: "c3", offset: 18 };
    view.find("Reader").props.onNavigatePosition(bookmark); await settle(); view.render();
    assert.deepEqual(view.find("Reader").props.navigation.position, bookmark);
    view.find("Reader").props.onStart(); await settle(); view.render();
    assert.equal(view.find("Reader").props.document.unitId, "c1"); assert.equal(view.find("Reader").props.navigation.position.offset, 0);
    assert.deepEqual(view.find("Reader").props.entryPosition, entry);
    assert.deepEqual(view.savedPositions.map(position => [position.unitId, position.offset]), [["c2", 12], ["c3", 18], ["c1", 0]]);
  } finally { globalThis.fetch = original; }
});

test("cross-chapter inspection and returning preserve the resume point until explicit continuation", async () => {
  const view = componentHarness(); const original = globalThis.fetch; const mutations: any[] = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) mutations.push(body);
    return Response.json(view.payload(body?.chapterId ?? new URL(String(input), "http://test").searchParams.get("chapterId")!));
  };
  try {
    await view.ready(); const origin = view.find("Reader").props.entryPosition;
    view.find("Reader").props.onInspectionChange(true); view.find("Reader").props.onUnitChange("c2", true);
    await settle(); view.render(); assert.equal(view.find("Reader").props.document.unitId, "c2");
    assert.equal(view.savedPositions.length, 0); assert.equal(mutations.length, 0);
    view.find("Reader").props.onNavigatePosition(origin, false); await settle(); view.render();
    assert.equal(view.find("Reader").props.document.unitId, "c1"); assert.equal(view.savedPositions.length, 0);
    view.find("Reader").props.onInspectionChange(true); view.find("Reader").props.onUnitChange("c2", true); await settle(); view.render();
    const target = { ...origin, unitId: "c2", offset: 16 };
    view.find("Reader").props.onNavigatePosition(target); await settle(); view.render();
    assert.deepEqual(view.savedPositions, [target]); assert.deepEqual(mutations.map(body => body.action), ["chapter"]);
  } finally { globalThis.fetch = original; }
});

test("obsolete chapter activations roll back before the latest navigation, and failures retain the source", async () => {
  const view = componentHarness(); const original = globalThis.fetch; const mutations: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) { mutations.push(body.chapterId); if (body.chapterId === "c2") await gate; }
    return Response.json(view.payload(body?.chapterId ?? new URL(String(input), "http://test").searchParams.get("chapterId")!));
  };
  try {
    await view.ready(); view.find("Reader").props.onUnitChange("c2"); await settle();
    view.find("Reader").props.onUnitChange("c3"); release(); await settle(); view.render();
    assert.equal(view.find("Reader").props.document.unitId, "c3");
    assert.deepEqual(mutations, ["c2", "c1", "c3"]);
    assert.deepEqual(view.savedPositions.map(position => position.unitId), ["c3"]);
    globalThis.fetch = async () => Response.json({ error: "章节加载失败。" }, { status: 503 });
    view.find("Reader").props.onUnitChange("c2"); await settle(); view.render();
    assert.equal(view.find("Reader").props.document.unitId, "c3"); assert.ok(view.text().includes("章节加载失败。"));
    assert.equal(view.savedPositions.length, 1);
  } finally { globalThis.fetch = original; }
});

test("an ordinary question retry reuses its original paged character after a later page turn", async () => {
  const view = componentHarness(); const original = globalThis.fetch; const saved: any[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (init?.method === "PATCH") { saved.push(body.position); return Response.json(view.session); }
    return Response.json({ error: "请求暂时失败。" }, { status: 503 });
  };
  try {
    await view.ready(); const originalPosition = view.visible();
    view.find("Composer").props.onSend("解释这一段。", []); await settle(); view.render();
    view.setVisible({ ...originalPosition, offset: 20 });
    const tree = view.render();
    const findRetry = (node: any): any => {
      if (node?.type === "button" && node.props.children === "重试提问") return node;
      for (const child of Array.isArray(node) ? node : node?.props?.children ? [node.props.children] : []) { const found = findRetry(child); if (found) return found; }
      return null;
    };
    const retry = findRetry(tree); assert.ok(retry); retry.props.onClick(); await settle();
    assert.deepEqual(saved, [originalPosition, originalPosition]);
  } finally { globalThis.fetch = original; }
});

test("a lost chapter activation acknowledgement restores the original chapter without saving the target", async () => {
  const view = componentHarness(); const original = globalThis.fetch; const mutations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) { mutations.push(body.chapterId); if (body.chapterId === "c2") throw new Error("connection lost after chapter commit"); }
    return Response.json(view.payload(body?.chapterId ?? new URL(String(input), "http://test").searchParams.get("chapterId")!));
  };
  try {
    await view.ready(); view.find("Reader").props.onUnitChange("c2"); await settle(); view.render();
    assert.deepEqual(mutations, ["c2", "c1"]); assert.equal(view.find("Reader").props.document.unitId, "c1");
    assert.equal(view.savedPositions.length, 0); assert.ok(view.text().includes("connection lost"));
  } finally { globalThis.fetch = original; }
});

test("a delayed preparation poll cannot replace a newer turn focus and notes", async () => {
  const view = componentHarness({ analysisPhase: true }); const originalFetch = globalThis.fetch;
  let releasePoll!: (value: Response) => void; const delayed = new Promise<Response>(resolve => { releasePoll = resolve; });
  const nextLearning = { ...view.session.chapters[0].learning, stateRevision: 2, currentFocus: "argument", analysisNotes: { concepts: "新的导读笔记。" } };
  globalThis.fetch = async (input) => String(input).includes("analysis-status") ? delayed : new Response(JSON.stringify({ type: "done", requestId: "test", action: "wait", session: { ...view.session, chapters: [{ ...view.session.chapters[0], learning: nextLearning }] } }) + "\n");
  try {
    await view.ready(); view.find("Composer").props.onSend("讨论概念。", []); await settle(); view.render(); assert.ok(view.text().includes("论证过程"));
    releasePoll(Response.json({ status: "ready", running: false, chapterId: "c1", learning: view.session.chapters[0].learning })); await settle(); view.render();
    assert.ok(view.text().includes("论证过程")); assert.ok(!view.text().includes("本章导读 · 核心概念"));
  } finally { globalThis.fetch = originalFetch; }
});
test("an ordinary question awaits the visible bookmark even before the reader scroll debounce", async () => {
  const view = componentHarness(); const originalFetch = globalThis.fetch; const calls: { method: string; body: any }[] = [];
  let finishBookmark!: () => void; const pending = new Promise<void>(resolve => { finishBookmark = resolve; });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ method: init!.method!, body });
    if (init?.method === "PATCH") { await pending; return Response.json({ ...view.session, chapters: [{ ...view.session.chapters[0], position: body.position }] }); }
    return new Response(JSON.stringify({ type: "done", requestId: body.requestId, action: "wait", session: view.session }) + "\n");
  };
  try {
    await view.ready();
    view.find("Composer").props.onSend("解释当前段落。", []); await settle();
    assert.deepEqual(calls.map(call => call.method), ["PATCH"]); assert.deepEqual(calls[0].body.position, view.visible());
    finishBookmark(); await settle(); assert.deepEqual(calls.map(call => call.method), ["PATCH", "POST"]);
  } finally { globalThis.fetch = originalFetch; }
});
test("ordinary questions during temporary inspection flush the preserved permanent position", async () => {
  const view = componentHarness(); const originalFetch = globalThis.fetch; const positions: unknown[] = []; const permanent = view.visible();
  globalThis.fetch = async (_input, init) => { const body = JSON.parse(String(init?.body)); if (init?.method === "PATCH") { positions.push(body.position); return Response.json(view.session); }
    return new Response(JSON.stringify({ type: "done", requestId: body.requestId, action: "wait", session: view.session }) + "\n"); };
  try {
    await view.ready();
    view.find("Reader").props.onInspectionChange(true); view.setVisible({ ...permanent, offset: 19, viewportOffset: 100 });
    view.find("Composer").props.onSend("请解释阅读位置。", []); await settle(); assert.deepEqual(positions, [permanent]);
  } finally { globalThis.fetch = originalFetch; }
});
test("a bookmark lock conflict retries finitely and never sends a question with stale context", async () => {
  const view = componentHarness(); const originalFetch = globalThis.fetch; let saves = 0; let turns = 0;
  globalThis.fetch = async (_input, init) => { if (init?.method === "PATCH") { saves++; return Response.json({ error: "课堂正在生成。" }, { status: 409 }); } turns++; return Response.json({}); };
  try {
    await view.ready();
    view.find("Composer").props.onSend("解释当前段落。", []);
    const deadline = Date.now() + 3000; while (saves < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await settle(); view.render(); assert.equal(saves, 4); assert.equal(turns, 0); assert.ok(view.text().includes("课堂正在生成。"));
  } finally { globalThis.fetch = originalFetch; }
});
test("cancelled bookmark flushing stops the question and keeps direct exit available", async () => {
  const view = componentHarness(); const originalFetch = globalThis.fetch; let saves = 0; let turns = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "PATCH") { turns++; return Response.json({}); }
    saves++;
    return await new Promise<Response>((_resolve, reject) => { const signal = init.signal!;
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  };
  try {
    await view.ready();
    assert.ok(view.findLink("/books"));
    view.find("Composer").props.onSend("解释当前段落。", []); await settle(); assert.equal(saves, 1);
    view.render(); assert.equal(view.find("Composer").props.busy, true); assert.ok(view.findLink("/books"));
    view.find("Composer").props.onStop(); await settle(); view.render();
    assert.equal(turns, 0); assert.equal(view.find("Composer").props.busy, false); assert.ok(view.findLink("/books"));
  } finally { globalThis.fetch = originalFetch; }
});

test("book progress loads pending chapters before validation, survives document changes and flushes on hide", async () => {
  const original = { window: globalThis.window, fetch: globalThis.fetch };
  const bundle = fixture();
  const cache = new Map<string, string>();
  const key = `anilearn:book-progress:${bundle.document.key}`;
  const first = { documentKey: bundle.document.key, unitId: "c1", blockId: "b1", offset: 7, viewportOffset: 0 };
  const second = { ...first, unitId: "c2", offset: 13 };
  const mutation = { position: first, revision: 0, mutationId: "pending-operation" };
  cache.set(key, JSON.stringify({ version: 1, entries: { "test-tab": { documentKey: bundle.document.key, revision: 0, latest: second, inFlight: mutation, positions: [first, second] } } }));
  const storage = { getItem: (name: string) => cache.get(name) ?? null, setItem: (name: string, value: string) => { cache.set(name, value); }, removeItem: (name: string) => { cache.delete(name); } };
  const events = new Map<string, () => void>();
  const sessionStorage = { getItem: () => "test-tab", setItem() {} };
  const page = { visibilityState: "visible", addEventListener: (name: string, callback: () => void) => events.set(name, callback), removeEventListener: (name: string) => events.delete(name) };
  globalThis.window = { localStorage: storage, sessionStorage, document: page, addEventListener: page.addEventListener, removeEventListener: page.removeEventListener } as unknown as Window & typeof globalThis;
  const calls: { url: string; body: any; keepalive: boolean | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ url: String(input), body, keepalive: init?.keepalive });
    if (!body) return Response.json({ document: { ...bundle.document, unitId: "c2" } });
    return Response.json({ documentKey: bundle.document.key, position: body.position, revision: body.revision + 1, mutationId: body.mutationId, updatedAt: "now" });
  };
  const slots: any[] = []; const effects: (() => void)[] = []; let cursor = 0;
  const same = (a: any[], b: any[]) => !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
  const hooks = {
    useState(initial: any) { const id = cursor++; slots[id] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[id].value, (value: any) => { slots[id].value = typeof value === "function" ? value(slots[id].value) : value; }]; },
    useRef(initial: any) { const id = cursor++; slots[id] ??= { current: initial }; return slots[id]; },
    useCallback(callback: any, deps: any[]) { const id = cursor++; if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, callback }; return slots[id].callback; },
    useEffect(callback: any, deps: any[]) { const id = cursor++; if (!slots[id] || !same(slots[id].deps, deps)) { slots[id]?.cleanup?.(); slots[id] = { deps }; effects.push(() => { slots[id].cleanup = callback(); }); } },
  };
  const loaded = compiledModule("src/lib/client/use-book-progress.ts", { react: hooks, "@/lib/reader/anchors": anchors, "./reading-progress": progressController });
  const initial = { documentKey: bundle.document.key, position: first, chapterPositions: { c1: first }, revision: 0, mutationId: null, updatedAt: null };
  const render = () => { cursor = 0; const value = loaded.useBookProgress(bundle.document, 1, initial); for (const effect of effects.splice(0)) effect(); return value; };
  try {
    assert.equal(render().ready, false); await settle();
    let view = render(); assert.equal(view.ready, true); assert.deepEqual(view.entryPosition, second);
    assert.deepEqual(view.chapterPositions.current, { c1: first, c2: second });
    assert.deepEqual(calls.filter(call => call.body).map(call => call.body.position), [first, second]);
    assert.deepEqual(calls.find(call => call.body)?.body, mutation); assert.equal(cache.size, 0);
    const positions = calls.length;
    await view.loadDocument("c2"); view = render(); assert.equal(calls.length, positions);
    view.update({ ...first, offset: 18 }); page.visibilityState = "hidden"; events.get("visibilitychange")!(); await settle();
    assert.equal(calls.at(-1)?.keepalive, true); assert.equal(calls.at(-1)?.body.position.offset, 18);
    assert.deepEqual(render().entryPosition, second); assert.equal(cache.size, 0);
    assert.ok(calls.every(call => !/turn|tts|analysis/.test(call.url)));
  } finally {
    for (const slot of slots) slot?.cleanup?.();
    globalThis.window = original.window; globalThis.fetch = original.fetch;
  }
});
