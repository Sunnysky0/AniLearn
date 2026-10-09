import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { papers, problems } from "@/db/schema";
import { paperPageMimes, toPaperDTO, visibleProblems } from "@/lib/server/data";
import { SUBJECTS } from "@/lib/types";
import { tryOperationLock } from "@/lib/server/locks";
import { directoryDTO } from "@/lib/server/learning-plan";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return Response.json({ error: "无效的试卷 ID" }, { status: 400 });
  const [row] = await db.select({ paper: papers, pageMimes: paperPageMimes() }).from(papers).where(eq(papers.id, id));
  if (!row) return Response.json({ error: "试卷不存在" }, { status: 404 });
  const { paper, pageMimes } = row;
  const probs = await db.select().from(problems).where(eq(problems.paperId, id)).orderBy(asc(problems.idx));
  const visible = visibleProblems(paper, probs);
  return Response.json({ paper: toPaperDTO(paper, pageMimes), problems: visible, directory: directoryDTO(paper.analysisDraft?.inventory ?? paper.inventory, visible) });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return Response.json({ error: "无效的试卷 ID" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { title?: string; subject?: string };
  const patch: { title?: string; subject?: string } = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 100);
  if (typeof body.subject === "string" && SUBJECTS.includes(body.subject)) patch.subject = body.subject;
  if (!Object.keys(patch).length) return Response.json({ error: "没有需要更新的字段" }, { status: 400 });
  const release = await tryOperationLock("paper", id);
  if (!release) return Response.json({ error: "试卷正在解析，请稍候再编辑。" }, { status: 409 });
  try {
  if (patch.subject) {
    const [paper] = await db.select().from(papers).where(eq(papers.id, id));
    if (paper?.analysisDraft || paper?.status === "ready") {
      return Response.json({ error: "已解析的试卷不能修改学科，请创建新试卷。" }, { status: 400 });
    }
  }
  const [row] = await db.update(papers).set(patch).where(eq(papers.id, id)).returning();
  if (!row) return Response.json({ error: "试卷不存在" }, { status: 404 });
  return Response.json(toPaperDTO(row));
  } finally { await release(); }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return Response.json({ error: "无效的试卷 ID" }, { status: 400 });
  const release = await tryOperationLock("paper", id);
  if (!release) return Response.json({ error: "试卷正在解析，请稍候再删除。" }, { status: 409 });
  try {
  await db.delete(papers).where(eq(papers.id, id));
  return Response.json({ ok: true });
  } finally { await release(); }
}
