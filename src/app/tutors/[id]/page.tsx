import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tutors } from "@/db/schema";
import { AppHeader } from "@/components/AppHeader";
import TutorEditor from "@/components/TutorEditor";
import { toTutorDTO } from "@/lib/server/data";
import { getSettings, isTTSReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function TutorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ttsReady = isTTSReady(await getSettings());
  if (id === "new") {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <TutorEditor initial={null} ttsReady={ttsReady} />
      </div>
    );
  }
  const n = Number(id);
  if (!Number.isFinite(n)) notFound();
  const [row] = await db.select().from(tutors).where(eq(tutors.id, n));
  if (!row) notFound();
  return (
    <div className="min-h-screen">
      <AppHeader />
      <TutorEditor initial={toTutorDTO(row)} ttsReady={ttsReady} />
    </div>
  );
}
