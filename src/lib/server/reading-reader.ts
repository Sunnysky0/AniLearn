import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readingBookmarks, readingReaderStates, readingSessions } from "@/db/schema";
import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import type { ReadingBookmarkDTO, ReadingReaderStateDTO } from "@/lib/types";
import { blockText, validateReaderPosition } from "@/lib/reader/anchors";
import { readingDocument, readingInitialPosition } from "@/lib/reader/reading-adapter";
import { validId } from "./readings";

export class ReadingReaderError extends Error {
  constructor(readonly status: number, message: string, readonly state?: ReadingReaderStateDTO) { super(message); }
}
export interface ReadingReaderContext { readingId: number; document: ReaderDocument; sourceRevision: number }
type StateRow = typeof readingReaderStates.$inferSelect;
type BookmarkRow = typeof readingBookmarks.$inferSelect;

export async function readingReaderContext(value: string): Promise<ReadingReaderContext> {
  const id = validId(value);
  if (!id) throw new ReadingReaderError(400, "课堂 ID 无效。");
  const [row] = await db.select({ readingId: readingSessions.readingId, snapshot: readingSessions.snapshot })
    .from(readingSessions).where(eq(readingSessions.id, id));
  if (!row) throw new ReadingReaderError(404, "课堂不存在。");
  return { readingId: row.readingId, document: readingDocument(row.snapshot), sourceRevision: row.snapshot.revision };
}

function stateDTO(row: StateRow): ReadingReaderStateDTO {
  return { documentKey: row.documentKey, position: row.position, revision: row.revision,
    mutationId: row.mutationId, updatedAt: row.updatedAt.toISOString() };
}
function bookmarkDTO(row: BookmarkRow): ReadingBookmarkDTO {
  return { id: row.id, clientId: row.clientId, position: row.position, title: row.title, excerpt: row.excerpt,
    revision: row.revision, updatedAt: row.updatedAt.toISOString() };
}
function stateScope(ctx: ReadingReaderContext) {
  return and(eq(readingReaderStates.readingId, ctx.readingId), eq(readingReaderStates.documentKey, ctx.document.key));
}
function bookmarkScope(ctx: ReadingReaderContext) {
  return and(eq(readingBookmarks.readingId, ctx.readingId), eq(readingBookmarks.documentKey, ctx.document.key));
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadingReaderError(400, "请求格式不正确。");
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 2147483647) throw new ReadingReaderError(400, "修订号无效。");
  return value as number;
}
function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new ReadingReaderError(400, "操作标识无效。");
  return value;
}
function position(ctx: ReadingReaderContext, value: unknown): ReaderPosition {
  const result = validateReaderPosition(ctx.document, value);
  if (!result) throw new ReadingReaderError(400, "阅读位置与当前文章不匹配，请重新定位。");
  return result;
}
function samePosition(a: ReaderPosition, b: ReaderPosition) {
  return a.documentKey === b.documentKey && a.unitId === b.unitId && a.blockId === b.blockId && a.offset === b.offset && a.viewportOffset === b.viewportOffset;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 120) throw new ReadingReaderError(400, "书签名称须为 1–120 个字符。");
  return value.trim();
}

export async function getReadingReaderState(ctx: ReadingReaderContext): Promise<ReadingReaderStateDTO> {
  const [row] = await db.select().from(readingReaderStates).where(stateScope(ctx));
  if (row) return stateDTO(row);
  // Old classrooms have no reading timestamp separate from updatedAt. Select the
  // latest valid position in this exact snapshot revision, without changing it.
  const legacy = await db.select({ readerPosition: readingSessions.readerPosition, currentIdx: readingSessions.currentIdx })
    .from(readingSessions).where(and(eq(readingSessions.readingId, ctx.readingId), sql`${readingSessions.snapshot}->>'revision' = ${String(ctx.sourceRevision)}`))
    .orderBy(desc(readingSessions.updatedAt), desc(readingSessions.id));
  let fallback: ReaderPosition | null = null;
  for (const row of legacy) {
    fallback = readingInitialPosition(ctx.document, row.readerPosition, row.currentIdx);
    if (fallback) break;
  }
  return { documentKey: ctx.document.key, position: fallback, revision: 0, mutationId: null, updatedAt: null };
}

export async function saveReadingReaderState(ctx: ReadingReaderContext, value: unknown): Promise<ReadingReaderStateDTO> {
  const body = objectBody(value); const nextPosition = position(ctx, body.position);
  const expected = revision(body.revision); const mutationId = operationId(body.mutationId);
  return db.transaction(async tx => {
    const [old] = await tx.select().from(readingReaderStates).where(stateScope(ctx));
    const replay = (row: StateRow) => {
      if (row.mutationId !== mutationId) return null;
      if (row.revision !== expected + 1 || !samePosition(row.position, nextPosition)) throw new ReadingReaderError(409, "同一操作不能保存不同位置。", stateDTO(row));
      return stateDTO(row);
    };
    if (old) {
      const saved = replay(old); if (saved) return saved;
      if (old.revision !== expected) throw new ReadingReaderError(409, "阅读位置已在其他窗口更新。", stateDTO(old));
    } else if (expected !== 0) throw new ReadingReaderError(409, "阅读位置记录已变化，请重新同步。");
    const values = { position: nextPosition, revision: expected + 1, mutationId, updatedAt: new Date() };
    const [saved] = old
      ? await tx.update(readingReaderStates).set(values).where(and(stateScope(ctx), eq(readingReaderStates.revision, expected))).returning()
      : await tx.insert(readingReaderStates).values({ readingId: ctx.readingId, documentKey: ctx.document.key, ...values }).onConflictDoNothing().returning();
    if (saved) return stateDTO(saved);
    const [current] = await tx.select().from(readingReaderStates).where(stateScope(ctx));
    if (current) { const saved = replay(current); if (saved) return saved; }
    throw new ReadingReaderError(409, "阅读位置已在其他窗口更新。", current ? stateDTO(current) : undefined);
  });
}

export async function getReadingBookmarks(ctx: ReadingReaderContext): Promise<ReadingBookmarkDTO[]> {
  const rows = await db.select().from(readingBookmarks).where(bookmarkScope(ctx)).orderBy(asc(readingBookmarks.id));
  return rows.map(bookmarkDTO);
}
export async function createReadingBookmark(ctx: ReadingReaderContext, value: unknown): Promise<ReadingBookmarkDTO> {
  const body = objectBody(value); const nextPosition = position(ctx, body.position); const clientId = operationId(body.clientId);
  const block = ctx.document.blocks.find(block => block.id === nextPosition.blockId)!;
  const text = blockText(block); const excerpt = Array.from(text.slice(nextPosition.offset) || text).slice(0, 80).join("");
  const nextTitle = body.title === undefined ? Array.from(excerpt).slice(0, 28).join("") || "阅读书签" : title(body.title);
  return db.transaction(async tx => {
    const [inserted] = await tx.insert(readingBookmarks).values({ readingId: ctx.readingId, documentKey: ctx.document.key,
      clientId, position: nextPosition, title: nextTitle, excerpt }).onConflictDoNothing().returning();
    if (inserted) return bookmarkDTO(inserted);
    const [existing] = await tx.select().from(readingBookmarks).where(and(bookmarkScope(ctx), eq(readingBookmarks.clientId, clientId)));
    if (!existing || !samePosition(existing.position, nextPosition)) throw new ReadingReaderError(409, "同一书签操作不能指向不同位置。");
    return bookmarkDTO(existing);
  });
}
export async function changeReadingBookmark(ctx: ReadingReaderContext, idValue: string, value: unknown, remove = false): Promise<ReadingBookmarkDTO | { ok: true }> {
  const id = validId(idValue); if (!id) throw new ReadingReaderError(400, "书签 ID 无效。");
  const body = objectBody(value); const expected = revision(body.revision);
  const nextTitle = remove ? null : title(body.title);
  return db.transaction(async tx => {
    const scope = and(bookmarkScope(ctx), eq(readingBookmarks.id, id));
    if (remove) {
      const deleted = await tx.delete(readingBookmarks).where(and(scope, eq(readingBookmarks.revision, expected))).returning();
      if (deleted.length) return { ok: true };
      const [existing] = await tx.select().from(readingBookmarks).where(scope);
      if (!existing) return { ok: true };
    } else {
      const [saved] = await tx.update(readingBookmarks).set({ title: nextTitle!, revision: expected + 1, updatedAt: new Date() })
        .where(and(scope, eq(readingBookmarks.revision, expected))).returning();
      if (saved) return bookmarkDTO(saved);
      const [existing] = await tx.select().from(readingBookmarks).where(scope);
      if (!existing) throw new ReadingReaderError(404, "书签不存在。");
    }
    throw new ReadingReaderError(409, "书签已在其他窗口修改，请刷新书签后重试。");
  });
}

export async function readingReaderResponse(action: () => Promise<unknown>): Promise<Response> {
  try { return Response.json(await action(), { headers: { "Cache-Control": "no-store" } }); }
  catch (cause) {
    if (cause instanceof ReadingReaderError) return Response.json({ error: cause.message, state: cause.state }, { status: cause.status });
    return Response.json({ error: "阅读记录暂时无法保存，请稍后重试。" }, { status: 500 });
  }
}
