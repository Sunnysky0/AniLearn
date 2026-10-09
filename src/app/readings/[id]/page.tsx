import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingSessions } from "@/db/schema";
import { getReading, validId } from "@/lib/server/readings";
import { listTutors } from "@/lib/server/data";
import { AppHeader } from "@/components/AppHeader";
import ReadingView from "@/components/readings/ReadingView";
export const dynamic = "force-dynamic";
export default async function ReadingPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validId((await params).id); const material = id && await getReading(id); if (!material) notFound();
  const classrooms = await db.select({ id: readingSessions.id, currentIdx: readingSessions.currentIdx, status: readingSessions.status }).from(readingSessions).where(eq(readingSessions.readingId, material.row.id)).orderBy(asc(readingSessions.id));
  return <div><AppHeader /><ReadingView initial={material.dto} sources={material.sources.map((s) => ({ idx: s.idx, mime: s.mime }))} tutors={await listTutors()} classrooms={classrooms} /></div>;
}
