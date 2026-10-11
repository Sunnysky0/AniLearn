import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { freeMessages, freeSessions } from "@/db/schema";
import { sql } from "drizzle-orm";
import { toFreeMessageDTO, validFreeId, withRecentAttachments } from "@/lib/server/free-data";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = validFreeId((await ctx.params).id);
  const url = new URL(req.url);
  const turnId = url.searchParams.has("turn") ? Number(url.searchParams.get("turn")) : null;
  const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
  if (!sessionId || (turnId !== null && (!Number.isSafeInteger(turnId) || turnId <= 0)) || (turnId === null && (!Number.isSafeInteger(before) || Number(before) <= 0))) return Response.json({ error: "历史记录游标无效。" }, { status: 400 });
  const [session] = await db.select({ id: freeSessions.id }).from(freeSessions).where(eq(freeSessions.id, sessionId));
  if (!session) return Response.json({ error: "自由提问课堂不存在。" }, { status: 404 });
  const query = db.select({
    id: freeMessages.id, sessionId: freeMessages.sessionId, turnId: freeMessages.turnId, topicId: freeMessages.topicId,
    role: freeMessages.role, kind: freeMessages.kind, language: freeMessages.language, content: freeMessages.content,
    speech: freeMessages.speech, boardMode: freeMessages.boardMode, createdAt: freeMessages.createdAt,
    attachmentCount: sql<number>`jsonb_array_length(${freeMessages.attachments})::int`,
  }).from(freeMessages).where(and(eq(freeMessages.sessionId, sessionId), turnId === null ? lt(freeMessages.id, Number(before)) : eq(freeMessages.turnId, turnId)));
  const selected = turnId === null ? await query.orderBy(desc(freeMessages.id)).limit(51) : await query.limit(20);
  if (turnId !== null) {
    const messages = await withRecentAttachments(selected);
    return Response.json({ messages: messages.map(toFreeMessageDTO) }, { headers: { "Cache-Control": "no-store" } });
  }
  const page = selected;
  const hasMore = page.length > 50;
  const messages = await withRecentAttachments(page.slice(0, 50).reverse());
  return Response.json({ messages: messages.map(toFreeMessageDTO), hasMore, oldestMessageId: messages[0]?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
}
