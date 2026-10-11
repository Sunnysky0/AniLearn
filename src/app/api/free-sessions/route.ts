import { eq } from "drizzle-orm";
import { db } from "@/db";
import { freeSessions, tutors } from "@/db/schema";
import { listFreeSessions } from "@/lib/server/free-data";
import { getSettings, getLLMConfig } from "@/lib/server/settings";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawCursor = url.searchParams.get("cursor");
  let before: { updatedAt: Date; id: number } | undefined;
  if (rawCursor) {
    const split = rawCursor.lastIndexOf("|");
    const updatedAt = new Date(rawCursor.slice(0, split));
    const id = Number(rawCursor.slice(split + 1));
    if (split <= 0 || !Number.isFinite(updatedAt.getTime()) || !Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "历史游标无效。" }, { status: 400 });
    before = { updatedAt, id };
  }
  return Response.json(await listFreeSessions(20, before), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { tutorId?: number; requestId?: string } | null;
  if (!body || !Number.isSafeInteger(body.tutorId) || Number(body.tutorId) <= 0 || typeof body.requestId !== "string" || !/^[\w-]{16,128}$/.test(body.requestId)) {
    return Response.json({ error: "导师或创建请求编号无效。" }, { status: 400 });
  }
  try { getLLMConfig(await getSettings(), "chat"); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "请先配置讲解模型。" }, { status: 400 }); }
  const tutorId = Number(body.tutorId);
  const [tutor] = await db.select({ id: tutors.id }).from(tutors).where(eq(tutors.id, tutorId));
  if (!tutor) return Response.json({ error: "导师不存在。" }, { status: 404 });
  const [inserted] = await db.insert(freeSessions).values({
    tutorId, createdRequestId: body.requestId, welcomeRequestId: `welcome-${body.requestId}`,
  }).onConflictDoNothing({ target: freeSessions.createdRequestId }).returning({ id: freeSessions.id, tutorId: freeSessions.tutorId });
  const [session] = inserted ? [inserted] : await db.select({ id: freeSessions.id, tutorId: freeSessions.tutorId }).from(freeSessions).where(eq(freeSessions.createdRequestId, body.requestId));
  if (!session || session.tutorId !== tutorId) return Response.json({ error: "创建请求编号已用于另一位导师。" }, { status: 409 });
  return Response.json({ id: session.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
