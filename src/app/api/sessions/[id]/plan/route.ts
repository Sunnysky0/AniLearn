import { loadClassroom, toSessionDTO, toMessageDTO } from "@/lib/server/data";
import { legacyInventory, requestPlan } from "@/lib/server/session-plan";
import { fullPlan } from "@/lib/server/learning-plan";
import { tryOperationLock } from "@/lib/server/locks";
import { isTeachingPace } from "@/lib/types";
import { db } from "@/db";
import { sessions, messages } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("session", id); if (!release) return Response.json({ error: "课堂正在讲解，请稍候调整。" }, { status: 409 });
  try {
    const bundle = await loadClassroom(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
    const body = await req.json(); const plan = bundle.session.plan ?? fullPlan(bundle.problems);
    if (body.planVersion !== plan.version) return Response.json({ error: "学习计划已更新，请刷新后重试。" }, { status: 409 });
    if (!isTeachingPace(body.pace)) return Response.json({ error: "档位无效" }, { status: 400 });
    const result = await requestPlan(bundle.session, bundle.paper.inventory ?? legacyInventory(bundle.problems), bundle.problems, body.pace, typeof body.request === "string" ? body.request.slice(0, 2000) : "");
    const [divider] = result.session.currentIdx !== bundle.session.currentIdx
      ? await db.select().from(messages).where(and(eq(messages.sessionId, id), eq(messages.kind, "problem"))).orderBy(desc(messages.id)).limit(1) : [];
    return Response.json({ session: toSessionDTO(result.session), missing: result.missing, message: divider ? toMessageDTO(divider) : null });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  finally { await release(); }
}
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("session", id); if (!release) return Response.json({ error: "课堂正在处理。" }, { status: 409 });
  try {
    const [row] = await db.update(sessions).set({ pendingPlan: null, supplementDraft: {}, updatedAt: new Date() }).where(eq(sessions.id, id)).returning();
    return row ? Response.json({ session: toSessionDTO(row) }) : Response.json({ error: "课堂不存在" }, { status: 404 });
  } finally { await release(); }
}
