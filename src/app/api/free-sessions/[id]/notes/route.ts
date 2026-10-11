import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { freeSessions, freeTopics } from "@/db/schema";
import { validFreeId } from "@/lib/server/free-data";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validFreeId((await ctx.params).id);
  if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const [session] = await db.select().from(freeSessions).where(eq(freeSessions.id, id));
  if (!session) return Response.json({ error: "自由提问课堂不存在。" }, { status: 404 });
  const topics = await db.select().from(freeTopics).where(eq(freeTopics.sessionId, id)).orderBy(asc(freeTopics.idx));
  const body = [`# ${session.title || "自由提问笔记"}`, ...topics.filter((topic) => topic.blocks.length).flatMap((topic) => [`## ${topic.title}`, ...topic.blocks.map((block) => block.md)])].join("\n\n");
  const filename = `${(session.title || "自由提问").replace(/[\\/:*?"<>|]/g, "_")}-笔记.md`;
  return new Response(body, { headers: {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  } });
}
