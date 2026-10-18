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
