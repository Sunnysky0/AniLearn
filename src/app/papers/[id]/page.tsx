import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { papers, problems, sessions, tutors } from "@/db/schema";
import { AppHeader } from "@/components/AppHeader";
import PaperView from "@/components/PaperView";
import { listTutors, toPaperDTO, visibleProblems } from "@/lib/server/data";
import { getSettings, resolveProviderKey } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function PaperPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();
  const [paper] = await db.select().from(papers).where(eq(papers.id, id));
  if (!paper) notFound();
  const probs = await db.select().from(problems).where(eq(problems.paperId, id)).orderBy(asc(problems.idx));
  const tutorList = await listTutors();
  const sess = await db
    .select({
      id: sessions.id,
      currentIdx: sessions.currentIdx,
      status: sessions.status,
      updatedAt: sessions.updatedAt,
      tutorName: tutors.name,
      tutorAvatar: tutors.avatar,
    })
    .from(sessions)
    .innerJoin(tutors, eq(sessions.tutorId, tutors.id))
    .where(eq(sessions.paperId, id))
    .orderBy(desc(sessions.updatedAt));
  const settings = await getSettings();

  return (
    <div className="min-h-screen">
      <AppHeader />
      <PaperView
        paper={toPaperDTO(paper)}
        problems={visibleProblems(paper, probs)}
        tutors={tutorList}
        sessions={sess.map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() }))}
        llmReady={!!resolveProviderKey(settings, settings.provider).key}
      />
    </div>
  );
}
