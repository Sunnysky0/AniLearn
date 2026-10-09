import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, papers, problems, sessions, tutors } from "@/db/schema";
import { classroomSnapshot, problemDivider } from "@/lib/server/data";
import { fullPlan, makeLearningPlan, directoryProblems } from "@/lib/server/learning-plan";
import { legacyInventory } from "@/lib/server/session-plan";
import { getLLMConfig, getSettings } from "@/lib/server/settings";
import { toProblemDTO } from "@/lib/server/data";
import { isTeachingPace, type TeachingPace } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { paperId?: number; tutorId?: number; pace?: TeachingPace; request?: string };
  const paperId = Number(body.paperId);
  const tutorId = Number(body.tutorId);
  if (![paperId, tutorId].every((id) => Number.isInteger(id) && id > 0 && id <= 2147483647) || body.pace !== undefined && !isTeachingPace(body.pace)) {
    return Response.json({ error: "缺少试卷或导师" }, { status: 400 });
  }
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, tutorId));
  if (!tutor) return Response.json({ error: "导师不存在" }, { status: 404 });
  const settings = await getSettings();
  try { return await db.transaction(async (tx) => {
  const [paper] = await tx.select().from(papers).where(eq(papers.id, paperId)).for("update");
  if (!paper) return Response.json({ error: "试卷不存在" }, { status: 404 });
  if (paper.status !== "ready" || paper.error || paper.analysisDraft) {
    return Response.json({ error: "试卷尚未完整解析，请完成解析后再开始上课。" }, { status: 400 });
  }
  const probs = await tx.select().from(problems).where(eq(problems.paperId, paperId)).orderBy(asc(problems.idx));
  if (!probs.length || probs.some((p) => !p.answer || !p.solution || !p.keyPoints.length || !p.knowledgePoints.length || !p.skills.length)) {
    return Response.json({ error: "试卷解析内容不完整，请重新解析。" }, { status: 400 });
  }
  let plan = paper.analysisPlan ?? fullPlan(probs);
  let pendingPlan = null;
  const request = typeof body.request === "string" ? body.request.slice(0, 2000) : "";
  if (body.pace && body.pace !== plan.pace || request) {
    const desired = await makeLearningPlan(getLLMConfig(settings, "analysis"), paper.inventory ?? legacyInventory(probs.map(toProblemDTO)), body.pace ?? plan.pace, request, plan.version + 1, AbortSignal.timeout(180_000));
    if (desired.units.some((u) => !probs.some((p) => p.idx === u.idx))) pendingPlan = desired;
    else plan = desired;
  }
  const directory = directoryProblems(paper.inventory, probs.map(toProblemDTO));
  if (plan.units.some((u) => !directory[u.idx]?.solution)) return Response.json({ error: "当前计划解析不完整，请重新解析。" }, { status: 400 });
  const [s] = await tx
    .insert(sessions)
    .values({ paperId, tutorId, currentIdx: plan.units[0].idx, status: "active", progress: { [String(plan.units[0].idx)]: "active" }, snapshot: classroomSnapshot(paper, probs), plan, pendingPlan, planRevision: pendingPlan?.version ?? plan.version })
    .returning();
  await tx.insert(messages).values({
    sessionId: s.id,
    role: "system",
    kind: "problem",
    content: problemDivider(probs.find((p) => p.idx === s.currentIdx) ?? probs[0]),
    problemIdx: s.currentIdx,
  });
  return Response.json({ id: s.id });
  }); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}
