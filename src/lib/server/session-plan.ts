import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { sessions, messages } from "@/db/schema";
import { problemDivider } from "./data";
import { fullPlan, makeLearningPlan, missingGoals } from "./learning-plan";
import { getLLMConfig, getSettings } from "./settings";
import type { LearningPlan, PaperInventory, ProblemDTO, TeachingPace } from "@/lib/types";
import type { SessionRow } from "./data";

export function legacyInventory(problems: ProblemDTO[]): PaperInventory {
  return { title: "", overview: "历史试卷", items: problems.map((p) => ({ idx: p.idx, number: p.number, page: p.page, endPage: p.page, content: p.content, title: p.title, difficulty: p.difficulty, topics: p.knowledgePoints.map((k) => k.name), methods: p.skills, traps: p.keyPoints, studentWork: p.studentWork })) };
}
export async function applyPlan(session: SessionRow, plan: LearningPlan, problems: ProblemDTO[]) {
  const progress = { ...session.progress };
  for (const unit of plan.units) if (missingGoals(plan, unit.idx, session.coverage[String(unit.idx)] ?? {}).length && progress[String(unit.idx)] === "done") progress[String(unit.idx)] = "pending";
  const remaining = plan.units.filter((unit) => progress[String(unit.idx)] !== "done");
  const currentIdx = remaining.some((u) => u.idx === session.currentIdx) ? session.currentIdx : remaining[0]?.idx ?? session.currentIdx;
  if (remaining.length) progress[String(currentIdx)] = "active";
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(sessions).set({ plan, planRevision: Math.max(session.planRevision, plan.version), pendingPlan: null, supplementDraft: {}, progress, currentIdx, status: remaining.length ? "active" : "completed", updatedAt: new Date(), snapshot: session.snapshot ? { ...session.snapshot, problems } : undefined }).where(eq(sessions.id, session.id)).returning();
    if (currentIdx !== session.currentIdx) await tx.insert(messages).values({ sessionId: session.id, role: "system", kind: "problem", content: problemDivider(problems[currentIdx]), problemIdx: currentIdx });
    return updated;
  });
}
export async function requestPlan(session: SessionRow, inventory: PaperInventory, problems: ProblemDTO[], pace: TeachingPace, request: string) {
  const cfg = getLLMConfig(await getSettings(), "analysis");
  const previous = session.plan ?? fullPlan(problems);
  const history = await db.select({ role: messages.role, idx: messages.problemIdx, content: messages.content }).from(messages).where(eq(messages.sessionId, session.id)).orderBy(desc(messages.id)).limit(30);
  const context = JSON.stringify({ previous, progress: session.progress, history: history.reverse().map((m) => ({ ...m, content: m.content.slice(0, 1000) })) });
  const plan = await makeLearningPlan(cfg, inventory, pace, request, Math.max(previous.version, session.pendingPlan?.version ?? 1, session.planRevision) + 1, AbortSignal.timeout(180_000), context);
  const missing = plan.units.filter((u) => !problems.find((p) => p.idx === u.idx)?.solution).map((u) => u.idx);
  if (missing.length) {
    const [updated] = await db.update(sessions).set({ pendingPlan: plan, planRevision: plan.version, supplementDraft: {}, updatedAt: new Date() }).where(eq(sessions.id, session.id)).returning();
    return { session: updated, missing };
  }
  return { session: await applyPlan(session, plan, problems), missing: [] };
}
