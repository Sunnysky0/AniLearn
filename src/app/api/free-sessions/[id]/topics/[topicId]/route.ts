import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { freeTopics } from "@/db/schema";
import { toFreeTopicDTO, validFreeId } from "@/lib/server/free-data";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; topicId: string }> }) {
  const params = await ctx.params;
  const sessionId = validFreeId(params.id), topicId = validFreeId(params.topicId);
  if (!sessionId || !topicId) return Response.json({ error: "课堂或话题编号无效。" }, { status: 400 });
  const [topic] = await db.select().from(freeTopics).where(and(eq(freeTopics.id, topicId), eq(freeTopics.sessionId, sessionId)));
  if (!topic) return Response.json({ error: "话题不存在。" }, { status: 404 });
  return Response.json(toFreeTopicDTO(topic), { headers: { "Cache-Control": "no-store" } });
}
