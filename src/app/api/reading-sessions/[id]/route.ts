import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readingSessions } from "@/db/schema";
import { validId, loadReadingSession, readingSessionDTO, readingMessageDTO } from "@/lib/server/readings";
import { toTutorDTO } from "@/lib/server/data";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); const bundle = id && await loadReadingSession(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
  return Response.json({ session: readingSessionDTO(bundle.session), reading: bundle.reading, tutor: toTutorDTO(bundle.tutor), messages: bundle.messages.map(readingMessageDTO) });
}
export async function PATCH(req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("readingSession", id); if (!release) return Response.json({ error: "课堂正在讲解" }, { status: 409 });
  try {
    const bundle = await loadReadingSession(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
    const body = await req.json(); if (!Number.isInteger(body.currentIdx) || body.currentIdx < 0 || body.currentIdx >= bundle.reading.paragraphs.length) return Response.json({ error: "段落编号无效" }, { status: 400 });
    const progress = { ...bundle.session.progress };
    if (progress[String(body.currentIdx)] !== "done") progress[String(body.currentIdx)] = "active";
    const [row] = await db.update(readingSessions).set({ currentIdx: body.currentIdx, progress, status: "active", updatedAt: new Date() }).where(eq(readingSessions.id, id)).returning();
    return Response.json(readingSessionDTO(row));
  } finally { await release(); }
}
export async function DELETE(_req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("readingSession", id); if (!release) return Response.json({ error: "课堂正在讲解" }, { status: 409 });
  try { await db.delete(readingSessions).where(eq(readingSessions.id, id)); return Response.json({ ok: true }); } finally { await release(); }
}
