import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readingBookmarks, readingReaderStates, readings } from "@/db/schema";
import * as anchors from "@/lib/reader/anchors";
import * as adapter from "@/lib/reader/reading-adapter";
import type { ReadingDTO } from "@/lib/types";

const nativeRequire = createRequire(import.meta.url);
function compiled(path: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", code)((name: string) => name in dependencies ? dependencies[name] : nativeRequire(name), loaded, loaded.exports);
  return loaded.exports;
}
function setup() {
  const material: ReadingDTO = { id: 1, revision: 3, title: "Article", language: "ja", status: "ready", extracted: "", overview: "", error: null, createdAt: "2026-10-17", pageCount: 1,
    paragraphs: [{ id: "3-p1", text: "A repeated phrase. 日本語の文章。😀", page: 1 }, { id: "3-p2", text: "Another paragraph.", page: 1 }] };
  const document = adapter.readingDocument(material);
  const position = (offset = 0) => ({ documentKey: document.key, unitId: document.unitId, blockId: "3-p1", offset, viewportOffset: 0 });
  const table = (name: string) => new Proxy({ name }, { get(target, key) { return key === "name" ? target.name : { table: name, key: String(key) }; } });
  const tables = { readingSessions: table("sessions"), readingReaderStates: table("states"), readingBookmarks: table("bookmarks"), readings: table("materials"), tutors: table("tutors") };
  const rows: Record<string, any[]> = { sessions: [
    { id: 1, readingId: 1, tutorId: 1, snapshot: material, readerPosition: position(3), currentIdx: 0, updatedAt: new Date(1), learningState: { phase: "free_reading", stateRevision: 0 } },
    { id: 2, readingId: 1, tutorId: 2, snapshot: material, readerPosition: position(8), currentIdx: 0, updatedAt: new Date(2), learningState: { phase: "article_analysis", stateRevision: 7 } },
    { id: 3, readingId: 1, tutorId: 1, snapshot: { ...material, revision: 4, paragraphs: [{ id: "4-p1", text: "New version.", page: 1 }] }, readerPosition: null, currentIdx: 0, updatedAt: new Date(3) },
    { id: 4, readingId: 2, tutorId: 1, snapshot: { ...material, id: 2 }, readerPosition: null, currentIdx: 0, updatedAt: new Date(4) },
  ], states: [], bookmarks: [], materials: [material], tutors: [{ id: 1 }, { id: 2 }] };
  const writes: string[] = []; let failWrite = false; let serial = 100; let releases = 0;
  const eq = (column: { key: string }, value: unknown) => (row: any) => row[column.key] === value;
  const and = (...conditions: ((row: any) => boolean)[]) => (row: any) => conditions.every(condition => condition(row));
  const sort = (column: { key: string }, direction: number) => ({ column, direction });
  const sql = (_strings: TemplateStringsArray, ...values: any[]) => (row: any) => String(row.snapshot.revision) === values.at(-1);
  const mutate = (name: string, action: () => any) => {
    const pending: any = Promise.resolve().then(() => { if (failWrite) { failWrite = false; throw new Error("private database details"); } writes.push(name); return action(); });
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
      if (table.name !== "sessions" && rows[table.name].some(row => row.readingId === value.readingId && row.documentKey === value.documentKey && (table.name !== "bookmarks" || row.clientId === value.clientId))) return [];
      const saved = { id: ++serial, revision: 1, updatedAt: new Date(), ...value }; rows[table.name].push(saved); return [saved];
    }); } }; },
    update(table: { name: string }) { return { set(value: any) { return { where(predicate: any) { return mutate(table.name, () => { const selected = rows[table.name].filter(predicate); for (const row of selected) Object.assign(row, value); return selected; }); } }; } }; },
    delete(table: { name: string }) { return { where(predicate: any) { return mutate(table.name, () => { const selected = rows[table.name].filter(predicate); rows[table.name] = rows[table.name].filter(row => !predicate(row)); return selected; }); } }; },
    async transaction(action: (tx: any) => Promise<unknown>) { return action(db); },
  };
  const service = compiled("src/lib/server/reading-reader.ts", {
    "drizzle-orm": { eq, and, asc: (column: any) => sort(column, 1), desc: (column: any) => sort(column, -1), sql },
    "@/db": { db }, "@/db/schema": tables, "@/lib/reader/anchors": anchors, "@/lib/reader/reading-adapter": adapter,
    "./readings": { validId: (value: string) => /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null },
  });
  const deps = { "@/lib/server/reading-reader": service };
  const state = compiled("src/app/api/reading-sessions/[id]/reader-state/route.ts", deps);
  const bookmarks = compiled("src/app/api/reading-sessions/[id]/bookmarks/route.ts", deps);
  const bookmark = compiled("src/app/api/reading-sessions/[id]/bookmarks/[bookmarkId]/route.ts", deps);
  const create = compiled("src/app/api/reading-sessions/route.ts", { ...deps, "drizzle-orm": { eq }, "@/db": { db }, "@/db/schema": tables,
    "@/lib/server/readings": { readingDTO: () => material, initialReadingLearningState: () => ({ phase: "free_reading", stateRevision: 0 }) },
    "@/lib/server/locks": { tryOperationLock: async () => async () => { releases++; } }, "@/lib/reader/reading-adapter": adapter });
  const call = async (handlers: typeof state, method: string, id = 1, body?: unknown, bookmarkId?: number) => {
    const response = await handlers[method](new Request("http://test/reader", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: String(id), bookmarkId: String(bookmarkId) }) });
    return { status: response.status, data: await response.json() };
  };
  return { rows, writes, document, position, call, state, bookmarks, bookmark, create, releases: () => releases, failNextWrite() { failWrite = true; } };
}

test("same-version classrooms share reader state, while old versions remain independent", async () => {
  const env = setup(); const before = JSON.stringify(env.rows.sessions);
  const legacy = await env.call(env.state, "GET"); assert.equal(legacy.data.position.offset, 8); assert.equal(legacy.data.revision, 0); assert.equal(env.writes.length, 0);
  const saved = await env.call(env.state, "PATCH", 1, { position: env.position(12), revision: 0, mutationId: "position-operation" });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 1);
  assert.deepEqual((await env.call(env.state, "GET", 2)).data, saved.data);
  assert.equal((await env.call(env.state, "GET", 3)).data.revision, 0);
  assert.equal((await env.call(env.state, "GET", 3)).data.position.documentKey, "reading:1:4");
  assert.equal(JSON.stringify(env.rows.sessions), before, "reader writes must never mutate teaching state or old session fields");
});

test("legacy records fall back to their paragraph only in the matching immutable version", async () => {
  const env = setup(); env.rows.sessions[1].readerPosition = { ...env.position(), offset: 9999 }; env.rows.sessions[1].currentIdx = 1;
  const loaded = await env.call(env.state, "GET", 1);
  assert.equal(loaded.data.position.blockId, "3-p2"); assert.equal(loaded.data.position.offset, 0);
});

test("a new tutor classroom inherits the previous position before its new timestamp can mask legacy history", async () => {
  const env = setup();
  const created = await env.call(env.create, "POST", 1, { readingId: 1, tutorId: 2 });
  assert.equal(created.status, 200); assert.equal(env.releases(), 1);
  const session = env.rows.sessions.find(row => row.id === created.data.id);
  assert.equal(session.readerPosition.offset, 8); assert.equal(session.currentIdx, 0);
  assert.equal(session.learningState.phase, "free_reading"); assert.equal(session.learningState.stateRevision, 0);
  assert.deepEqual(env.writes, ["sessions"]);
});

test("reader writes are idempotent, reject changed payloads and cannot overwrite a newer revision", async () => {
  const env = setup(); const body = { position: env.position(9), revision: 0, mutationId: "idempotent-operation" };
  const first = await env.call(env.state, "PATCH", 1, body);
  assert.deepEqual(await env.call(env.state, "PATCH", 2, body), first); assert.equal(env.rows.states.length, 1);
  assert.equal((await env.call(env.state, "PATCH", 1, { ...body, position: env.position(10) })).status, 409);
  assert.equal((await env.call(env.state, "PATCH", 2, { ...body, mutationId: "another-operation" })).status, 409);
  assert.equal((await env.call(env.state, "PATCH", 1, { position: env.position(11), revision: 1, mutationId: "next-operation" })).status, 200);
  assert.equal((await env.call(env.state, "PATCH", 2, body)).status, 409);
  assert.equal(env.rows.states[0].position.offset, 11);
});

test("concurrent first saves create exactly one shared record and return a conflict to the loser", async () => {
  const env = setup();
  const result = await Promise.all([env.call(env.state, "PATCH", 1, { position: env.position(10), revision: 0, mutationId: "first-operation" }),
    env.call(env.state, "PATCH", 2, { position: env.position(12), revision: 0, mutationId: "second-operation" })]);
  assert.deepEqual(result.map(value => value.status).sort(), [200, 409]); assert.equal(env.rows.states.length, 1);
});

test("invalid anchors, revisions, request bodies and missing classrooms are rejected before writing", async () => {
  const env = setup();
  for (const body of [null, [], {}, { position: { ...env.position(), documentKey: "reading:1:4" }, revision: 0, mutationId: "valid-operation" },
    { position: env.position(9999), revision: 0, mutationId: "valid-operation" }, { position: env.position(), revision: -1, mutationId: "valid-operation" }]) {
    assert.equal((await env.call(env.state, "PATCH", 1, body)).status, 400);
  }
  assert.equal((await env.call(env.state, "GET", 999)).status, 404); assert.equal((await env.call(env.state, "GET", -1)).status, 400);
  assert.equal(env.writes.length, 0);
});

test("bookmarks create once, share across tutors, rename with revision guards and delete idempotently", async () => {
  const env = setup(); const request = { position: env.position(19), clientId: "bookmark-operation" };
  const added = await env.call(env.bookmarks, "POST", 1, request); assert.equal(added.status, 200); assert.ok(added.data.title.includes("日本語"));
  assert.deepEqual(await env.call(env.bookmarks, "POST", 2, request), added); assert.equal(env.rows.bookmarks.length, 1);
  assert.equal((await env.call(env.bookmarks, "GET", 2)).data.length, 1); assert.equal((await env.call(env.bookmarks, "GET", 3)).data.length, 0);
  const id = added.data.id;
  assert.equal((await env.call(env.bookmark, "PATCH", 1, { title: "重点重读", revision: 1 }, id)).status, 200);
  assert.equal((await env.call(env.bookmark, "PATCH", 2, { title: "过期修改", revision: 1 }, id)).status, 409);
  assert.equal((await env.call(env.bookmark, "DELETE", 1, { revision: 1 }, id)).status, 409);
  assert.equal((await env.call(env.bookmark, "DELETE", 4, { revision: 2 }, id)).status, 200);
  assert.equal(env.rows.bookmarks.length, 1, "another article cannot delete this bookmark");
  assert.equal((await env.call(env.bookmark, "DELETE", 2, { revision: 2 }, id)).status, 200);
  assert.equal((await env.call(env.bookmark, "DELETE", 2, { revision: 2 }, id)).status, 200); assert.equal(env.rows.bookmarks.length, 0);
});

test("deleting a classroom preserves article-owned records, and persistence errors do not leak database details", async () => {
  const env = setup(); await env.call(env.bookmarks, "POST", 1, { position: env.position(), clientId: "bookmark-operation" });
  env.rows.sessions = env.rows.sessions.filter(row => row.id !== 1);
  assert.equal((await env.call(env.bookmarks, "GET", 2)).data.length, 1);
  env.failNextWrite(); const failed = await env.call(env.state, "PATCH", 2, { position: env.position(10), revision: 0, mutationId: "position-operation" });
  assert.equal(failed.status, 500); assert.ok(!JSON.stringify(failed.data).includes("private database")); assert.equal(env.rows.states.length, 0);
});

test("schema uniqueness and ownership match the additive migration", () => {
  const migration = readFileSync("docs/migrations/20261017-reading-pagination.sql", "utf8");
  for (const table of [readingReaderStates, readingBookmarks]) {
    const config = getTableConfig(table);
    assert.equal(config.foreignKeys.length, 1); assert.equal(config.foreignKeys[0].reference().foreignTable, readings);
    assert.equal(config.foreignKeys[0].onDelete, "cascade");
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS ${config.name}`));
    for (const index of config.indexes) assert.ok(migration.includes(index.config.name!));
  }
  assert.ok(!/DROP\s+(TABLE|COLUMN)|TRUNCATE/i.test(migration));
});
