import { notFound } from "next/navigation";
import { loadReadingSession, readingSessionDTO, readingMessageDTO, validId } from "@/lib/server/readings";
import { toTutorDTO } from "@/lib/server/data";
import { getSettings, isTTSReady, isLLMReady } from "@/lib/server/settings";
import ReadingClassroom from "@/components/readings/ReadingClassroom";
export const dynamic = "force-dynamic";
export default async function ReadingClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validId((await params).id); const bundle = id && await loadReadingSession(id); if (!bundle) notFound(); const settings = await getSettings();
  return <ReadingClassroom reading={bundle.reading} session={readingSessionDTO(bundle.session)} tutor={toTutorDTO(bundle.tutor)} initialMessages={bundle.messages.map(readingMessageDTO)} ttsReady={isTTSReady(settings)} llmReady={isLLMReady(settings, "chat")} />;
}
