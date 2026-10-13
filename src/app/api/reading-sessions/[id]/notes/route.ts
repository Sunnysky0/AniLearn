import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingPersonalNotes } from "@/db/schema";
import { loadReadingSession, readingPersonalNoteDTO, validId } from "@/lib/server/readings";
import { validateReadingSelection } from "@/lib/server/reading-learning";
import { compatibleReadingSelection, readingDocument, readingSelectionToAnchor } from "@/lib/reader/reading-adapter";

export const dynamic = "force-dynamic";
const MAX_NOTE_BYTES = 64 * 1024;

function validContent(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error("笔记内容不能为空。");
  if (new TextEncoder().encode(value).byteLength > MAX_NOTE_BYTES) throw new Error("单条笔记最多 64 KiB。");
  return value;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = validId((await ctx.params).id);
  if (!sessionId) return Response.json({ error: "课堂 ID 无效。" }, { status: 400 });
  const bundle = await loadReadingSession(sessionId);
  if (!bundle) return Response.json({ error: "课堂不存在。" }, { status: 404 });
  const notes = await db.select().from(readingPersonalNotes).where(eq(readingPersonalNotes.sessionId, sessionId)).orderBy(asc(readingPersonalNotes.id));
  return Response.json({ notes: notes.map(readingPersonalNoteDTO) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = validId((await ctx.params).id);
  if (!sessionId) return Response.json({ error: "课堂 ID 无效。" }, { status: 400 });
  const bundle = await loadReadingSession(sessionId);
  if (!bundle) return Response.json({ error: "课堂不存在。" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const clientId = body?.clientId;
  const kind = body?.kind;
  if (typeof clientId !== "string" || !/^[\w-]{1,100}$/.test(clientId) || !["document", "annotation"].includes(kind)) {
    return Response.json({ error: "笔记编号或类型无效。" }, { status: 400 });
  }
  try {
    const content = validContent(body.content, kind === "document");
    const selection = kind === "annotation" ? validateReadingSelection(bundle.reading, compatibleReadingSelection(bundle.reading, body.selection, body.readerAnchor)) : null;
    if (kind === "document" && body.readerAnchor != null) throw new Error("全文笔记不能绑定原文选区。");
    const readerAnchor = readingSelectionToAnchor(readingDocument(bundle.reading), selection);
    if (kind === "annotation" && !selection) throw new Error("批注需要关联文章原文选区。");
    const [inserted] = await db.insert(readingPersonalNotes).values({ sessionId, clientId, kind, content, selection, readerAnchor })
      .onConflictDoNothing({ target: [readingPersonalNotes.sessionId, readingPersonalNotes.clientId] }).returning();
    if (inserted) return Response.json(readingPersonalNoteDTO(inserted), { status: 201 });
    const [existing] = await db.select().from(readingPersonalNotes)
      .where(and(eq(readingPersonalNotes.sessionId, sessionId), eq(readingPersonalNotes.clientId, clientId)));
    if (existing) {
      if (kind === "document" && existing.kind === kind) return Response.json(readingPersonalNoteDTO(existing));
      if (existing.kind !== kind || existing.content !== content || JSON.stringify(existing.selection) !== JSON.stringify(selection)) {
        return Response.json({ error: "此笔记编号已用于其他内容。" }, { status: 409 });
      }
      return Response.json(readingPersonalNoteDTO(existing));
    }
    return Response.json({ error: "笔记已被并发创建，请重新读取。" }, { status: 409 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存笔记失败。" }, { status: 400 });
  }
}
