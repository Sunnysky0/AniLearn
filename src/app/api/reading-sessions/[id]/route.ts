import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingPersonalNotes, readingSessions } from "@/db/schema";
import { validId, loadReadingSession, readingSessionDTO, readingMessageDTO, readingPersonalNoteDTO, initialReadingLearningState } from "@/lib/server/readings";
import { toTutorDTO } from "@/lib/server/data";
import { tryOperationLock } from "@/lib/server/locks";
import { firstUnconfirmedFocus, isReadingFocus, requiredReadingFoci } from "@/lib/server/reading-learning";
import type { ReadingFocus, ReadingLearningState } from "@/lib/types";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); const bundle = id && await loadReadingSession(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
  const personalNotes = await db.select().from(readingPersonalNotes).where(eq(readingPersonalNotes.sessionId, id)).orderBy(asc(readingPersonalNotes.id));
  return Response.json({ session: readingSessionDTO(bundle.session), reading: bundle.reading, tutor: toTutorDTO(bundle.tutor), messages: bundle.messages.map(readingMessageDTO), personalNotes: personalNotes.map(readingPersonalNoteDTO) }, { headers: { "Cache-Control": "no-store" } });
}
export async function PATCH(req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("readingSession", id); if (!release) return Response.json({ error: "课堂正在讲解" }, { status: 409 });
  try {
    const bundle = await loadReadingSession(id); if (!bundle) return Response.json({ error: "课堂不存在" }, { status: 404 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return Response.json({ error: "请求格式不正确。" }, { status: 400 });
    const action = typeof body.action === "string" ? body.action : "bookmark";
    const existing = bundle.session.learningState ?? initialReadingLearningState(bundle.session);
    let learning: ReadingLearningState = { ...existing, focusStatus: { ...existing.focusStatus }, analysisNotes: { ...existing.analysisNotes } };
    let patch: Partial<typeof readingSessions.$inferInsert> = {};
    if (action === "bookmark") {
      if (!Number.isInteger(body.currentIdx) || body.currentIdx < 0 || body.currentIdx >= bundle.reading.paragraphs.length) return Response.json({ error: "段落编号无效" }, { status: 400 });
      patch = { currentIdx: body.currentIdx };
    } else {
      if (!Number.isSafeInteger(body.stateRevision) || body.stateRevision !== existing.stateRevision) {
        return Response.json({ error: "课堂状态已变化，请同步后重试。", stateRevision: existing.stateRevision }, { status: 409 });
      }
      if (action === "return_to_reading") {
        learning = { ...learning, phase: "free_reading", currentFocus: null, stateRevision: learning.stateRevision + 1 };
        patch = { learningState: learning, status: "active" };
      } else if (action === "set_focus") {
        const focus: ReadingFocus | null = isReadingFocus(body.focus) ? body.focus as ReadingFocus : null;
        if (existing.phase !== "article_analysis" || !focus || !requiredReadingFoci(existing.articleKind).includes(focus)) return Response.json({ error: "分析角度无效。" }, { status: 400 });
        if (bundle.session.analysisDraft?.status !== "ready") return Response.json({ error: "全文分析资料尚未准备完成。" }, { status: 409 });
        if (learning.focusStatus[focus] === "not_started") learning.focusStatus[focus] = "in_progress";
        learning = { ...learning, currentFocus: focus, stateRevision: learning.stateRevision + 1 };
        patch = { learningState: learning, status: "active" };
      } else if (action === "set_article_kind") {
        if (existing.phase !== "article_analysis" || !["general", "literary"].includes(body.articleKind) || bundle.session.analysisDraft?.status !== "ready") return Response.json({ error: "文章类型当前不可修改。" }, { status: 400 });
        learning.articleKind = body.articleKind;
        learning.articleKindSource = "user";
        learning.analysisCompletedAt = null;
        learning.summary = "";
        learning.currentFocus = existing.currentFocus && requiredReadingFoci(body.articleKind).includes(existing.currentFocus as ReadingFocus)
          ? existing.currentFocus as ReadingFocus : firstUnconfirmedFocus(learning);
        if (learning.currentFocus && learning.focusStatus[learning.currentFocus] === "not_started") learning.focusStatus[learning.currentFocus] = "in_progress";
        learning = { ...learning, stateRevision: learning.stateRevision + 1 };
        patch = { learningState: learning, status: "active" };
      } else if (action === "confirm_focus") {
        const focus = existing.currentFocus;
        if (existing.phase !== "article_analysis" || !focus || !requiredReadingFoci(existing.articleKind).includes(focus) || !existing.analysisNotes[focus]?.trim()) return Response.json({ error: "请先完成当前角度的分析，再确认理解。" }, { status: 409 });
        learning.focusStatus[focus] = "confirmed";
        learning.currentFocus = firstUnconfirmedFocus(learning);
        if (learning.currentFocus && learning.focusStatus[learning.currentFocus] === "not_started") learning.focusStatus[learning.currentFocus] = "in_progress";
        learning = { ...learning, stateRevision: learning.stateRevision + 1 };
        patch = { learningState: learning, status: "active" };
      } else if (action === "complete_analysis") {
        const complete = requiredReadingFoci(existing.articleKind).every((focus) => existing.focusStatus[focus] === "confirmed");
        if (existing.phase !== "article_analysis" || !complete || !existing.summary.trim()) return Response.json({ error: "请先确认全部分析角度并整理整篇总结。" }, { status: 409 });
        learning.analysisCompletedAt = new Date().toISOString();
        learning = { ...learning, stateRevision: learning.stateRevision + 1 };
        patch = { learningState: learning, status: "completed" };
      } else {
        return Response.json({ error: "课堂操作无效。" }, { status: 400 });
      }
    }
    const [row] = await db.update(readingSessions).set({ ...patch, updatedAt: new Date() }).where(and(eq(readingSessions.id, id))).returning();
    return Response.json(readingSessionDTO(row));
  } finally { await release(); }
}
export async function DELETE(_req: Request, ctx: Ctx) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "课堂 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("readingSession", id); if (!release) return Response.json({ error: "课堂正在讲解" }, { status: 409 });
  try { await db.delete(readingSessions).where(eq(readingSessions.id, id)); return Response.json({ ok: true }); } finally { await release(); }
}
