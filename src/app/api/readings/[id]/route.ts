import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSessions } from "@/db/schema";
import { validId, getReading, paragraphsFromText, readingDTO } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
import { MAX_PAPER_TEXT_BYTES } from "@/lib/types";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Context) {
  const id = validId((await ctx.params).id); const material = id && await getReading(id);
  if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
  const classrooms = await db.select({ id: readingSessions.id, tutorId: readingSessions.tutorId, currentIdx: readingSessions.currentIdx, status: readingSessions.status }).from(readingSessions).where(eq(readingSessions.readingId, id as number));
  return Response.json({ reading: material.dto, sources: material.sources.map((s) => ({ idx: s.idx, mime: s.mime })), sessions: classrooms });
}
export async function PATCH(req: Request, ctx: Context) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id); if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  try {
    const material = await getReading(id); if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
    const body = await req.json(); if (typeof body.text !== "string" || Buffer.byteLength(body.text) > MAX_PAPER_TEXT_BYTES) return Response.json({ error: "原文无效或过大" }, { status: 400 });
    if (body.revision !== material.row.revision) return Response.json({ error: "材料已变化，请刷新" }, { status: 409 });
    const revision = material.row.revision + 1; const paragraphs = paragraphsFromText(body.text, revision, material.sources.map((source) => material.row.draft[String(source.idx)] ?? ""));
    const [row] = await db.update(readings).set({ extracted: body.text.trim(), paragraphs, revision, status: "ready", error: null }).where(eq(readings.id, id)).returning();
    return Response.json(readingDTO(row, material.sources.length));
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  finally { await release(); }
}
export async function DELETE(_req: Request, ctx: Context) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id); if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  const releases: (() => Promise<void>)[] = [];
  try {
    const rows = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.readingId, id));
    for (const row of rows) { const unlock = await tryOperationLock("readingSession", row.id); if (!unlock) return Response.json({ error: "阅读课堂正在讲解" }, { status: 409 }); releases.push(unlock); }
    await db.delete(readings).where(eq(readings.id, id)); return Response.json({ ok: true });
  } finally { for (const unlock of releases.reverse()) await unlock(); await release(); }
}
