import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { assertSchemaReady } from "./schema-readiness";
import { bookAssets, bookChapters, books, bookVersions } from "@/db/books-schema";
import type { BookDTO, BookImportDraft, BookKind, BookLanguage, BookMaterialDTO, BookStatus, BookVersionDTO, ReaderDocument, ReaderUnit } from "@/lib/types";
import { tryOperationLock } from "./locks";
import { mapEpubReaderFootnotes, mapEpubReaderLinks } from "./book-epub";

export function validBookId(value: unknown): number | null {
  const id = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

export function toBookDTO(row: typeof books.$inferSelect, versionId = row.currentVersionId): BookDTO {
  return {
    id: row.id, title: row.title, author: row.author, language: row.language as BookLanguage,
    kind: row.kind as BookKind, status: row.status as BookStatus, currentVersionId: row.currentVersionId,
    builtinKey: row.builtinKey, error: row.error, createdAt: row.createdAt.toISOString(),
    coverUrl: row.coverAssetId && versionId ? `/api/books/${row.id}/versions/${versionId}/assets/${encodeURIComponent(row.coverAssetId)}` : null,
  };
}

export async function bookVersionActivity(id: number): Promise<{ running: boolean; resumable: boolean }> {
  const release = await tryOperationLock("bookVersion", id);
  const running = !release;
  if (release) await release();
  return { running, resumable: !running };
}

export function toBookVersionDTO(row: Omit<typeof bookVersions.$inferSelect, "sourceData" | "convertedData">, running = false): BookVersionDTO {
  return {
    id: row.id, bookId: row.bookId, status: row.status as BookStatus, revision: row.revision,
    sourceHash: row.sourceHash, parserVersion: row.parserVersion, fileName: row.fileName,
    format: row.format as "epub" | "mobi", chapters: row.draft?.chapters ?? [],
    completedFiles: row.draft?.processedFiles.length ?? 0, totalFiles: row.draft?.totalFiles ?? 0,
    running, resumable: !running && ["uploaded", "importing", "failed"].includes(row.status), error: row.error,
  };
}

export async function ensureBuiltinBooks() {
  const { seedBuiltinBooks } = await import("./book-import");
  await seedBuiltinBooks();
}

export async function listBooks(): Promise<BookDTO[]> {
  await assertSchemaReady(pool);
  await ensureBuiltinBooks();
  const rows = await db.select().from(books).orderBy(desc(books.createdAt), desc(books.id));
  const output: BookDTO[] = [];
  for (const row of rows) {
    const [latest] = row.currentVersionId ? [] : await db.select({ id: bookVersions.id }).from(bookVersions).where(eq(bookVersions.bookId, row.id)).orderBy(desc(bookVersions.id)).limit(1);
    output.push(toBookDTO(row, row.currentVersionId ?? latest?.id ?? null));
  }
  return output;
}

export async function getBookVersion(bookId: number, versionId?: number, fullDraft = false) {
  const { sourceData: _sourceData, convertedData: _convertedData, draft, footnotes, ...columns } = getTableColumns(bookVersions);
  const summaryDraft = sql<BookImportDraft | null>`case when ${draft} is null then null else jsonb_build_object('blocks','[]'::jsonb,'chapters',${draft}->'chapters','footnotes','{}'::jsonb,'processedFiles',${draft}->'processedFiles','totalFiles',${draft}->'totalFiles','metadata',${draft}->'metadata') end`;
  const rows = await db.select({ ...columns, draft: fullDraft ? draft : summaryDraft, footnotes: fullDraft ? footnotes : sql<Record<string, never>>`'{}'::jsonb` }).from(bookVersions).where(versionId ? and(eq(bookVersions.bookId, bookId), eq(bookVersions.id, versionId)) : eq(bookVersions.bookId, bookId)).orderBy(desc(bookVersions.id)).limit(1);
  return rows[0] ?? null;
}

async function publishedUnits(versionId: number): Promise<ReaderUnit[]> {
  const rows = await db.select({ id: bookChapters.id, title: bookChapters.title, parentId: bookChapters.parentId, role: bookChapters.role, order: bookChapters.order, blockCount: sql<number>`jsonb_array_length(${bookChapters.blocks})` }).from(bookChapters).where(eq(bookChapters.versionId, versionId)).orderBy(asc(bookChapters.order));
  return rows.map(row => ({ ...row, role: row.role as ReaderUnit["role"] }));
}

export async function getBookMaterial(id: number, versionId?: number): Promise<BookMaterialDTO | null> {
  const [row] = await db.select().from(books).where(eq(books.id, id));
  if (!row) return null;
  const version = await getBookVersion(id, versionId);
  if (!version) return null;
  const { running } = await bookVersionActivity(version.id);
  const chapters = version.status === "ready" ? await publishedUnits(version.id) : (version.draft?.chapters ?? []).map(({ blockIds: _blockIds, ...chapter }) => chapter);
  const metadata = version.draft?.metadata as (BookImportDraft["metadata"] & { kind?: BookKind }) | undefined;
  const book = { ...toBookDTO(row, version.id), ...(metadata ? { title: metadata.title, author: metadata.author, language: metadata.language, kind: metadata.kind ?? row.kind as BookKind, coverUrl: metadata.coverAssetId ? `/api/books/${id}/versions/${version.id}/assets/${encodeURIComponent(metadata.coverAssetId)}` : null } : {}) };
  return { book, version: toBookVersionDTO(version, running), chapters };
}

export async function getBookDocument(bookId: number, versionId: number, chapterId: string): Promise<ReaderDocument | null> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  const version = await getBookVersion(bookId, versionId, true);
  if (!book || !version) return null;
  const [chapter] = version.status === "ready" ? await db.select().from(bookChapters).where(and(eq(bookChapters.versionId, versionId), eq(bookChapters.id, chapterId))) : [];
  const draftChapter = version.draft?.chapters.find(item => item.id === chapterId);
  if (!chapter && !draftChapter) return null;
  const blockIds = new Set(draftChapter?.blockIds ?? []);
  const chapterBlocks = chapter?.blocks ?? version.draft?.blocks.filter(block => blockIds.has(block.id)) ?? [];
  const resources = await db.select({ id: bookAssets.key, mime: bookAssets.mime, width: bookAssets.width, height: bookAssets.height }).from(bookAssets).where(eq(bookAssets.versionId, versionId));
  const units = version.status === "ready" ? await publishedUnits(versionId) : (version.draft?.chapters ?? []).map(({ blockIds: _blockIds, ...item }) => item);
  const footnotes = version.footnotes && Object.keys(version.footnotes).length ? version.footnotes : version.draft?.footnotes ?? {};
  const allBlocks = version.draft?.blocks ?? chapterBlocks;
  const chapters = version.draft?.chapters ?? [];
  return {
    key: `book:${bookId}:version:${versionId}`, title: chapter?.title ?? draftChapter!.title,
    language: version.draft?.metadata.language ?? book.language, unitId: chapterId, units, blocks: mapEpubReaderLinks(chapterBlocks, allBlocks, chapters),
    resources: resources.map(resource => ({ id: resource.id, mime: resource.mime, url: `/api/books/${bookId}/versions/${versionId}/assets/${encodeURIComponent(resource.id)}`, ...(resource.width ? { width: resource.width } : {}), ...(resource.height ? { height: resource.height } : {}) })),
    footnotes: mapEpubReaderFootnotes(footnotes, allBlocks, chapters),
  };
}
