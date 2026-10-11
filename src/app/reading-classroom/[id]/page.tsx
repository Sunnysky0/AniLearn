import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingPersonalNotes } from "@/db/schema";
import { loadReadingSession, readingSessionDTO, readingMessageDTO, validId } from "@/lib/server/readings";
import { toTutorDTO } from "@/lib/server/data";
import { getSettings, isTTSReady, isLLMReady } from "@/lib/server/settings";
import ReadingClassroom from "@/components/readings/ReadingClassroom";
import { readingPersonalNoteDTO } from "@/lib/server/readings";
export const dynamic = "force-dynamic";
export default async function ReadingClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validId((await params).id); const bundle = id && await loadReadingSession(id); if (!bundle) notFound(); const settings = await getSettings();
  const notes = await db.select().from(readingPersonalNotes).where(eq(readingPersonalNotes.sessionId, bundle.session.id)).orderBy(asc(readingPersonalNotes.id));
  return <ReadingClassroom reading={bundle.reading} session={readingSessionDTO(bundle.session)} tutor={toTutorDTO(bundle.tutor)} initialMessages={bundle.messages.map(readingMessageDTO)} initialPersonalNotes={notes.map(readingPersonalNoteDTO)} ttsReady={isTTSReady(settings)} llmReady={isLLMReady(settings, "chat")} analysisReady={isLLMReady(settings, "analysis")} />;
}
