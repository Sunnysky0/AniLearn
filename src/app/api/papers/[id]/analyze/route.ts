import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { paperPages, papers, problems, sessions } from "@/db/schema";
import { classroomSnapshot, toPaperDTO } from "@/lib/server/data";
import { complete, streamChat, type LLMPart } from "@/lib/server/llm";
import { analysisSystemPrompt, inventorySystemPrompt } from "@/lib/server/prompts";
import { createTagParser, type TagBlock } from "@/lib/server/protocol";
import { parseAnalyzedProblem, parseInventory } from "@/lib/server/analysis";
import { tryOperationLock } from "@/lib/server/locks";
import { getLLMConfig, getSettings } from "@/lib/server/settings";
import type { AnalyzedProblem, AnalysisDraft, AnalysisEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const paperId = Number((await ctx.params).id);
  if (!Number.isInteger(paperId) || paperId <= 0 || paperId > 2147483647) {
    return Response.json({ error: "无效的试卷 ID" }, { status: 400 });
  }
  const release = await tryOperationLock("paper", paperId);
  if (!release) return Response.json({ error: "这份试卷正在解析中，请稍候" }, { status: 409 });
  let handedOff = false;
  try {
    const [paper] = await db.select().from(papers).where(eq(papers.id, paperId));
    if (!paper) return Response.json({ error: "试卷不存在" }, { status: 404 });
    const cfg = getLLMConfig(await getSettings(), "analysis");
    const pages = await db.select().from(paperPages).where(eq(paperPages.paperId, paperId)).orderBy(asc(paperPages.pageIndex));
    if (!pages.length) return Response.json({ error: "这份试卷还没有上传任何页面" }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { restart?: boolean };
    const draft: AnalysisDraft = !body.restart && paper.analysisDraft
      ? structuredClone(paper.analysisDraft) : { inventory: null, completed: [] };
    await db.update(papers).set({ status: "analyzing", error: null, analysisDraft: draft }).where(eq(papers.id, paperId));
    const allPages: LLMPart[] = pages.flatMap((pg, i) => [
      { type: "text", text: `第 ${i + 1} 页：` }, { type: "image", mime: pg.mime, data: pg.data },
    ]);
    const encoder = new TextEncoder();
    let disconnected = false;
    const signal = AbortSignal.timeout(750_000);
    handedOff = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: AnalysisEvent) => {
          if (disconnected) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n")); }
          catch { disconnected = true; }
        };
        const saveDraft = () => db.update(papers).set({ analysisDraft: structuredClone(draft) }).where(eq(papers.id, paperId));
        let chars = 0;
        try {
          send({ type: "status", status: "analyzing" });
          if (!draft.inventory) {
            const raw = await complete(cfg, {
              system: inventorySystemPrompt(paper.subject, pages.length),
              messages: [{ role: "user", content: allPages }], maxTokens: 16000, signal,
            });
            draft.inventory = parseInventory(raw, pages.length);
            await saveDraft();
          }
          for (const [idx, p] of draft.completed.entries()) {
            send({ type: "problem", problem: { ...p, idx, id: -idx - 1 } });
          }
          const inventory = draft.inventory;
          for (let idx = draft.completed.length; idx < inventory.items.length; idx++) {
            const item = inventory.items[idx];
            let lastError: unknown;
            let result: AnalyzedProblem | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const parser = createTagParser(["problem"]);
                const blocks: TagBlock[] = [];
                const content: LLMPart[] = [{
                  type: "text", text: `只解析第 ${item.number} 题，起始页码 ${item.page}，结束页码 ${item.endPage}。\n完整题干：\n${item.content}\n只输出一个完整的 <problem>，number="${item.number}" page="${item.page}"。`,
                }, ...allPages.slice((item.page - 1) * 2, item.endPage * 2)];
                for await (const delta of streamChat(cfg, {
                  system: analysisSystemPrompt(paper.subject) + "\n本次只分析用户指定的一道题，不输出 paper 或其他题目。",
                  messages: [{ role: "user", content }], maxTokens: 16000, signal,
                })) {
                  chars += delta.length;
                  blocks.push(...parser.push(delta));
                  send({ type: "progress", chars });
                }
                blocks.push(...parser.end());
                if (blocks.length !== 1) throw new Error(`第 ${item.number} 题的解析格式不正确，请重试。`);
                result = parseAnalyzedProblem(blocks[0], item);
                lastError = null;
                break;
              } catch (e) {
                lastError = e;
                if (signal.aborted) break;
              }
            }
            if (lastError) throw lastError;
            if (!result) throw new Error(`第 ${item.number} 题未完成，请重试。`);
            draft.completed.push(result);
            await saveDraft();
            send({ type: "problem", problem: { ...result, idx, id: -idx - 1 } });
          }
          const published = await db.transaction(async (tx) => {
            const [old] = await tx.select().from(papers).where(eq(papers.id, paperId)).for("update");
            const oldProblems = await tx.select().from(problems).where(eq(problems.paperId, paperId)).orderBy(asc(problems.idx));
            if (oldProblems.length) {
              await tx.update(sessions).set({ snapshot: classroomSnapshot(old, oldProblems) })
                .where(and(eq(sessions.paperId, paperId), isNull(sessions.snapshot)));
            }
            await tx.delete(problems).where(eq(problems.paperId, paperId));
            await tx.insert(problems).values(draft.completed.map((p, idx) => ({ ...p, idx, paperId })));
            const [updated] = await tx.update(papers).set({
              status: "ready", error: null, analysisDraft: null, overview: inventory.overview,
              title: paper.title.startsWith("未命名") && inventory.title ? inventory.title.slice(0, 100) : paper.title,
            }).where(eq(papers.id, paperId)).returning();
            return updated;
          });
          send({ type: "paper", paper: toPaperDTO(published) });
          send({ type: "done", paper: toPaperDTO(published) });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await db.update(papers).set({ status: "failed", error }).where(eq(papers.id, paperId));
          send({ type: "status", status: "failed" });
          send({ type: "error", error });
        } finally {
          await release();
          if (!disconnected) {
            try { controller.close(); } catch { /* disconnected */ }
          }
        }
      },
      cancel() { disconnected = true; },
    });
    return new Response(stream, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  } finally {
    if (!handedOff) await release();
  }
}
