import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, papers, problems, sessions, tutors } from "@/db/schema";
import { classroomSnapshot, problemDivider } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { paperId?: number; tutorId?: number };
  const paperId = Number(body.paperId);
  const tutorId = Number(body.tutorId);
  if (!Number.isFinite(paperId) || !Number.isFinite(tutorId)) {
    return Response.json({ error: "缺少试卷或导师" }, { status: 400 });
  }
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, tutorId));
  if (!tutor) return Response.json({ error: "导师不存在" }, { status: 404 });
  return db.transaction(async (tx) => {
  const [paper] = await tx.select().from(papers).where(eq(papers.id, paperId)).for("update");
  if (!paper) return Response.json({ error: "试卷不存在" }, { status: 404 });
  if (paper.status !== "ready" || paper.error || paper.analysisDraft) {
    return Response.json({ error: "试卷尚未完整解析，请完成解析后再开始上课。" }, { status: 400 });
  }
  const probs = await tx.select().from(problems).where(eq(problems.paperId, paperId)).orderBy(asc(problems.idx));
  if (!probs.length || probs.some((p) => !p.answer || !p.solution || !p.keyPoints.length || !p.knowledgePoints.length || !p.skills.length)) {
    return Response.json({ error: "试卷解析内容不完整，请重新解析。" }, { status: 400 });
  }
  const [s] = await tx
    .insert(sessions)
    .values({ paperId, tutorId, currentIdx: 0, status: "active", progress: { "0": "active" }, snapshot: classroomSnapshot(paper, probs) })
    .returning();
  await tx.insert(messages).values({
    sessionId: s.id,
    role: "system",
    kind: "problem",
    content: problemDivider(probs[0]),
    problemIdx: 0,
  });
  return Response.json({ id: s.id });
  });
}
