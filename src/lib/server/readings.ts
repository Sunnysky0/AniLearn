import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSources, readingSessions, readingMessages, tutors } from "@/db/schema";
import { MAX_PAPER_PAGES, MAX_PAPER_TEXT_BYTES, type ReadingDTO, type ReadingMessage, type ReadingSessionDTO, type ReadingParagraph } from "@/lib/types";
import { parseDataUrl } from "./llm";
import { decodePaperText } from "@/lib/paper-source";

export function validId(value: string): number | null {
  const id = Number(value); return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}
export function readingDTO(row: typeof readings.$inferSelect, pageCount = 0): ReadingDTO {
  return { id: row.id, title: row.title, language: row.language === "ja" ? "ja" : "en", status: row.status, paragraphs: row.paragraphs, extracted: row.extracted, overview: row.overview, error: row.error, revision: row.revision, createdAt: row.createdAt.toISOString(), pageCount };
}
export function readingSessionDTO(row: typeof readingSessions.$inferSelect): ReadingSessionDTO {
  return { id: row.id, readingId: row.readingId, tutorId: row.tutorId, currentIdx: row.currentIdx, status: row.status, progress: row.progress, notes: row.notes, updatedAt: row.updatedAt.toISOString() };
}
export function readingMessageDTO(row: typeof readingMessages.$inferSelect): ReadingMessage {
  return { id: row.id, role: row.role as ReadingMessage["role"], content: row.content, speech: row.speech, paragraphIdx: row.paragraphIdx, kind: row.kind as ReadingMessage["kind"], language: row.language as ReadingMessage["language"] };
}
export function paragraphsFromText(text: string, revision: number, sources: string[] = []): ReadingParagraph[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error("文章原文不能为空。");
  if (paragraphs.length > 1000) throw new Error("文章段落过多，请拆分为单篇材料。");
  let page = 1;
  return paragraphs.map((text, i) => {
    const match = sources.findIndex((source, index) => index >= page - 1 && source.includes(text));
    if (match >= 0) page = match + 1;
    return { id: `${revision}-p${i + 1}`, text, page };
  });
}
export function decodeReadingSource(dataUrl: unknown) {
  const parsed = parseDataUrl(typeof dataUrl === "string" ? dataUrl : "");
  if (!parsed || !/^(?:image\/(?:jpeg|png|webp|gif)|text\/(?:plain|markdown))$/.test(parsed.mime)) throw new Error("仅支持图片、Markdown 和纯文本来源。");
  const isText = parsed.mime.startsWith("text/");
  if (parsed.data.length > (isText ? 2_000_000 : 12_000_000)) throw new Error(isText ? "单个文本最多 1.5 MB。" : "图片过大。");
  if (isText) {
    if (parsed.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data)) throw new Error("文本编码无效。");
    const bytes = Buffer.from(parsed.data, "base64"); if (bytes.length > MAX_PAPER_TEXT_BYTES) throw new Error("单个文本最多 1.5 MB。");
    decodePaperText(bytes);
  }
  return parsed;
}
export async function getReading(id: number) {
  const [row] = await db.select().from(readings).where(eq(readings.id, id));
  if (!row) return null;
  const sources = await db.select().from(readingSources).where(eq(readingSources.readingId, id)).orderBy(asc(readingSources.idx));
  return { row, sources, dto: readingDTO(row, sources.length) };
}
export async function loadReadingSession(id: number) {
  const [session] = await db.select().from(readingSessions).where(eq(readingSessions.id, id)); if (!session) return null;
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, session.tutorId)); if (!tutor) return null;
  const messages = await db.select().from(readingMessages).where(eq(readingMessages.sessionId, id)).orderBy(asc(readingMessages.id));
  return { session, tutor, reading: session.snapshot, messages };
}
export { MAX_PAPER_PAGES };
