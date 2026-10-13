import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tutors } from "@/db/schema";
import { books, bookVersions, bookSessions, bookChapterStates, bookMessages, bookPersonalNotes } from "@/db/books-schema";
import type { BookChapterStateDTO, BookMessage, BookPersonalNote, BookSessionDTO } from "@/lib/types";
import { getBookDocument, getBookMaterial, validBookId } from "./book-catalog";
import { initialBookAnalysis, initialBookLearning, changeBookLearning } from "./book-learning";
import { toTutorDTO } from "./data";
import { validateReaderAnchor, validateReaderPosition } from "@/lib/reader/anchors";
import { tryOperationLock } from "./locks";
import { LLMRequestError } from "./llm";

export function safeBookError(cause: unknown, fallback = "操作失败，请稍后重试。") {
  if (cause instanceof LLMRequestError) return cause.message;
  if (cause instanceof Error && /^\p{Script=Han}/u.test(cause.message) && cause.message.length <= 240 && !/[\r\n]|query|params|insert|values|select|update|delete/iu.test(cause.message)) return cause.message;
  return fallback;
}

export type BookCtx = { params: Promise<{ id: string }> };
export function bookStateDTO(row: typeof bookChapterStates.$inferSelect): BookChapterStateDTO {
  return { chapterId: row.chapterId, learning: row.learning, position: row.position,
    analysis: row.analysisDraft ?? initialBookAnalysis(row.chapterId) };
}
export function bookSessionDTO(row: typeof bookSessions.$inferSelect, states: (typeof bookChapterStates.$inferSelect)[]): BookSessionDTO {
  return { id: row.id, bookId: row.bookId, versionId: row.versionId, tutorId: row.tutorId,
    currentChapterId: row.currentChapterId, status: row.status, summary: row.summary, summaryDraft: row.summaryDraft,
    chapters: states.map(bookStateDTO), updatedAt: row.updatedAt.toISOString() };
}
export function bookMessageDTO(row: typeof bookMessages.$inferSelect): BookMessage {
  return { id: row.id, role: row.role as BookMessage["role"], content: row.content, speech: row.speech,
    chapterId: row.chapterId, kind: row.kind as BookMessage["kind"], language: row.language as BookMessage["language"],
    attachments: row.attachments.map((_, index) => `/api/book-sessions/${row.sessionId}/messages/${row.id}/attachments/${index}`),
    attachmentCount: row.attachments.length, phase: row.phase as BookMessage["phase"], focus: row.focus as BookMessage["focus"], anchor: row.anchor };
}
export function bookNoteDTO(row: typeof bookPersonalNotes.$inferSelect): BookPersonalNote {
  return { id: row.id, versionId: row.versionId, chapterId: row.chapterId, kind: row.kind as BookPersonalNote["kind"],
    clientId: row.clientId, content: row.content, anchor: row.anchor, revision: row.revision, updatedAt: row.updatedAt.toISOString() };
}
export async function loadBookSession(id: number, chapterId?: string) {
  const [session] = await db.select().from(bookSessions).where(eq(bookSessions.id, id));
  if (!session) return null;
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, session.tutorId));
  const material = await getBookMaterial(session.bookId, session.versionId);
  if (!tutor || !material || material.version.status !== "ready") return null;
  const document = await getBookDocument(session.bookId, session.versionId, chapterId ?? session.currentChapterId);
  if (!document) return null;
  const states = await db.select().from(bookChapterStates).where(eq(bookChapterStates.sessionId, id));
  const state = states.find((state) => state.chapterId === document.unitId);
  if (!state) return null;
  return { session, tutor, material, document, states, state };
}
export async function bookSessionPayload(id: number, chapterId?: string) {
  const bundle = await loadBookSession(id, chapterId);
  if (!bundle) return null;
  const messages = await db.select().from(bookMessages).where(and(eq(bookMessages.sessionId, id), eq(bookMessages.chapterId, bundle.document.unitId))).orderBy(asc(bookMessages.id));
  const notes = await db.select().from(bookPersonalNotes).where(and(eq(bookPersonalNotes.versionId, bundle.session.versionId), or(eq(bookPersonalNotes.chapterId, bundle.document.unitId), eq(bookPersonalNotes.kind, "book")))).orderBy(asc(bookPersonalNotes.id));
  return { session: bookSessionDTO(bundle.session, bundle.states), book: bundle.material.book, document: bundle.document,
    tutor: toTutorDTO(bundle.tutor), messages: messages.map(bookMessageDTO), notes: notes.map(bookNoteDTO) };
}
export async function createBookSession(req: Request) {
  const body = await req.json().catch(() => null);
  const bookId = validBookId(body?.bookId); const tutorId = validBookId(body?.tutorId);
  if (!bookId || !tutorId || (body.versionId !== undefined && !validBookId(body.versionId))) return Response.json({ error: "材料或导师编号无效。" }, { status: 400 });
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  const versionId = body.versionId ?? book?.currentVersionId;
  if (!book || !versionId) return Response.json({ error: "请先确认典籍目录。" }, { status: 400 });
  const release = await tryOperationLock("bookVersion", versionId);
  if (!release) return Response.json({ error: "版本正在处理。" }, { status: 409 });
  try {
    const [version] = await db.select({ status: bookVersions.status, bookId: bookVersions.bookId }).from(bookVersions).where(eq(bookVersions.id, versionId));
    const [tutor] = await db.select({ id: tutors.id }).from(tutors).where(eq(tutors.id, tutorId));
    if (!version || version.bookId !== bookId || version.status !== "ready" || !tutor) return Response.json({ error: "典籍尚未发布或导师不存在。" }, { status: 400 });
    const material = await getBookMaterial(bookId, versionId);
    const first = material?.chapters.find((chapter) => chapter.role === "main" && (chapter.blockCount ?? 0) > 0) ?? material?.chapters.find((chapter) => (chapter.blockCount ?? 0) > 0);
    if (!first || !material) return Response.json({ error: "典籍正文为空。" }, { status: 400 });
    const session = await db.transaction(async (tx) => {
      const [row] = await tx.insert(bookSessions).values({ bookId, versionId, tutorId, currentChapterId: first.id }).returning();
      await tx.insert(bookChapterStates).values(material.chapters.map((chapter) => ({ sessionId: row.id, chapterId: chapter.id,
        learning: initialBookLearning(material.book.kind) })));
      return row;
    });
    return Response.json({ id: session.id }, { status: 201 });
  } finally { await release(); }
}
export async function getBookSession(req: Request, ctx: BookCtx) {
  const id = validBookId((await ctx.params).id);
  const chapterId = new URL(req.url).searchParams.get("chapterId") ?? undefined;
  const payload = id && await bookSessionPayload(id, chapterId);
  return payload ? Response.json(payload, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "课堂不存在。" }, { status: 404 });
}
export async function patchBookSession(req: Request, ctx: BookCtx) {
  const id = validBookId((await ctx.params).id);
  if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const release = await tryOperationLock("bookSession", id);
  if (!release) return Response.json({ error: "课堂正在生成，请稍后重试。" }, { status: 409 });
  try {
    const body = await req.json().catch(() => null);
    const bundle = await loadBookSession(id);
    if (!bundle) return Response.json({ error: "课堂不存在。" }, { status: 404 });
    if (!body || typeof body.action !== "string" || (body.versionId !== undefined && body.versionId !== bundle.session.versionId)) return Response.json({ error: "版本或操作无效。" }, { status: 400 });
    if (body.action === "chapter") {
      if (typeof body.chapterId !== "string" || !bundle.material.chapters.some((chapter) => chapter.id === body.chapterId)) return Response.json({ error: "章节不存在。" }, { status: 400 });
      await db.update(bookSessions).set({ currentChapterId: body.chapterId, updatedAt: new Date() }).where(eq(bookSessions.id, id));
      return Response.json(await bookSessionPayload(id));
    }
    if (body.chapterId !== bundle.session.currentChapterId) return Response.json({ error: "当前章节已变化。" }, { status: 409 });
    if (body.action === "bookmark") {
      const position = validateReaderPosition(bundle.document, body.position ?? body.readerPosition);
      if (!position) return Response.json({ error: "阅读位置无效。" }, { status: 400 });
      await db.update(bookChapterStates).set({ position }).where(eq(bookChapterStates.id, bundle.state.id));
    } else {
      if (!Number.isSafeInteger(body.stateRevision) || body.stateRevision !== bundle.state.learning.stateRevision) return Response.json({ error: "章节状态已变化，请同步后重试。" }, { status: 409 });
      if (["set_focus", "confirm_focus", "complete_analysis"].includes(body.action) && bundle.state.analysisDraft?.status !== "ready") return Response.json({ error: "本章导读资料尚未准备完成。" }, { status: 409 });
      const learning = changeBookLearning(bundle.state.learning, bundle.material.book.kind, body.action, body.focus);
      await db.update(bookChapterStates).set({ learning }).where(eq(bookChapterStates.id, bundle.state.id));
    }
    await db.update(bookSessions).set({ updatedAt: new Date() }).where(eq(bookSessions.id, id));
    const latest = await loadBookSession(id);
    return Response.json(bookSessionDTO(latest!.session, latest!.states));
  } catch (cause) { return Response.json({ error: safeBookError(cause, "课堂更新失败。") }, { status: 400 }); }
  finally { await release(); }
}
export async function deleteBookSession(_req: Request, ctx: BookCtx) {
  const id = validBookId((await ctx.params).id);
  if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const release = await tryOperationLock("bookSession", id);
  if (!release) return Response.json({ error: "课堂正在生成。" }, { status: 409 });
  const preparation = await tryOperationLock("bookAnalysis", id);
  if (!preparation) { await release(); return Response.json({ error: "导读资料正在准备。" }, { status: 409 }); }
  try { await db.delete(bookSessions).where(eq(bookSessions.id, id)); return Response.json({ ok: true }); }
  finally { await preparation(); await release(); }
}

function noteContent(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || new TextEncoder().encode(value).byteLength > 65536) throw new Error("笔记内容不能为空，且最多 64 KiB。");
  return value;
}
export async function getBookNotes(req: Request, ctx: BookCtx) {
  const id = validBookId((await ctx.params).id); const chapterId = new URL(req.url).searchParams.get("chapterId") ?? undefined;
  const payload = id && await bookSessionPayload(id, chapterId);
  return payload ? Response.json({ notes: payload.notes }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "课堂不存在。" }, { status: 404 });
}
export async function createBookNote(req: Request, ctx: BookCtx) {
  const id = validBookId((await ctx.params).id); const body = await req.json().catch(() => null);
  const bundle = id && await loadBookSession(id, body?.chapterId ?? undefined);
  if (!bundle) return Response.json({ error: "课堂或章节不存在。" }, { status: 404 });
  try {
    if (!body || !["annotation", "chapter", "book"].includes(body.kind) || typeof body.clientId !== "string" || !/^[\w-]{1,140}$/.test(body.clientId)) throw new Error("笔记类型或编号无效。");
    if (body.versionId !== undefined && body.versionId !== bundle.session.versionId) throw new Error("典籍版本不匹配。");
    const kind = body.kind as BookPersonalNote["kind"];
    const content = noteContent(body.content, kind !== "annotation");
    const anchor = kind === "annotation" ? validateReaderAnchor(bundle.document, body.anchor) : null;
    if (kind === "annotation" && !anchor || kind !== "annotation" && body.anchor != null) throw new Error("批注原文选区无效。");
    const chapterId = kind === "book" ? null : bundle.document.unitId;
    const values = { versionId: bundle.session.versionId, chapterId, kind, clientId: body.clientId, content, anchor };
    const [inserted] = await db.insert(bookPersonalNotes).values(values).onConflictDoNothing({ target: [bookPersonalNotes.versionId, bookPersonalNotes.clientId] }).returning();
    if (inserted) return Response.json(bookNoteDTO(inserted), { status: 201 });
    const [existing] = await db.select().from(bookPersonalNotes).where(and(eq(bookPersonalNotes.versionId, bundle.session.versionId), eq(bookPersonalNotes.clientId, body.clientId)));
    if (existing && existing.kind === kind && existing.chapterId === chapterId && (kind !== "annotation" || existing.content === content && JSON.stringify(existing.anchor) === JSON.stringify(anchor))) return Response.json(bookNoteDTO(existing));
    return Response.json({ error: "此笔记编号已用于其他内容。" }, { status: 409 });
  } catch (cause) { return Response.json({ error: safeBookError(cause, "笔记保存失败。") }, { status: 400 }); }
}
export async function updateBookNote(req: Request, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const params = await ctx.params; const id = validBookId(params.id); const noteId = validBookId(params.noteId);
  const bundle = id && await loadBookSession(id); const body = await req.json().catch(() => null);
  if (!bundle || !noteId) return Response.json({ error: "笔记不存在。" }, { status: 404 });
  const [existing] = await db.select().from(bookPersonalNotes).where(and(eq(bookPersonalNotes.id, noteId), eq(bookPersonalNotes.versionId, bundle.session.versionId)));
  if (!existing) return Response.json({ error: "笔记不存在。" }, { status: 404 });
  try {
    const content = noteContent(body?.content, existing.kind !== "annotation");
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error("笔记版本无效。");
    let anchor = existing.anchor;
    if (body.anchor !== undefined) {
      const document = existing.chapterId && await getBookDocument(bundle.session.bookId, bundle.session.versionId, existing.chapterId);
      anchor = existing.kind === "annotation" && document ? validateReaderAnchor(document, body.anchor) : null;
      if (existing.kind === "annotation" && !anchor || existing.kind !== "annotation" && body.anchor != null) throw new Error("原文选区无效。");
    }
    const [updated] = await db.update(bookPersonalNotes).set({ content, anchor, revision: sql`${bookPersonalNotes.revision} + 1`, updatedAt: new Date() }).where(and(eq(bookPersonalNotes.id, noteId), eq(bookPersonalNotes.versionId, bundle.session.versionId), eq(bookPersonalNotes.revision, body.revision))).returning();
    if (!updated) { const [latest] = await db.select().from(bookPersonalNotes).where(eq(bookPersonalNotes.id, noteId)); return Response.json({ error: "笔记已在其他页面修改，请同步后重试。", current: latest ? bookNoteDTO(latest) : null }, { status: 409 }); }
    return Response.json(bookNoteDTO(updated));
  } catch (cause) { return Response.json({ error: safeBookError(cause, "笔记保存失败。") }, { status: 400 }); }
}
export async function deleteBookNote(_req: Request, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const params = await ctx.params; const id = validBookId(params.id); const noteId = validBookId(params.noteId); const bundle = id && await loadBookSession(id);
  if (!bundle || !noteId) return Response.json({ error: "笔记不存在。" }, { status: 404 });
  const [deleted] = await db.delete(bookPersonalNotes).where(and(eq(bookPersonalNotes.id, noteId), eq(bookPersonalNotes.versionId, bundle.session.versionId))).returning({ id: bookPersonalNotes.id });
  return deleted ? Response.json({ ok: true }) : Response.json({ error: "笔记不存在。" }, { status: 404 });
}
