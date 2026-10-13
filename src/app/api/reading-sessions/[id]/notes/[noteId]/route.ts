import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readingPersonalNotes } from "@/db/schema";
import { loadReadingSession, readingPersonalNoteDTO, validId } from "@/lib/server/readings";
import { validateReadingSelection } from "@/lib/server/reading-learning";
import { compatibleReadingSelection, readingDocument, readingSelectionToAnchor } from "@/lib/reader/reading-adapter";

export const dynamic = "force-dynamic";
const MAX_NOTE_BYTES = 64 * 1024;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const params = await ctx.params;
  const sessionId = validId(params.id);
  const noteId = validId(params.noteId);
  if (!sessionId || !noteId) return Response.json({ error: "笔记编号无效。" }, { status: 400 });
  const bundle = await loadReadingSession(sessionId);
  if (!bundle) return Response.json({ error: "课堂不存在。" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (typeof body?.content !== "string" || !Number.isSafeInteger(body.revision) || body.revision < 0) {
    return Response.json({ error: "笔记内容或版本无效。" }, { status: 400 });
  }
  if (new TextEncoder().encode(body.content).byteLength > MAX_NOTE_BYTES) return Response.json({ error: "单条笔记最多 64 KiB。" }, { status: 400 });
  const [existing] = await db.select().from(readingPersonalNotes)
    .where(and(eq(readingPersonalNotes.id, noteId), eq(readingPersonalNotes.sessionId, sessionId)));
  if (!existing) return Response.json({ error: "笔记不存在。" }, { status: 404 });
  let selection = existing.selection;
  if (body.selection !== undefined || body.readerAnchor !== undefined) {
    try {
      if (existing.kind !== "annotation" && body.readerAnchor != null) throw new Error("全文笔记不能绑定原文选区。");
      selection = existing.kind === "annotation" ? validateReadingSelection(bundle.reading, compatibleReadingSelection(bundle.reading, body.selection, body.readerAnchor)) : null;
      if (existing.kind === "annotation" && !selection) throw new Error("批注需要关联文章原文选区。");
    }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "原文选区无效。" }, { status: 400 }); }
  }
  const [updated] = await db.update(readingPersonalNotes).set({
    content: body.content, selection, readerAnchor: readingSelectionToAnchor(readingDocument(bundle.reading), selection), revision: sql`${readingPersonalNotes.revision} + 1`, updatedAt: new Date(),
  }).where(and(
    eq(readingPersonalNotes.id, noteId), eq(readingPersonalNotes.sessionId, sessionId), eq(readingPersonalNotes.revision, body.revision),
  )).returning();
  if (!updated) {
    const [latest] = await db.select().from(readingPersonalNotes)
      .where(and(eq(readingPersonalNotes.id, noteId), eq(readingPersonalNotes.sessionId, sessionId)));
    return Response.json({ error: "笔记已在其他页面修改，请先同步后再保存。", current: latest ? readingPersonalNoteDTO(latest) : null }, { status: 409 });
  }
  return Response.json(readingPersonalNoteDTO(updated));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const params = await ctx.params;
  const sessionId = validId(params.id);
  const noteId = validId(params.noteId);
  if (!sessionId || !noteId) return Response.json({ error: "笔记编号无效。" }, { status: 400 });
  const [deleted] = await db.delete(readingPersonalNotes)
    .where(and(eq(readingPersonalNotes.id, noteId), eq(readingPersonalNotes.sessionId, sessionId))).returning({ id: readingPersonalNotes.id });
  return deleted ? Response.json({ ok: true }) : Response.json({ error: "笔记不存在。" }, { status: 404 });
}
