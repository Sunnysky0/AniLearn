import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tutors } from "@/db/schema";
import { sanitizeTutorInput, toTutorDTO } from "@/lib/server/data";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id)) return Response.json({ error: "无效的导师 ID" }, { status: 400 });
  const [row] = await db.select().from(tutors).where(eq(tutors.id, id));
  if (!row) return Response.json({ error: "导师不存在" }, { status: 404 });
  return Response.json(toTutorDTO(row));
}

export async function PUT(req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id)) return Response.json({ error: "无效的导师 ID" }, { status: 400 });
  const input = sanitizeTutorInput(await req.json().catch(() => ({})));
  const [row] = await db.update(tutors).set(input).where(eq(tutors.id, id)).returning();
  if (!row) return Response.json({ error: "导师不存在" }, { status: 404 });
  return Response.json(toTutorDTO(row));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id)) return Response.json({ error: "无效的导师 ID" }, { status: 400 });
  await db.delete(tutors).where(eq(tutors.id, id));
  return Response.json({ ok: true });
}
