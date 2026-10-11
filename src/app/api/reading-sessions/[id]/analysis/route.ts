import { eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { readingSessions } from "@/db/schema";
import { initialReadingLearningState, validId } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
import { runReadingAnalysisPreparation } from "@/lib/server/reading-analysis-context";
import { firstUnconfirmedFocus } from "@/lib/server/reading-learning";
import type { ReadingAnalysisDraft, ReadingLearningState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = validId((await ctx.params).id);
  if (!sessionId) return Response.json({ error: "课堂 ID 无效。" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || !["start", "resume"].includes(body.action) || typeof body.requestId !== "string" || !/^[\w-]{16,140}$/.test(body.requestId)) {
    return Response.json({ error: "全文分析请求无效。" }, { status: 400 });
  }
  const releaseSession = await tryOperationLock("readingSession", sessionId);
  if (!releaseSession) return Response.json({ error: "课堂正在生成回复，请稍后重试。" }, { status: 409 });
  let releaseAnalysis: (() => Promise<void>) | null = null;
  try {
    const [row] = await db.select().from(readingSessions).where(eq(readingSessions.id, sessionId));
    if (!row) return Response.json({ error: "课堂不存在。" }, { status: 404 });
    const existing = row.learningState ?? initialReadingLearningState(row);
    const currentDraft = row.analysisDraft;
    if (currentDraft && currentDraft.requestId === body.requestId) {
      if (currentDraft.status === "ready") return Response.json({ status: "ready", learning: existing });
      if (currentDraft.status === "failed") return Response.json({ status: "failed", resumable: true, error: currentDraft.error, learning: existing });
      const active = await tryOperationLock("readingAnalysis", sessionId);
      if (!active) return Response.json({ status: "running", learning: existing }, { status: 202 });
      await active();
      return Response.json({ status: "interrupted", resumable: true, learning: existing }, { status: 202 });
    }
    if (body.action === "start") {
      if (!Number.isSafeInteger(body.stateRevision) || body.stateRevision !== existing.stateRevision) {
        return Response.json({ error: "课堂状态已变化，请同步后重试。", stateRevision: existing.stateRevision }, { status: 409 });
      }
      if (existing.phase !== "free_reading") return Response.json({ error: "文章分析阶段已经开始。" }, { status: 409 });
      if (row.analysisDraft?.status === "ready" && row.analysisDraft.sourceRevision === row.snapshot.revision) {
        const learning: ReadingLearningState = {
          ...existing, phase: "article_analysis", readingConfirmedAt: existing.readingConfirmedAt ?? new Date().toISOString(),
          articleKind: existing.articleKind ?? row.analysisDraft.articleKind,
          articleKindSource: existing.articleKindSource ?? (row.analysisDraft.articleKind ? "automatic" : null),
          stateRevision: existing.stateRevision + 1,
        };
        if (!learning.currentFocus) learning.currentFocus = firstUnconfirmedFocus(learning);
        if (learning.currentFocus && learning.focusStatus[learning.currentFocus] === "not_started") learning.focusStatus[learning.currentFocus] = "in_progress";
        await db.update(readingSessions).set({ learningState: learning, analysisDraft: { ...row.analysisDraft, requestId: body.requestId }, status: "active", updatedAt: new Date() }).where(eq(readingSessions.id, sessionId));
        return Response.json({ status: "ready", learning });
      }
      const release = await tryOperationLock("readingAnalysis", sessionId);
      if (!release) {
        const learning: ReadingLearningState = {
          ...existing, phase: "article_analysis", readingConfirmedAt: existing.readingConfirmedAt ?? new Date().toISOString(),
          stateRevision: existing.stateRevision + 1,
        };
        await db.update(readingSessions).set({ learningState: learning, status: "active", updatedAt: new Date() }).where(eq(readingSessions.id, sessionId));
        return Response.json({ status: "running", learning }, { status: 202 });
      }
      releaseAnalysis = release;
      const learning: ReadingLearningState = {
        ...existing, phase: "article_analysis", readingConfirmedAt: new Date().toISOString(),
        articleKind: null, articleKindSource: null, currentFocus: null,
        stateRevision: existing.stateRevision + 1,
      };
      const draft: ReadingAnalysisDraft = row.analysisDraft?.sourceRevision === row.snapshot.revision
        ? { ...row.analysisDraft, status: "running", requestId: body.requestId, error: null }
        : { status: "running", requestId: body.requestId, sourceRevision: row.snapshot.revision, totalChunks: 0, chunks: {}, merges: {}, context: "", articleKind: null, error: null };
      await db.update(readingSessions).set({ learningState: learning, analysisDraft: draft, status: "active", updatedAt: new Date() }).where(eq(readingSessions.id, sessionId));
    } else {
      if (existing.phase !== "article_analysis") return Response.json({ error: "请先确认读完整篇，再开始文章分析。" }, { status: 409 });
      if (row.analysisDraft?.status === "ready") return Response.json({ status: "ready", alreadyReady: true });
      releaseAnalysis = await tryOperationLock("readingAnalysis", sessionId);
      if (!releaseAnalysis) return Response.json({ status: "running", learning: existing }, { status: 202 });
      const draft: ReadingAnalysisDraft = row.analysisDraft?.sourceRevision === row.snapshot.revision
        ? { ...row.analysisDraft, status: "running", requestId: body.requestId, error: null }
        : { status: "running", requestId: body.requestId, sourceRevision: row.snapshot.revision, totalChunks: 0, chunks: {}, merges: {}, context: "", articleKind: null, error: null };
      await db.update(readingSessions).set({ analysisDraft: draft, updatedAt: new Date() }).where(eq(readingSessions.id, sessionId));
    }
    const heldRelease = releaseAnalysis;
    after(async () => {
      try { await runReadingAnalysisPreparation(sessionId, heldRelease ?? undefined); }
      catch { /* The saved draft status and error are available through analysis-status. */ }
    });
    releaseAnalysis = null;
    const [started] = await db.select({ learningState: readingSessions.learningState }).from(readingSessions).where(eq(readingSessions.id, sessionId));
    return Response.json({ status: "running", learning: started?.learningState ?? null }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "无法开始全文分析。" }, { status: 500 });
  } finally {
    if (releaseAnalysis) await releaseAnalysis();
    await releaseSession();
  }
}
