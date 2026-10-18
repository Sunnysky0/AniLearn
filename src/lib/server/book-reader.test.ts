import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { getTableConfig } from "drizzle-orm/pg-core";
import { bookBookmarks, bookReaderStates, bookVersions } from "@/db/schema";
import * as anchors from "@/lib/reader/anchors";
import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";

const nativeRequire = createRequire(import.meta.url);
function compiled(path: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", code)((name: string) => name in dependencies ? dependencies[name] : nativeRequire(name), loaded, loaded.exports);
  return loaded.exports;
}
function setup() {
  const units = ["empty", "c1", "c2"].map((id, order) => ({ id, title: `Chapter ${id}`, parentId: null, role: "main", order }));
  const document = (versionId = 3, unitId = "c1"): ReaderDocument => ({ key: `book:1:version:${versionId}`, title: unitId, language: "ja", unitId, units: units as ReaderDocument["units"],
    blocks: unitId === "empty" ? [] : [{ id: `b-${unitId}`, kind: "paragraph", nodes: [{ type: "text", text: "原文の意味と概念。😀 Repeated passage." }], anchorText: "" }] });
  const position = (unitId = "c1", offset = 3, versionId = 3): ReaderPosition => ({ documentKey: document(versionId).key, unitId, blockId: `b-${unitId}`, offset, viewportOffset: 0 });
  const table = (name: string) => new Proxy({ name }, { get(target, key) { return key === "name" ? target.name : { table: name, key: String(key) }; } });
  const tables = { bookSessions: table("sessions"), bookVersions: table("versions"), bookChapters: table("chapters"), bookChapterStates: table("learning"), bookReaderStates: table("states"), bookBookmarks: table("bookmarks") };
  const rows: Record<string, any[]> = {
    sessions: [{ id: 1, bookId: 1, versionId: 3, currentChapterId: "c1", updatedAt: new Date(1) },
      { id: 2, bookId: 1, versionId: 3, currentChapterId: "c2", updatedAt: new Date(2) },
      { id: 3, bookId: 1, versionId: 4, currentChapterId: "c1", updatedAt: new Date(3) },
      { id: 4, bookId: 1, versionId: 3, currentChapterId: "c1", updatedAt: new Date(4) }],
    versions: [{ id: 3, bookId: 1, status: "ready" }, { id: 4, bookId: 1, status: "ready" }],
    chapters: [3, 4].flatMap(versionId => units.map(unit => ({ ...unit, versionId, blocks: document(versionId, unit.id).blocks }))),
    learning: [{ id: 1, sessionId: 1, chapterId: "c1", position: position("c1", 2), learning: { stateRevision: 5, phase: "chapter_analysis" } },
      { id: 2, sessionId: 2, chapterId: "c2", position: position("c2", 6), learning: { stateRevision: 8, phase: "free_reading" } },
      { id: 3, sessionId: 3, chapterId: "c1", position: position("c1", 4, 4) },
      { id: 4, sessionId: 4, chapterId: "c1", position: null }],
    states: [], bookmarks: [],
  };
  const eq = (column: { key: string }, value: unknown) => (row: any) => row[column.key] === value;
  const and = (...conditions: ((row: any) => boolean)[]) => (row: any) => conditions.every(condition => condition(row));
  const sort = (column: { key: string }, direction: number) => ({ column, direction });
  let serial = 10; let failWrite = false; const writes: string[] = [];
  const mutate = (name: string, action: () => any) => {
    const pending: any = Promise.resolve().then(() => { if (failWrite) { failWrite = false; throw new Error("private SQL payload"); } writes.push(name); return action(); });
    pending.returning = () => pending; pending.onConflictDoNothing = () => pending; return pending;
  };
  const db: any = {
    select() {
      let name = ""; let predicate = () => true; let orders: any[] = [];
      const query: any = { from(table: { name: string }) { name = table.name; return query; }, where(condition: any) { predicate = condition; return query; }, orderBy(...value: any[]) { orders = value; return query; },
        then(resolve: any, reject: any) {
          const selected = rows[name].filter(predicate).slice().sort((a, b) => { for (const { column, direction } of orders) { const diff = a[column.key] < b[column.key] ? -1 : a[column.key] > b[column.key] ? 1 : 0; if (diff) return direction * diff; } return 0; });
          return Promise.resolve(selected).then(resolve, reject);
        } };
      return query;
    },
    insert(table: { name: string }) { return { values(value: any) { return mutate(table.name, () => {
      if (rows[table.name].some(row => row.versionId === value.versionId && (table.name !== "bookmarks" || row.clientId === value.clientId))) return [];
      const saved = { id: ++serial, revision: 0, updatedAt: new Date(), ...value }; rows[table.name].push(saved); return [saved];
    }); } }; },
    update(table: { name: string }) { return { set(value: any) { return { where(predicate: any) { return mutate(table.name, () => { const selected = rows[table.name].filter(predicate); for (const row of selected) Object.assign(row, value); return selected; }); } }; } }; },
    delete(table: { name: string }) { return { where(predicate: any) { return mutate(table.name, () => { const selected = rows[table.name].filter(predicate); rows[table.name] = rows[table.name].filter(row => !predicate(row)); return selected; }); } }; },
    async transaction(action: (tx: any) => Promise<unknown>) { return action(db); },
  };
  const service = compiled("src/lib/server/book-reader.ts", { "drizzle-orm": { eq, and, asc: (c: any) => sort(c, 1), desc: (c: any) => sort(c, -1), inArray: (c: any, values: any[]) => (row: any) => values.includes(row[c.key]) },
    "@/db": { db }, "@/db/books-schema": tables, "@/lib/reader/anchors": anchors,
    "./book-catalog": { validBookId: (value: string) => /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null,
      getBookDocument: async (_book: number, version: number, chapter: string) => units.some(unit => unit.id === chapter) ? document(version, chapter) : null } });
  const deps = { "@/lib/server/book-reader": service };
  const state = compiled("src/app/api/book-sessions/[id]/reader-state/route.ts", deps);
  const bookmarks = compiled("src/app/api/book-sessions/[id]/bookmarks/route.ts", deps);
  const bookmark = compiled("src/app/api/book-sessions/[id]/bookmarks/[bookmarkId]/route.ts", deps);
  const call = async (handler: typeof state, method: string, id = 1, body?: unknown, bookmarkId?: number) => {
    const response = await handler[method](new Request("http://test/reader", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id: String(id), bookmarkId: String(bookmarkId) }) });
    return { status: response.status, data: await response.json() };
  };
  return { rows, writes, state, bookmarks, bookmark, call, position, failNextWrite() { failWrite = true; } };
}

test("book reader fallback skips new classrooms, gathers each chapter and isolates versions", async () => {
  const s = setup(); const before = structuredClone(s.rows);
  const state = await s.call(s.state, "GET");
  assert.deepEqual(state.data.position, s.position("c2", 6));
  assert.deepEqual(state.data.chapterPositions, { c2: s.position("c2", 6), c1: s.position("c1", 2) });
  assert.equal((await s.call(s.state, "GET", 3)).data.position.documentKey, "book:1:version:4");
  assert.deepEqual(s.rows, before); assert.deepEqual(s.writes, []);
  s.rows.learning.forEach(row => { row.position = null; });
  assert.deepEqual((await s.call(s.state, "GET")).data.position, s.position("c1", 0));
});
test("cross-tutor writes atomically update last position and chapter map without touching teaching", async () => {
  const s = setup(); const teaching = structuredClone(s.rows.learning);
  const saved = await s.call(s.state, "PATCH", 1, { revision: 0, mutationId: "operation-1", position: s.position("c1", 9) });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 1);
  assert.deepEqual(saved.data.chapterPositions.c2, s.position("c2", 6));
  assert.deepEqual((await s.call(s.state, "GET", 2)).data.position, s.position("c1", 9));
  const second = await s.call(s.state, "PATCH", 2, { revision: 1, mutationId: "operation-2", position: s.position("c2", 11) });
  assert.equal(second.data.chapterPositions.c1.offset, 9); assert.equal(second.data.chapterPositions.c2.offset, 11);
  assert.deepEqual(s.rows.learning, teaching); assert.ok(s.writes.every(name => name === "states"));
  s.rows.sessions = s.rows.sessions.filter(row => row.id !== 1);
  assert.deepEqual((await s.call(s.state, "GET", 2)).data.position, s.position("c2", 11));
  assert.equal((await s.call(s.state, "GET", 3)).data.revision, 0);
});
test("book saves replay lost acknowledgements and reject stale or altered operations", async () => {
  const s = setup(); const body = { revision: 0, mutationId: "operation-1", position: s.position() };
  const first = await s.call(s.state, "PATCH", 1, body);
  assert.deepEqual(await s.call(s.state, "PATCH", 2, body), first);
  assert.equal((await s.call(s.state, "PATCH", 1, { ...body, position: s.position("c2") })).status, 409);
  assert.equal((await s.call(s.state, "PATCH", 1, { ...body, mutationId: "operation-2" })).status, 409);
  const concurrent = await Promise.all([1, 2].map(id => s.call(s.state, "PATCH", id, { revision: 1, mutationId: `concurrent-${id}`, position: s.position("c2", id) })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
});
test("book endpoints reject wrong versions, chapters, blocks, offsets and malformed revisions", async () => {
  const s = setup();
  for (const position of [{ ...s.position(), documentKey: "book:1:version:4" }, s.position("missing"), { ...s.position(), blockId: "b-c2" }, s.position("c1", 999), s.position("c1", -1)]) {
    assert.equal((await s.call(s.state, "PATCH", 1, { revision: 0, mutationId: "operation-1", position })).status, 400);
  }
  for (const revision of [-1, 0.5, 2147483647]) assert.equal((await s.call(s.state, "PATCH", 1, { revision, mutationId: "operation-1", position: s.position() })).status, 400);
  assert.equal((await s.call(s.state, "GET", 99)).status, 404);
  assert.equal((await s.call(s.state, "GET", 0)).status, 400);
  assert.deepEqual(s.writes, []);
});
test("book bookmarks share chapter labels and support idempotent creation, revisioned rename and removal", async () => {
  const s = setup(); const body = { clientId: "bookmark-1", position: s.position("c2", 5) };
  const created = await s.call(s.bookmarks, "POST", 1, body); const id = created.data.id;
  assert.equal(created.status, 200); assert.equal(created.data.chapterTitle, "Chapter c2"); assert.ok(created.data.excerpt);
  assert.deepEqual(await s.call(s.bookmarks, "POST", 2, body), created);
  assert.equal((await s.call(s.bookmarks, "POST", 1, { ...body, position: s.position("c1") })).status, 409);
  assert.equal((await s.call(s.bookmarks, "GET", 2)).data.length, 1);
  assert.deepEqual((await s.call(s.bookmarks, "GET", 3)).data, []);
  assert.equal((await s.call(s.bookmark, "PATCH", 2, { title: "重读概念", revision: 0 }, id)).data.title, "重读概念");
  assert.equal((await s.call(s.bookmark, "PATCH", 1, { title: "过期", revision: 0 }, id)).status, 409);
  assert.equal((await s.call(s.bookmark, "DELETE", 1, { revision: 0 }, id)).status, 409);
  assert.equal((await s.call(s.bookmark, "DELETE", 3, { revision: 1 }, id)).status, 200);
  assert.equal((await s.call(s.bookmarks, "GET", 1)).data.length, 1);
  assert.equal((await s.call(s.bookmark, "DELETE", 2, { revision: 1 }, id)).status, 200);
  assert.equal((await s.call(s.bookmark, "DELETE", 2, { revision: 1 }, id)).status, 200);
});
test("database failures stay retryable without disclosing SQL details", async () => {
  const s = setup(); s.failNextWrite();
  const result = await s.call(s.state, "PATCH", 1, { revision: 0, mutationId: "operation-1", position: s.position() });
  assert.equal(result.status, 500); assert.ok(!JSON.stringify(result.data).includes("private"));
  assert.equal(s.rows.states.length, 0);
});
test("book reader tables are version-owned with cascade cleanup and unique idempotency keys", () => {
  const state = getTableConfig(bookReaderStates); const bookmarks = getTableConfig(bookBookmarks);
  assert.ok(bookReaderStates.versionId.primary);
  for (const table of [state, bookmarks]) {
    const reference = table.foreignKeys[0]; assert.equal(reference.onDelete, "cascade"); assert.equal(reference.reference().foreignTable, bookVersions);
    assert.ok(!table.columns.some(column => column.name === "session_id"));
  }
  assert.ok(bookmarks.indexes.some(index => index.config.unique && index.config.name === "book_bookmarks_version_client_uq"));
});
