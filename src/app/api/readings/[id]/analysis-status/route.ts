import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSources } from "@/db/schema";
import { validId, getReadingDraftKeys } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id);
  if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const [row] = await db.select({ status: readings.status, revision: readings.revision, expectedPageCount: readings.expectedPageCount, error: readings.error })
    .from(readings).where(eq(readings.id, id));
  if (!row) return Response.json({ error: "材料不存在" }, { status: 404 });
  const sources = await db.select({ idx: readingSources.idx }).from(readingSources)
    .where(eq(readingSources.readingId, id)).orderBy(asc(readingSources.idx));
  const draftKeys = await getReadingDraftKeys(id);
  const totalPages = row.expectedPageCount || sources.length;
  const sourcesComplete = sources.length === totalPages && sources.every((source, index) => source.idx === index);
  const done = sources.reduce((count, source) => count + (draftKeys.has(String(source.idx)) ? 1 : 0), 0);
  const firstMissing = sourcesComplete ? sources.find((source) => !draftKeys.has(String(source.idx)))?.idx : undefined;
  const currentPage = firstMissing === undefined ? (sourcesComplete ? null : sources.length + 1) : firstMissing + 1;
  const release = await tryOperationLock("reading", id);
  const running = release === null;
  if (release) await release();
  return Response.json({
    status: row.status,
    revision: row.revision,
    completedPages: done,
    totalPages,
    currentPage: done < totalPages ? currentPage : null,
    sourcesComplete,
    running,
    // A process can stop after saving the final page but before publishing the
    // review state. Let the user resume in that case so the task can finalize.
    resumable: !running && sourcesComplete && (done < totalPages || row.status === "analyzing" || row.status === "failed"),
    error: row.error,
  });
}
