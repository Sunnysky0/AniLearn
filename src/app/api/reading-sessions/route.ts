import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSessions, tutors } from "@/db/schema";
import { initialReadingLearningState, readingDTO } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
import { getReadingReaderState } from "@/lib/server/reading-reader";
import { readingDocument } from "@/lib/reader/reading-adapter";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const body = await req.json().catch(() => null); const id = Number(body?.readingId); const tutorId = Number(body?.tutorId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(tutorId) || tutorId <= 0) return Response.json({ error: "缺少材料或导师" }, { status: 400 });
  const release = await tryOperationLock("reading", id); if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  try {
    const [tutor] = await db.select({ id: tutors.id }).from(tutors).where(eq(tutors.id, tutorId)); if (!tutor) return Response.json({ error: "导师不存在" }, { status: 404 });
    const [reading] = await db.select().from(readings).where(eq(readings.id, id));
    if (!reading || reading.status !== "ready" || !reading.paragraphs.length) return Response.json({ error: "请先确认文章原文" }, { status: 400 });
    const initial = initialReadingLearningState({ status: "active", progress: {}, notes: {} });
    initial.legacy = null;
    const snapshot = readingDTO(reading); const document = readingDocument(snapshot);
    const readerState = await getReadingReaderState({ readingId: id, document, sourceRevision: reading.revision });
    const currentIdx = Math.max(0, document.blocks.findIndex(block => block.id === readerState.position?.blockId));
    const [session] = await db.insert(readingSessions).values({
      readingId: id, tutorId, snapshot, currentIdx, readerPosition: readerState.position, progress: { "0": "active" },
      learningState: initial, analysisDraft: { status: "idle", requestId: null, sourceRevision: reading.revision, totalChunks: 0, chunks: {}, merges: {}, context: "", articleKind: null, error: null },
    }).returning();
    return Response.json({ id: session.id });
  } finally { await release(); }
}
