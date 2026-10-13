import { notFound } from "next/navigation";
import { validBookId } from "@/lib/server/book-catalog";
import { bookSessionPayload } from "@/lib/server/book-sessions";
import { getSettings, isLLMReady, isTTSReady } from "@/lib/server/settings";
import BookClassroom from "@/components/books/BookClassroom";
export const dynamic = "force-dynamic";
export default async function BookClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validBookId((await params).id); const payload = id && await bookSessionPayload(id);
  if (!payload) notFound();
  const settings = await getSettings();
  return <BookClassroom {...payload} llmReady={isLLMReady(settings, "chat")} analysisReady={isLLMReady(settings, "analysis")} ttsReady={isTTSReady(settings)} />;
}
