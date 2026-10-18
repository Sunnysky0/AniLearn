import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bookBookmarks, bookChapters, bookChapterStates, bookReaderStates, bookSessions, bookVersions } from "@/db/books-schema";
import type { BookBookmarkDTO, BookReaderStateDTO, ReaderDocument, ReaderPosition, ReaderUnit } from "@/lib/book-types";
import { blockText, validateReaderPosition } from "@/lib/reader/anchors";
import { validBookId } from "./book-catalog";

export class BookReaderError extends Error {
  constructor(readonly status: number, message: string, readonly state?: BookReaderStateDTO) { super(message); }
}
export interface BookReaderContext {
  bookId: number; versionId: number; documentKey: string; units: ReaderUnit[];
  documents: Map<string, ReaderDocument>;
}
export async function bookReaderContext(value: string): Promise<BookReaderContext> {
  const id = validBookId(value);
  if (!id) throw new BookReaderError(400, "课堂编号无效。");
  const [session] = await db.select({ bookId: bookSessions.bookId, versionId: bookSessions.versionId }).from(bookSessions).where(eq(bookSessions.id, id));
  if (!session) throw new BookReaderError(404, "课堂不存在。");
  const [version] = await db.select({ status: bookVersions.status }).from(bookVersions).where(and(eq(bookVersions.id, session.versionId), eq(bookVersions.bookId, session.bookId)));
  if (!version || version.status !== "ready") throw new BookReaderError(404, "典籍版本不存在或尚未发布。");
  const units = await db.select({ id: bookChapters.id, title: bookChapters.title, parentId: bookChapters.parentId,
    role: bookChapters.role, order: bookChapters.order }).from(bookChapters).where(eq(bookChapters.versionId, session.versionId)).orderBy(asc(bookChapters.order));
  return { bookId: session.bookId, versionId: session.versionId, documentKey: `book:${session.bookId}:version:${session.versionId}`,
    units: units as ReaderUnit[], documents: new Map() };
}
async function documentFor(ctx: BookReaderContext, unitId: string) {
  if (!ctx.units.some(unit => unit.id === unitId)) return null;
  const cached = ctx.documents.get(unitId); if (cached) return cached;
  // Position validation needs only this immutable chapter's canonical text,
  // never the raw EPUB, the full import draft, assets or other chapter bodies.
  const [chapter] = await db.select({ title: bookChapters.title, blocks: bookChapters.blocks }).from(bookChapters)
    .where(and(eq(bookChapters.versionId, ctx.versionId), eq(bookChapters.id, unitId)));
  const document: ReaderDocument | null = chapter ? { key: ctx.documentKey, title: chapter.title, language: "", unitId, units: ctx.units, blocks: chapter.blocks } : null;
  if (document) ctx.documents.set(unitId, document);
  return document;
}
async function validPosition(ctx: BookReaderContext, value: unknown): Promise<ReaderPosition | null> {
  if (!value || typeof value !== "object" || !("unitId" in value) || typeof value.unitId !== "string") return null;
  const document = await documentFor(ctx, value.unitId);
  return document && validateReaderPosition(document, value);
}
async function position(ctx: BookReaderContext, value: unknown) {
  const valid = await validPosition(ctx, value);
  if (!valid) throw new BookReaderError(400, "阅读位置与当前典籍版本不匹配。");
  return valid;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BookReaderError(400, "请求格式不正确。");
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 2147483647) throw new BookReaderError(400, "修订号无效。");
  return value as number;
}
function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new BookReaderError(400, "操作标识无效。");
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 120) throw new BookReaderError(400, "书签名称须为 1–120 个字符。");
  return value.trim();
}
function samePosition(a: ReaderPosition, b: ReaderPosition) {
  return a.documentKey === b.documentKey && a.unitId === b.unitId && a.blockId === b.blockId && a.offset === b.offset && a.viewportOffset === b.viewportOffset;
}
function stateDTO(ctx: BookReaderContext, row: typeof bookReaderStates.$inferSelect): BookReaderStateDTO {
  return { documentKey: ctx.documentKey, position: row.position, chapterPositions: row.chapterPositions,
    revision: row.revision, mutationId: row.mutationId, updatedAt: row.updatedAt.toISOString() };
}
function bookmarkDTO(ctx: BookReaderContext, row: typeof bookBookmarks.$inferSelect): BookBookmarkDTO {
  return { id: row.id, clientId: row.clientId, position: row.position, title: row.title, excerpt: row.excerpt,
    chapterTitle: ctx.units.find(unit => unit.id === row.position.unitId)?.title ?? "章节",
    revision: row.revision, updatedAt: row.updatedAt.toISOString() };
}
async function legacyState(ctx: BookReaderContext): Promise<BookReaderStateDTO> {
  const sessions = await db.select({ id: bookSessions.id, currentChapterId: bookSessions.currentChapterId }).from(bookSessions)
    .where(eq(bookSessions.versionId, ctx.versionId)).orderBy(desc(bookSessions.updatedAt), desc(bookSessions.id));
  const states = sessions.length ? await db.select({ sessionId: bookChapterStates.sessionId, chapterId: bookChapterStates.chapterId, position: bookChapterStates.position })
    .from(bookChapterStates).where(inArray(bookChapterStates.sessionId, sessions.map(session => session.id))) : [];
  const chapterPositions: Record<string, ReaderPosition> = {};
  let fallback: ReaderPosition | null = null;
  for (const session of sessions) {
    const own = states.filter(state => state.sessionId === session.id);
    const current = own.find(state => state.chapterId === session.currentChapterId);
    if (!fallback && current?.position) fallback = await validPosition(ctx, current.position);
    for (const state of own) {
      if (chapterPositions[state.chapterId] || !state.position) continue;
      const valid = await validPosition(ctx, state.position); if (valid) chapterPositions[state.chapterId] = valid;
    }
  }
  if (!fallback) {
    const ordered = [...ctx.units.filter(unit => unit.role === "main"), ...ctx.units.filter(unit => unit.role !== "main")];
    for (const unit of ordered) {
      const document = await documentFor(ctx, unit.id); const block = document?.blocks[0];
      if (block) { fallback = { documentKey: ctx.documentKey, unitId: unit.id, blockId: block.id, offset: 0, viewportOffset: 0 }; break; }
    }
  }
  return { documentKey: ctx.documentKey, position: fallback, chapterPositions, revision: 0, mutationId: null, updatedAt: null };
}
export async function getBookReaderState(ctx: BookReaderContext): Promise<BookReaderStateDTO> {
  const [row] = await db.select().from(bookReaderStates).where(eq(bookReaderStates.versionId, ctx.versionId));
  return row ? stateDTO(ctx, row) : legacyState(ctx);
}
export async function saveBookReaderState(ctx: BookReaderContext, value: unknown): Promise<BookReaderStateDTO> {
  const body = object(value); const next = await position(ctx, body.position);
  const expected = revision(body.revision); const mutationId = operationId(body.mutationId);
  // Preserve legacy chapter positions on the first write; the unique version key
  // and revision predicate arbitrate concurrent writers without a teaching lock.
  const initial = await getBookReaderState(ctx);
  return db.transaction(async tx => {
    const scope = eq(bookReaderStates.versionId, ctx.versionId);
    const [old] = await tx.select().from(bookReaderStates).where(scope);
    const replay = (row: typeof bookReaderStates.$inferSelect) => {
      if (row.mutationId !== mutationId) return null;
      if (row.revision !== expected + 1 || !samePosition(row.position, next)) throw new BookReaderError(409, "同一操作不能保存不同位置。", stateDTO(ctx, row));
      return stateDTO(ctx, row);
    };
    if (old) {
      const replayed = replay(old); if (replayed) return replayed;
      if (old.revision !== expected) throw new BookReaderError(409, "阅读位置已在其他窗口更新。", stateDTO(ctx, old));
    } else if (expected !== 0) throw new BookReaderError(409, "阅读位置记录已变化，请重新同步。");
    const values = { position: next, chapterPositions: { ...(old?.chapterPositions ?? initial.chapterPositions), [next.unitId]: next },
      revision: expected + 1, mutationId, updatedAt: new Date() };
    const [saved] = old
      ? await tx.update(bookReaderStates).set(values).where(and(scope, eq(bookReaderStates.revision, expected))).returning()
      : await tx.insert(bookReaderStates).values({ versionId: ctx.versionId, ...values }).onConflictDoNothing().returning();
    if (saved) return stateDTO(ctx, saved);
    const [current] = await tx.select().from(bookReaderStates).where(scope);
    if (current) { const replayed = replay(current); if (replayed) return replayed; }
    throw new BookReaderError(409, "阅读位置已在其他窗口更新。", current ? stateDTO(ctx, current) : undefined);
  });
}
export async function getBookBookmarks(ctx: BookReaderContext): Promise<BookBookmarkDTO[]> {
  const rows = await db.select().from(bookBookmarks).where(eq(bookBookmarks.versionId, ctx.versionId)).orderBy(asc(bookBookmarks.id));
  return rows.map(row => bookmarkDTO(ctx, row));
}
export async function createBookBookmark(ctx: BookReaderContext, value: unknown): Promise<BookBookmarkDTO> {
  const body = object(value); const next = await position(ctx, body.position); const clientId = operationId(body.clientId);
  const document = (await documentFor(ctx, next.unitId))!;
  const text = blockText(document.blocks.find(block => block.id === next.blockId)!);
  const excerpt = Array.from(text.slice(next.offset) || text).slice(0, 80).join("");
  const nextTitle = body.title === undefined ? Array.from(excerpt).slice(0, 28).join("") || "阅读书签" : title(body.title);
  const [saved] = await db.insert(bookBookmarks).values({ versionId: ctx.versionId, clientId, position: next, title: nextTitle, excerpt }).onConflictDoNothing().returning();
  if (saved) return bookmarkDTO(ctx, saved);
  const [existing] = await db.select().from(bookBookmarks).where(and(eq(bookBookmarks.versionId, ctx.versionId), eq(bookBookmarks.clientId, clientId)));
  if (!existing || !samePosition(existing.position, next)) throw new BookReaderError(409, "同一书签操作不能指向不同位置。");
  return bookmarkDTO(ctx, existing);
}
export async function changeBookBookmark(ctx: BookReaderContext, idValue: string, value: unknown, remove = false): Promise<BookBookmarkDTO | { ok: true }> {
  const id = validBookId(idValue); if (!id) throw new BookReaderError(400, "书签编号无效。");
  const body = object(value); const expected = revision(body.revision); const nextTitle = remove ? null : title(body.title);
  const scope = and(eq(bookBookmarks.versionId, ctx.versionId), eq(bookBookmarks.id, id));
  return db.transaction(async tx => {
    if (remove) {
      const deleted = await tx.delete(bookBookmarks).where(and(scope, eq(bookBookmarks.revision, expected))).returning();
      if (deleted.length) return { ok: true };
    } else {
      const [saved] = await tx.update(bookBookmarks).set({ title: nextTitle!, revision: expected + 1, updatedAt: new Date() }).where(and(scope, eq(bookBookmarks.revision, expected))).returning();
      if (saved) return bookmarkDTO(ctx, saved);
    }
    const [existing] = await tx.select().from(bookBookmarks).where(scope);
    if (!existing) { if (remove) return { ok: true }; throw new BookReaderError(404, "书签不存在。"); }
    throw new BookReaderError(409, "书签已在其他窗口修改，请刷新书签后重试。");
  });
}
export async function bookReaderResponse(action: () => Promise<unknown>): Promise<Response> {
  try { return Response.json(await action(), { headers: { "Cache-Control": "no-store" } }); }
  catch (cause) {
    if (cause instanceof BookReaderError) return Response.json({ error: cause.message, state: cause.state }, { status: cause.status });
    return Response.json({ error: "阅读记录暂时无法保存，请稍后重试。" }, { status: 500 });
  }
}
