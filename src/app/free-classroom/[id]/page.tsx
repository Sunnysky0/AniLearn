import { notFound } from "next/navigation";
import FreeClassroom from "@/components/free/FreeClassroom";
import { loadFreeSession, toFreeMessageDTO, toFreeSessionDTO, toFreeTopicDTO, validFreeId } from "@/lib/server/free-data";
import { toTutorDTO } from "@/lib/server/data";
import { getSettings, isLLMReady, isTTSReady } from "@/lib/server/settings";
import { db } from "@/db";
import { freeTurns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function FreeClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validFreeId((await params).id);
  if (!id) notFound();
  const [bundle, settings] = await Promise.all([loadFreeSession(id), getSettings()]);
  if (!bundle) notFound();
  const turns = await db.select({ id: freeTurns.id, requestId: freeTurns.requestId, intent: freeTurns.intent, status: freeTurns.status, topicId: freeTurns.topicId, requestedTopicId: freeTurns.requestedTopicId, action: freeTurns.action })
    .from(freeTurns).where(eq(freeTurns.sessionId, id)).orderBy(desc(freeTurns.id)).limit(80);
  return <FreeClassroom
    session={toFreeSessionDTO(bundle.session)} tutor={toTutorDTO(bundle.tutor)}
    topics={bundle.topics.map(toFreeTopicDTO)} messages={bundle.messages.map(toFreeMessageDTO)}
    hasMoreMessages={bundle.hasMoreMessages} oldestMessageId={bundle.oldestMessageId}
    moreTurns={turns.reverse()} llmReady={isLLMReady(settings, "chat")} ttsReady={isTTSReady(settings)} autoContinueDefault={settings.autoContinue}
  />;
}
