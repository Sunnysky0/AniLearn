import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { papers, problems } from "@/db/schema";
import { toPaperDTO } from "@/lib/server/data";
import { SUBJECTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select({
      paper: papers,
      problemCount: sql<number>`(select count(*)::int from ${problems} where ${problems.paperId} = ${papers.id})`,
    })
    .from(papers)
    .orderBy(desc(papers.createdAt));
  return Response.json(rows.map((r) => ({ ...toPaperDTO(r.paper), problemCount: Number(r.problemCount) })));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string; subject?: string };
  const now = new Date();
  const fallback = `未命名试卷 ${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const title = (body.title ?? "").trim().slice(0, 100) || fallback;
  const subject = SUBJECTS.includes(body.subject ?? "") ? (body.subject as string) : "数学";
  const [row] = await db.insert(papers).values({ title, subject, status: "uploaded" }).returning();
  return Response.json(toPaperDTO(row));
}
