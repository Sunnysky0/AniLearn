import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readingSessions } from "@/db/schema";
import { validId } from "@/lib/server/readings";
import { readingAnalysisProgress } from "@/lib/server/reading-analysis-context";
import { tryOperationLock } from "@/lib/server/locks";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = validId((await ctx.params).id);
  if (!sessionId) return Response.json({ error: "课堂 ID 无效。" }, { status: 400 });
  let [row] = await db.select({ learningState: readingSessions.learningState, analysisDraft: readingSessions.analysisDraft })
    .from(readingSessions).where(eq(readingSessions.id, sessionId));
  if (!row) return Response.json({ error: "课堂不存在。" }, { status: 404 });
  const release = await tryOperationLock("readingAnalysis", sessionId);
  const running = release === null;
  if (release) {
    await release();
    [row] = await db.select({ learningState: readingSessions.learningState, analysisDraft: readingSessions.analysisDraft })
      .from(readingSessions).where(eq(readingSessions.id, sessionId));
    if (!row) return Response.json({ error: "课堂不存在。" }, { status: 404 });
  }
  const progress = readingAnalysisProgress(row.analysisDraft);
  const resumable = !running && progress.status !== "ready" && (progress.resumable || row.learningState?.phase === "article_analysis");
  return Response.json({ ...progress, running, resumable, phase: row.learningState?.phase ?? "free_reading", learning: row.learningState }, { headers: { "Cache-Control": "no-store" } });
}
