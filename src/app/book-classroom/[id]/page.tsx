import { notFound } from "next/navigation";
import { validBookId } from "@/lib/server/book-catalog";
import { bookSessionPayload } from "@/lib/server/book-sessions";
import { getSettings, isLLMReady, isTTSReady } from "@/lib/server/settings";
import BookClassroom from "@/components/books/BookClassroom";
import { bookReaderContext, getBookBookmarks, getBookReaderState } from "@/lib/server/book-reader";
export const dynamic = "force-dynamic";
export default async function BookClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validBookId((await params).id); const payload = id && await bookSessionPayload(id);
  if (!payload) notFound();
  const readerContext = await bookReaderContext(String(id));
  const [initialReaderState, initialBookmarks] = await Promise.all([getBookReaderState(readerContext), getBookBookmarks(readerContext)]);
  const settings = await getSettings();
  return <BookClassroom {...payload} initialReaderState={initialReaderState} initialBookmarks={initialBookmarks} llmReady={isLLMReady(settings, "chat")} analysisReady={isLLMReady(settings, "analysis")} ttsReady={isTTSReady(settings)} />;
}
