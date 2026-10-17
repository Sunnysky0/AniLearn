import test from "node:test";
import assert from "node:assert/strict";
import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import type { ReadingPositionMutation, ReadingReaderStateDTO } from "@/lib/types";
import { ReadingProgressController } from "./reading-progress";

const document: ReaderDocument = { key: "reading:2:3", title: "Article", language: "en", unitId: "article", units: [],
  blocks: [{ id: "p1", kind: "paragraph", nodes: [{ type: "text", text: "a".repeat(1000) }], anchorText: "" }] };
const position = (offset: number): ReaderPosition => ({ documentKey: document.key, unitId: "article", blockId: "p1", offset, viewportOffset: 0 });
const initial = (): ReadingReaderStateDTO => ({ documentKey: document.key, position: position(0), revision: 0, mutationId: null, updatedAt: null });
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const ack = (payload: ReadingPositionMutation) => Response.json({ documentKey: document.key, position: payload.position, revision: payload.revision + 1, mutationId: payload.mutationId, updatedAt: "2026-10-17T12:00:00Z" });
function options(fetcher: typeof fetch, cache = storage(), state = initial()) {
  let id = 0;
  return { document, url: "/api/reading-sessions/1/reader-state", initial: state, storage: cache, fetcher, id: () => `operation-${++id}`, delay: async () => undefined };
}

test("rapid page turns coalesce and an older response cannot replace a newer local position", async () => {
  const sent: ReadingPositionMutation[] = []; let release!: () => void; let active = 0; let maxActive = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = new ReadingProgressController(options(async (_url, request) => {
    active++; maxActive = Math.max(active, maxActive); const payload = JSON.parse(String(request?.body)); sent.push(payload);
    if (sent.length === 1) await gate;
    active--; return ack(payload);
  }));
  writer.update(position(10)); writer.update(position(20));
  const saving = writer.flush(); writer.update(position(30)); writer.update(position(40));
  assert.equal(sent.length, 1); assert.equal(sent[0].position.offset, 20);
  release(); assert.equal(await saving, true);
  assert.deepEqual(sent.map(row => row.position.offset), [20, 40]);
  assert.deepEqual(sent.map(row => row.revision), [0, 1]); assert.equal(maxActive, 1);
  assert.equal(writer.snapshot().position?.offset, 40); assert.equal(writer.snapshot().status, "saved");
  writer.detach();
});

test("a lost acknowledgement retries the same operation without incrementing its revision twice", async () => {
  const sent: ReadingPositionMutation[] = []; const cache = storage();
  const writer = new ReadingProgressController(options(async (_url, request) => {
    const payload = JSON.parse(String(request?.body)); sent.push(payload);
    if (sent.length === 1) throw new Error("connection lost after commit");
    return ack(payload);
  }, cache));
  writer.update(position(90)); assert.equal(await writer.flush(), true);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(cache.values.size, 0);
  writer.detach();
});

test("failed work survives closing and resumes with the original operation ID", async () => {
  const cache = storage(); const sent: ReadingPositionMutation[] = [];
  const first = new ReadingProgressController(options(async (_url, request) => { sent.push(JSON.parse(String(request?.body))); throw new Error("offline"); }, cache));
  first.update(position(121)); assert.equal(await first.flush(true), false);
  assert.equal(first.snapshot().status, "failed");
  const recovered = new ReadingProgressController(options(async (_url, request) => { sent.push(JSON.parse(String(request?.body))); return ack(sent.at(-1)!); }, cache));
  assert.equal(recovered.snapshot().position?.offset, 121); assert.equal(await recovered.flush(), true);
  assert.deepEqual(sent[0], sent[1]); assert.equal(cache.values.size, 0);
});

test("an already committed cached operation is recognized on reopen without another request", () => {
  const cache = storage(); const flight = { position: position(77), revision: 0, mutationId: "known-operation" };
  cache.setItem(`anilearn:reading-progress:${document.key}`, JSON.stringify({ documentKey: document.key, revision: 0, inFlight: flight, latest: flight.position }));
  const writer = new ReadingProgressController(options(async () => { throw new Error("must not request"); }, cache,
    { ...initial(), revision: 1, mutationId: flight.mutationId, position: flight.position }));
  assert.equal(writer.snapshot().status, "saved"); assert.equal(writer.snapshot().position?.offset, 77); assert.equal(cache.values.size, 0);
});

test("cross-window conflicts preserve local intent until an explicit save rebases it", async () => {
  const cache = storage(); let override = false; const requests: string[] = [];
  const writer = new ReadingProgressController(options(async (_url, request) => {
    requests.push(request?.method ?? "GET");
    if (!request?.method) return Response.json({ ...initial(), revision: 4, position: position(500) });
    if (!override) return Response.json({ error: "another window" }, { status: 409 });
    const payload = JSON.parse(String(request.body)); assert.equal(payload.revision, 4); return ack(payload);
  }, cache));
  writer.update(position(200)); assert.equal(await writer.flush(), false); assert.equal(writer.snapshot().status, "conflict");
  writer.update(position(250)); assert.equal(await writer.flush(), false); assert.deepEqual(requests, ["PATCH"]);
  assert.ok(cache.values.size); override = true; assert.equal(await writer.retry(), true);
  assert.deepEqual(requests, ["PATCH", "GET", "PATCH"]); assert.equal(writer.snapshot().position?.offset, 250);
});

test("hidden-page flush uses keepalive and transport retries remain bounded", async () => {
  let calls = 0;
  const writer = new ReadingProgressController(options(async (_url, request) => { calls++; assert.equal(request?.keepalive, true); throw new Error("offline"); }));
  writer.update(position(20)); assert.equal(await writer.flush(true), false); assert.equal(calls, 1);
  const second = new ReadingProgressController(options(async () => { calls++; throw new Error("offline"); }));
  second.update(position(30)); assert.equal(await second.flush(), false); assert.equal(calls, 4);
});

test("one window acknowledging its save does not remove another window's pending recovery record", async () => {
  const cache = storage();
  const sender: typeof fetch = async (_url, request) => ack(JSON.parse(String(request?.body)));
  const first = new ReadingProgressController({ ...options(sender, cache), ownerId: "first-tab" });
  const second = new ReadingProgressController({ ...options(sender, cache), ownerId: "second-tab" });
  first.update(position(15)); second.update(position(29));
  assert.equal(await first.flush(), true);
  const pending = JSON.parse(cache.getItem(first.storageKey)!);
  assert.equal(pending.entries["second-tab"].latest.offset, 29); assert.equal(pending.entries["first-tab"], undefined);
  assert.equal(await second.flush(), true); assert.equal(cache.values.size, 0);
});

test("invalid cached anchors and unavailable storage do not prevent normal reading", async () => {
  const cache = storage(); cache.setItem(`anilearn:reading-progress:${document.key}`, JSON.stringify({ documentKey: document.key, revision: 0, inFlight: null, latest: { ...position(20), blockId: "missing" } }));
  const writer = new ReadingProgressController(options(async (_url, request) => ack(JSON.parse(String(request?.body))), cache));
  assert.equal(writer.snapshot().position?.offset, 0);
  const locked = { getItem() { throw new Error("storage disabled"); }, setItem() { throw new Error("storage disabled"); }, removeItem() { throw new Error("storage disabled"); } };
  const second = new ReadingProgressController({ ...options(async (_url, request) => ack(JSON.parse(String(request?.body)))), storage: locked });
  second.update(position(1)); assert.equal(await second.flush(), true);
  cache.setItem(writer.storageKey, "{broken JSON");
  const third = new ReadingProgressController(options(async (_url, request) => ack(JSON.parse(String(request?.body))), cache));
  third.update(position(4)); assert.equal(await third.flush(), true); assert.equal(cache.values.size, 0);
});
