import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createTagParser, innerTag } from "./protocol";
import * as learning from "./book-learning";
import * as prompts from "./book-prompts";
import * as anchors from "@/lib/reader/anchors";

// Execute the actual handlers with isolated persistence and transport boundaries.
// No Next runtime, database connection, HTTP service or source rewriting is needed.
const nativeRequire = createRequire(import.meta.url);
function compiledModule(path: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const testModule = { exports: {} as Record<string, (...args: any[]) => any> };
  const execute = new Function("require", "module", "exports", compiled.outputText);
  execute((name: string) => name in dependencies ? dependencies[name] : nativeRequire(name), testModule, testModule.exports);
  return testModule.exports;
}
function fixture() {
  const document = { key: "book:2:version:3", title: "Chapter", language: "en", unitId: "c1", units: [],
    blocks: [{ id: "b1", kind: "paragraph" as const, anchorText: "current source passage", nodes: [{ type: "text" as const, text: "current source passage" }] }] };
  const state = { id: 1, sessionId: 1, chapterId: "c1", learning: learning.initialBookLearning("thought"), position: null,
    analysisDraft: { ...learning.initialBookAnalysis("prep"), status: "ready", context: "Context" } };
  const session = { id: 1, bookId: 2, versionId: 3, tutorId: 1, currentChapterId: "c1", status: "active", summary: "", summaryDraft: null, updatedAt: new Date() };
  const tutor = { id: 1, name: "导师", personality: "沉稳", teachingStyle: "启发", speakingStyle: "简洁", voiceStyle: "落ち着いた" };
  return { session, state, states: [state], document, tutor, material: { book: { kind: "thought", language: "en", title: "Book" }, chapters: [] } };
}
function persistence(bundle: ReturnType<typeof fixture>) {
  const table = (name: string) => new Proxy({ name }, { get(target, property) { return property === "name" ? target.name : { key: String(property) }; } });
  const tables = { bookTurns: table("turns"), bookMessages: table("messages"), bookPersonalNotes: table("notes"), bookSessions: table("sessions"), bookChapterStates: table("states") };
  const rows: Record<string, any[]> = { turns: [], messages: [], notes: [], sessions: [bundle.session], states: [bundle.state] };
  const eq = (column: { key: string }, value: unknown) => (row: any) => row[column.key] === value;
  const and = (...conditions: ((row: any) => boolean)[]) => (row: any) => conditions.every(condition => condition(row));
  let updates = 0; let ambiguousCommit = false;
  const db: any = {
    select() {
      let selected = ""; let predicate = () => true;
      const query: any = { from(table: { name: string }) { selected = table.name; return query; }, where(condition: any) { predicate = condition; return query; }, orderBy() { return query; },
        then(resolve: any, reject: any) { return Promise.resolve(rows[selected].filter(predicate)).then(resolve, reject); } };
      return query;
    },
    insert(table: { name: string }) {
      return { values(values: any) { const pending: any = Promise.resolve().then(() => {
        const result = (Array.isArray(values) ? values : [values]).map((value: any, index: number) => ({ id: rows[table.name].length + index + 1, status: "running", speech: "", attachments: [], kind: "text", language: "zh-CN", anchor: null, ...value }));
        rows[table.name].push(...result); return result;
      }); pending.returning = () => pending; return pending; } };
    },
    update(table: { name: string }) {
      return { set(values: any) { return { where(predicate: any) {
        const pending: any = Promise.resolve().then(() => { const matches = rows[table.name].filter(predicate); for (const row of matches) Object.assign(row, values); updates++; return matches; });
        pending.returning = () => pending; return pending;
      } }; } };
    },
    async transaction(callback: (tx: any) => Promise<unknown>) { const value = await callback(db); if (ambiguousCommit) { ambiguousCommit = false; throw new Error("commit acknowledgement lost"); } return value; },
  };
  return { tables, rows, db, eq, and, updates: () => updates, loseCommitAcknowledgement: () => { ambiguousCommit = true; } };
}
function handlers(options: { failFinalRead?: boolean; loseCommitAcknowledgement?: boolean; failFirstModel?: boolean } = {}) {
  const bundle = fixture(); const store = persistence(bundle); let loads = 0; let modelCalls = 0; let releases = 0;
  if (options.loseCommitAcknowledgement) store.loseCommitAcknowledgement();
  const dto = () => ({ ...bundle.session, chapters: bundle.states.map(state => ({ chapterId: state.chapterId, learning: state.learning, analysis: state.analysisDraft, position: state.position })) });
  const sessionDependencies = { async loadBookSession() { loads++; if (options.failFinalRead && loads === 2) throw new Error("read failed after commit"); return bundle; },
    bookMessageDTO: (row: any) => ({ ...row, attachmentCount: row.attachments.length }), bookSessionDTO: dto, bookStateDTO: (state: any) => state, bookNoteDTO: (row: any) => row,
    safeBookError: () => "请求失败，请重试。" };
  const loaded = compiledModule("src/app/api/book-sessions/[id]/turn/route.ts", {
    "drizzle-orm": { and: store.and, eq: store.eq, asc: (value: unknown) => value }, "@/db": { db: store.db }, "@/db/books-schema": store.tables,
    "@/lib/reader/anchors": anchors, "@/lib/server/book-catalog": { validBookId: (value: unknown) => Number(value) || null },
    "@/lib/server/book-sessions": sessionDependencies, "@/lib/server/book-learning": learning, "@/lib/server/book-prompts": prompts,
    "@/lib/server/locks": { async tryOperationLock() { return async () => { releases++; }; } }, "@/lib/server/settings": { async getSettings() { return {}; }, getLLMConfig() { return {}; } },
    "@/lib/server/llm": { parseDataUrl: () => null, async *streamChat(_cfg: unknown, input: any) { modelCalls++; if (options.failFirstModel && modelCalls === 1) throw new Error("transport interrupted");
      const targets = [...input.system.matchAll(/<quote lang="en" block="b1">current<\/quote>/g)].map(match => match[0]).join("");
      yield targets + "<msg><zh>这句话说明了当前概念。</zh><ja>[calm] この意味を確かめましょう。</ja></msg><action>wait</action>";
    } }, "@/lib/server/chat-input": { async readChatInputRequest(req: Request) { const body = await req.json(); return { body, text: body.text ?? "", images: [] }; } },
    "@/lib/server/protocol": { createTagParser, innerTag }, "@/lib/server/tutor-output": { async prepareTutorMessages(_cfg: unknown, zh: string, ja: string) { return [{ zh, ja }]; } },
    "@/lib/text": { hasJapaneseText: () => false }, "@/lib/server/data": { toTutorDTO: (tutor: unknown) => tutor }, "@/lib/server/book-analysis": { bookPreparationKey: () => "prep" },
  });
  const request = async (selected = false) => {
    const body = { requestId: "request-123456789", versionId: 3, chapterId: "c1", phase: "free_reading", stateRevision: 0, focus: null, text: "解释这个概念。",
      ...(selected ? { selectionTask: "meaning", anchor: anchors.anchorAt(bundle.document, "b1", 0, 7) } : {}) };
    const response = await loaded.POST(new Request("http://test/api/book-sessions/1/turn", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "1" }) });
    return (await response.text()).trim().split("\n").map((line: string) => JSON.parse(line));
  };
  return { request, rows: store.rows, modelCalls: () => modelCalls, releases: () => releases };
}

for (const selected of [false, true]) test(`${selected ? "selection" : "ordinary"} committed turn survives a final-read failure and replays without generating again`, async () => {
  const scenario = handlers({ failFinalRead: true }); const first = await scenario.request(selected);
  assert.ok(first.some((event: any) => event.type === "error")); assert.equal(scenario.rows.turns[0].status, "success");
  const before = scenario.rows.messages.map(row => row.id); const replay = await scenario.request(selected);
  assert.ok(replay.some((event: any) => event.type === "done")); assert.deepEqual(scenario.rows.messages.map(row => row.id), before);
  assert.equal(scenario.modelCalls(), 1); assert.equal(scenario.releases(), 2);
});
test("lost commit acknowledgement cannot downgrade persisted success", async () => {
  const scenario = handlers({ loseCommitAcknowledgement: true }); await scenario.request();
  assert.equal(scenario.rows.turns[0].status, "success"); const before = scenario.rows.messages.length;
  await scenario.request(); assert.equal(scenario.modelCalls(), 1); assert.equal(scenario.rows.messages.length, before);
});
test("a failure before commit remains resumable without duplicating the student message", async () => {
  const scenario = handlers({ failFirstModel: true }); await scenario.request(); assert.equal(scenario.rows.turns[0].status, "failed");
  await scenario.request(); assert.equal(scenario.rows.turns[0].status, "success"); assert.equal(scenario.modelCalls(), 2);
  assert.equal(scenario.rows.messages.filter(row => row.role === "user").length, 1);
});

for (const available of [false, true]) test(`chapter preparation ${available ? "starts only after owning its lock" : "cannot advance the chapter while another preparation owns the lock"}`, async () => {
  const bundle = fixture(); bundle.state.analysisDraft = { ...learning.initialBookAnalysis("old"), status: "idle" };
  const store = persistence(bundle); let sessionReleases = 0; let preparationReleases = 0; const tasks: (() => Promise<void>)[] = [];
  const loaded = compiledModule("src/lib/server/book-analysis.ts", {
    "drizzle-orm": { and: store.and, eq: store.eq }, "next/server": { after: (task: () => Promise<void>) => tasks.push(task) }, "@/db": { db: store.db }, "@/db/books-schema": store.tables,
    "@/lib/server/book-catalog": {}, "./book-catalog": { validBookId: (value: unknown) => Number(value) || null }, "./book-learning": learning,
    "./book-sessions": { async loadBookSession() { return bundle; }, safeBookError: () => "准备失败。" }, "./locks": { async tryOperationLock(kind: string) {
      if (kind === "bookSession") return async () => { sessionReleases++; };
      return available ? async () => { preparationReleases++; } : null;
    } }, "./llm": { async complete() { return "<book-context>本章辨析概念和论证。</book-context>"; } }, "./settings": { async getSettings() { return {}; }, getLLMConfig() { return {}; } },
    "./book-prompts": prompts, "@/lib/reader/anchors": anchors,
  });
  const response = await loaded.startBookAnalysis(new Request("http://test/api/book-sessions/1/analysis", { method: "POST", body: JSON.stringify({ action: "start", chapterId: "c1", stateRevision: 0, requestId: "request-123456789" }) }), { params: Promise.resolve({ id: "1" }) });
  assert.equal(sessionReleases, 1);
  if (!available) { assert.equal(response.status, 409); assert.equal(bundle.state.learning.phase, "free_reading"); assert.equal(store.updates(), 0); assert.equal(tasks.length, 0); }
  else { assert.equal(response.status, 202); assert.equal(bundle.state.learning.phase, "chapter_analysis"); assert.equal(bundle.state.analysisDraft.status, "running"); assert.equal(tasks.length, 1);
    assert.equal(preparationReleases, 0); await tasks[0](); assert.equal(preparationReleases, 1); assert.equal(bundle.state.analysisDraft.status, "ready"); }
});

function componentHarness(options: { analysisPhase?: boolean } = {}) {
  const bundle = fixture();
  if (options.analysisPhase) { bundle.state.learning = learning.changeBookLearning(bundle.state.learning, "thought", "start_analysis"); }
  const session = { ...bundle.session, chapters: [{ chapterId: "c1", learning: bundle.state.learning, analysis: bundle.state.analysisDraft, position: null }] };
  const props = { book: { id: 2, title: "Book", kind: "thought" }, session, document: bundle.document, tutor: { ...bundle.tutor, avatar: "/tutor.png" }, messages: [], notes: [], llmReady: true, analysisReady: true, ttsReady: false };
  const slots: any[] = []; let cursor = 0; const pendingEffects: (() => void)[] = [];
  const equal = (a: unknown[], b: unknown[]) => a?.length === b?.length && a.every((value, index) => value === b[index]);
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
  const loaded = compiledModule("src/components/books/BookClassroom.tsx", {
    react: hooks, "react/jsx-runtime": { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
    "next/link": defaultComponent("Link"), "next/image": defaultComponent("Image"), "lucide-react": new Proxy({}, { get: (_target, name) => String(name) }),
    "@/components/reader/Reader": defaultComponent("Reader"), "@/components/reader/ReadingWorkspace": defaultComponent("Workspace"),
    "@/components/ClassroomComposer": { ClassroomComposer: "Composer" }, "@/components/Markdown": { Markdown: "Markdown" },
    "@/lib/client/chat-attachments": { useChatAttachments: () => ({ images: [], processing: false, error: "", addFiles() {}, removeImage() {}, clearImages() {}, clearError() {} }) },
    "@/lib/client/speech-audio": { useSpeechAudioController: () => speech }, "@/lib/client/tutor-playback": { revealTutorMessage: async () => undefined },
    "@/lib/text": { tokenizeForReveal: (text: string) => [...text] }, "@/lib/reader/anchors": anchors, "@/lib/reader/dom-selection": { currentReaderPosition: () => visible },
  });
  const render = () => { cursor = 0; return loaded.default(props); };
  const runEffects = () => { for (const effect of pendingEffects.splice(0)) effect(); };
  const children = (node: any): any[] => Array.isArray(node) ? node : node && typeof node === "object" ? [node.props?.children, node.props?.tutor].filter(value => value != null) : [];
  const find = (node: any, predicate: (node: any) => boolean): any => { if (predicate(node)) return node; for (const child of children(node)) { const found = find(child, predicate); if (found) return found; } return null; };
  const text = (node: any): string => typeof node === "string" ? node : children(node).map(text).join(" ");
  let tree = render();
  const container = find(tree, node => !!node?.props?.ref && !!find(node.props.children, child => child?.type === "Reader"));
  container.props.ref.current = { querySelector: () => ({ getBoundingClientRect: () => ({ height: 500 }) }) };
  return { session, runEffects, render: () => { tree = render(); return tree; }, find: (type: string) => find(tree, node => node?.type === type), findLink: (href: string) => find(tree, node => node?.type === "Link" && node.props.href === href), text: () => text(tree), setVisible: (position: typeof visible) => { visible = position; }, visible: () => visible };
}
async function settle() { for (let index = 0; index < 10; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

test("a delayed preparation poll cannot replace a newer turn focus and notes", async () => {
  const view = componentHarness({ analysisPhase: true }); const originalFetch = globalThis.fetch;
  let releasePoll!: (value: Response) => void; const delayed = new Promise<Response>(resolve => { releasePoll = resolve; });
  const nextLearning = { ...view.session.chapters[0].learning, stateRevision: 2, currentFocus: "argument", analysisNotes: { concepts: "新的导读笔记。" } };
  globalThis.fetch = async (input) => String(input).includes("analysis-status") ? delayed : new Response(JSON.stringify({ type: "done", requestId: "test", action: "wait", session: { ...view.session, chapters: [{ ...view.session.chapters[0], learning: nextLearning }] } }) + "\n");
  try {
    view.runEffects(); view.find("Composer").props.onSend("讨论概念。", []); await settle(); view.render(); assert.ok(view.text().includes("论证过程"));
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
    view.find("Reader").props.onInspectionChange(true); view.setVisible({ ...permanent, offset: 19, viewportOffset: 100 });
    view.find("Composer").props.onSend("请解释阅读位置。", []); await settle(); assert.deepEqual(positions, [permanent]);
  } finally { globalThis.fetch = originalFetch; }
});
test("a bookmark lock conflict retries finitely and never sends a question with stale context", async () => {
  const view = componentHarness(); const originalFetch = globalThis.fetch; let saves = 0; let turns = 0;
  globalThis.fetch = async (_input, init) => { if (init?.method === "PATCH") { saves++; return Response.json({ error: "课堂正在生成。" }, { status: 409 }); } turns++; return Response.json({}); };
  try {
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
    assert.ok(view.findLink("/books"));
    view.find("Composer").props.onSend("解释当前段落。", []); await settle(); assert.equal(saves, 1);
    view.render(); assert.equal(view.find("Composer").props.busy, true); assert.ok(view.findLink("/books"));
    view.find("Composer").props.onStop(); await settle(); view.render();
    assert.equal(turns, 0); assert.equal(view.find("Composer").props.busy, false); assert.ok(view.findLink("/books"));
  } finally { globalThis.fetch = originalFetch; }
});
