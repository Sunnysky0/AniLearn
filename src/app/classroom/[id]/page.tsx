import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { boards, messages } from "@/db/schema";
import Classroom from "@/components/classroom/Classroom";
import {
  loadClassroom,
  toBoardDTO,
  toMessageDTO,
  toPaperDTO,
  toProblemDTO,
  toSessionDTO,
  toTutorDTO,
} from "@/lib/server/data";
import { getSettings, isTTSReady, resolveProviderKey } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "AniLearn 课堂" };

export default async function ClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const bundle = await loadClassroom(id);
  if (!bundle) notFound();
  const msgs = await db.select().from(messages).where(eq(messages.sessionId, id)).orderBy(asc(messages.id));
  const bds = await db.select().from(boards).where(eq(boards.sessionId, id));
  const settings = await getSettings();

  return (
    <Classroom
      session={toSessionDTO(bundle.session)}
      tutor={toTutorDTO(bundle.tutor)}
      paper={toPaperDTO(bundle.paper)}
      problems={bundle.problems.map(toProblemDTO)}
      initialMessages={msgs.map(toMessageDTO)}
      initialBoards={bds.map(toBoardDTO)}
      ttsAvailable={isTTSReady(settings)}
      llmReady={!!resolveProviderKey(settings, settings.provider).key}
      autoContinueDefault={settings.autoContinue}
    />
  );
}
