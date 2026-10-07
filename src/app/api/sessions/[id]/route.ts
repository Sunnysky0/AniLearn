import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, sessions } from "@/db/schema";
import { loadClassroom, problemDivider, toMessageDTO, toSessionDTO } from "@/lib/server/data";
import type { ProblemProgress } from "@/lib/types";
import { tryOperationLock } from "@/lib/server/locks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Jump to a specific problem (课程目录).
export async function PATCH(req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return Response.json({ error: "无效的课堂 ID" }, { status: 400 });
  const release = await tryOperationLock("session", id);
  if (!release) return Response.json({ error: "上一轮讲解仍在进行，请稍候再切题。" }, { status: 409 });
  try {
  const bundle = await loadClassroom(id);
  if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { currentIdx?: number };
  const idx = Number(body.currentIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= bundle.problems.length) {
    return Response.json({ error: "题号无效" }, { status: 400 });
  }
  const progress: Record<string, ProblemProgress> = { ...bundle.session.progress };
  if (progress[String(idx)] !== "done") progress[String(idx)] = "active";
  const [s] = await db
    .update(sessions)
    .set({ currentIdx: idx, progress, status: "active", updatedAt: new Date() })
    .where(eq(sessions.id, id))
    .returning();
  const [m] = await db
    .insert(messages)
    .values({
      sessionId: id,
      role: "system",
      kind: "problem",
      content: problemDivider(bundle.problems[idx]),
      problemIdx: idx,
    })
    .returning();
  return Response.json({ session: toSessionDTO(s), message: toMessageDTO(m) });
  } finally { await release(); }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return Response.json({ error: "无效的课堂 ID" }, { status: 400 });
  const release = await tryOperationLock("session", id);
  if (!release) return Response.json({ error: "课堂仍在生成，请停止讲解后再删除。" }, { status: 409 });
  try {
  await db.delete(sessions).where(eq(sessions.id, id));
  return Response.json({ ok: true });
  } finally { await release(); }
}
