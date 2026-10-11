import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { freeMessages, freeSessions, freeTopics, freeTurns } from "@/db/schema";
import { loadFreeSession, toFreeMessageDTO, toFreeSessionDTO, toFreeTopicDTO, validFreeId } from "@/lib/server/free-data";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Context) {
  const id = validFreeId((await ctx.params).id);
  const bundle = id && await loadFreeSession(id);
  if (!bundle) return Response.json({ error: "自由提问课堂不存在。" }, { status: 404 });
  const turns = await db.select().from(freeTurns).where(eq(freeTurns.sessionId, id)).orderBy(desc(freeTurns.id)).limit(80);
  return Response.json({
    session: toFreeSessionDTO(bundle.session), tutor: {
      id: bundle.tutor.id, name: bundle.tutor.name, avatar: bundle.tutor.avatar,
      personality: bundle.tutor.personality, teachingStyle: bundle.tutor.teachingStyle,
      speakingStyle: bundle.tutor.speakingStyle, voiceId: bundle.tutor.voiceId, voiceStyle: bundle.tutor.voiceStyle,
    },
    topics: bundle.topics.map(toFreeTopicDTO), messages: bundle.messages.map(toFreeMessageDTO),
    hasMoreMessages: bundle.hasMoreMessages, oldestMessageId: bundle.oldestMessageId,
    moreTurns: turns.reverse().map((turn) => ({ id: turn.id, requestId: turn.requestId, intent: turn.intent, status: turn.status, topicId: turn.topicId, requestedTopicId: turn.requestedTopicId, action: turn.action })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, ctx: Context) {
  const id = validFreeId((await ctx.params).id);
  if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const body = await req.json().catch(() => null) as { title?: unknown; currentTopicId?: unknown } | null;
  if (!body || (body.title === undefined && body.currentTopicId === undefined)) return Response.json({ error: "没有可更新的内容。" }, { status: 400 });
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || Array.from(body.title.trim()).length > 80)) return Response.json({ error: "课堂名称需为 1–80 个字符。" }, { status: 400 });
  if (body.currentTopicId !== undefined && (!Number.isSafeInteger(body.currentTopicId) || Number(body.currentTopicId) <= 0)) return Response.json({ error: "话题编号无效。" }, { status: 400 });
  const release = await tryOperationLock("freeSession", id);
  if (!release) return Response.json({ error: "导师正在回复，请稍候再试。" }, { status: 409 });
  try {
    const [session] = await db.select().from(freeSessions).where(eq(freeSessions.id, id));
    if (!session) return Response.json({ error: "自由提问课堂不存在。" }, { status: 404 });
    const patch: Partial<typeof freeSessions.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title.trim();
    if (body.currentTopicId !== undefined) {
      const topicId = Number(body.currentTopicId);
      const [topic] = await db.select({ id: freeTopics.id }).from(freeTopics).where(and(eq(freeTopics.id, topicId), eq(freeTopics.sessionId, id)));
      if (!topic) return Response.json({ error: "话题不存在或不属于当前课堂。" }, { status: 404 });
      patch.currentTopicId = topic.id;
    }
    const [updated] = await db.update(freeSessions).set(patch).where(eq(freeSessions.id, id)).returning();
    return Response.json(toFreeSessionDTO(updated));
  } finally { await release(); }
}

export async function DELETE(_req: Request, ctx: Context) {
  const id = validFreeId((await ctx.params).id);
  if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const release = await tryOperationLock("freeSession", id);
  if (!release) return Response.json({ error: "导师正在回复，请稍候再试。" }, { status: 409 });
  try {
    const [deleted] = await db.delete(freeSessions).where(eq(freeSessions.id, id)).returning({ id: freeSessions.id });
    return deleted ? Response.json({ ok: true }) : Response.json({ error: "自由提问课堂不存在。" }, { status: 404 });
  } finally { await release(); }
}
