import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { paperPages, papers, sessions, messages } from "@/db/schema";
import { loadClassroom, toSessionDTO, toMessageDTO } from "@/lib/server/data";
import { applyPlan, legacyInventory } from "@/lib/server/session-plan";
import { analyzeOne } from "@/lib/server/analysis";
import { getLLMConfig, getSettings } from "@/lib/server/settings";
import { tryOperationLock } from "@/lib/server/locks";
import { decodePaperText, paperTextFormat } from "@/lib/paper-source";
import type { LLMPart } from "@/lib/server/llm";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("session", id); if (!release) return Response.json({ error: "课堂正在处理。" }, { status: 409 });
  let releasePaper: (() => Promise<void>) | null = null; let handedOff = false;
  try {
    const bundle = await loadClassroom(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
    const body = await req.json(); const plan = bundle.session.pendingPlan;
    if (!plan || body.planVersion !== plan.version) return Response.json({ error: "补充计划已变化，请重新确认。" }, { status: 409 });
    releasePaper = await tryOperationLock("paper", bundle.session.paperId); if (!releasePaper) return Response.json({ error: "材料正在处理。" }, { status: 409 });
    const [paper] = await db.select().from(papers).where(eq(papers.id, bundle.session.paperId));
    if (paper.revision !== (bundle.session.snapshot?.paper.revision ?? paper.revision)) return Response.json({ error: "原试卷版本已变化，请以新版材料新建课堂。" }, { status: 409 });
    const cfg = getLLMConfig(await getSettings(), "analysis");
    const sources = await db.select().from(paperPages).where(eq(paperPages.paperId, paper.id)).orderBy(asc(paperPages.pageIndex));
    const parts: LLMPart[] = sources.flatMap((s, i) => [{ type: "text", text: `第${i + 1}页` }, paperTextFormat(s.mime) ? { type: "text", text: decodePaperText(Buffer.from(s.data, "base64")) } : { type: "image", mime: s.mime, data: s.data }]);
    const inventory = bundle.paper.inventory ?? legacyInventory(bundle.problems); const draft = { ...bundle.session.supplementDraft };
    const stream = new ReadableStream({ async start(controller) {
      const send = (event: unknown) => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); } catch { /* detached observer */ } };
      try {
        const signal = AbortSignal.timeout(750_000);
        for (const unit of plan.units) {
          if (bundle.problems[unit.idx]?.solution || draft[String(unit.idx)]) continue;
          const result = await analyzeOne(cfg, paper.subject, inventory.items[unit.idx], parts, signal, (chars) => send({ type: "progress", idx: unit.idx, chars }));
          draft[String(unit.idx)] = result;
          await db.update(sessions).set({ supplementDraft: structuredClone(draft) }).where(eq(sessions.id, id));
          send({ type: "progress", idx: unit.idx, completed: true });
        }
        const problems = bundle.problems.map((p) => draft[String(p.idx)] ? { ...p, ...draft[String(p.idx)], analysis: "ready" as const } : p);
        const updated = await applyPlan(bundle.session, plan, problems);
        const [divider] = updated.currentIdx !== bundle.session.currentIdx
          ? await db.select().from(messages).where(and(eq(messages.sessionId, id), eq(messages.kind, "problem"))).orderBy(desc(messages.id)).limit(1) : [];
        send({ type: "done", session: toSessionDTO(updated), problems, message: divider ? toMessageDTO(divider) : null });
      } catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
      finally { await releasePaper!(); await release(); try { controller.close(); } catch { /* disconnected */ } }
    } });
    handedOff = true;
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } finally { if (!handedOff) { await releasePaper?.(); await release(); } }
}
