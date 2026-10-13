import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookAssets, bookChapters, books, bookVersions } from "@/db/books-schema";
import type { BookChapterDraft, BookImportDraft, BookKind, ReaderBlock } from "@/lib/types";
import { MAX_BOOK_UPLOAD_BYTES } from "@/lib/types";
import { BOOK_PARSER_VERSION, buildEpubChapters, buildEpubPlan, epubImportFiles, parseEpubFile, validateBookChapters } from "./book-epub";
import { remapBookImportDraft } from "./book-draft";
import { convertMobi, getMobiCapability } from "./book-mobi";
import { tryOperationLock } from "./locks";

export class BookImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function bookErrorMessage(error: unknown) {
  if (error instanceof BookImportError) return error.message;
  // Database query errors can embed parameters, including the persisted ebook.
  // Only expose our short, human-authored parser/validation diagnostics.
  if (error instanceof Error && error.message.length <= 300 && /^(电子书|EPUB|MOBI|不支持|目录|章节|父章节|内置|请先|书籍|无法启动|转换后的)/u.test(error.message)) return error.message;
  return "书籍操作失败，请稍后重试；已保存的进度会保留";
}
type ImportMetadata = BookImportDraft["metadata"] & { requestId?: string; inputHash?: string; requestedTitle?: string; kind?: BookKind };
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const lockId = (value: string) => parseInt(digest(value).slice(0, 8), 16) % 2147483647;
const BUILTIN_KEY = "selected-dialogues-of-plato";
const BUILTIN_HASH = "fe57ba5bc471550ac502b2256bf4291a011279428523c6f309fbdd8fea8500bb";
export function isBookKind(value: unknown): value is BookKind { return value === "literary" || value === "thought" || value === "classical"; }

export async function createBookUpload(input: { data: Buffer; fileName: string; kind: BookKind; title?: string; requestId?: string }) {
  if (!input.data.length || input.data.length > MAX_BOOK_UPLOAD_BYTES) throw new BookImportError("电子书不能超过 50 MiB", 413);
  const format = path.extname(input.fileName).toLowerCase().slice(1);
  if (format !== "epub" && format !== "mobi") throw new BookImportError("请上传 EPUB 或 MOBI 电子书");
  if (!isBookKind(input.kind)) throw new BookImportError("请选择书籍类型");
  if (input.requestId && !/^[a-zA-Z0-9_-]{8,120}$/u.test(input.requestId)) throw new BookImportError("上传请求标识无效");
  if (input.title && (input.title.length > 300 || !input.title.trim())) throw new BookImportError("书名无效");
  if (format === "mobi") { const available = await getMobiCapability(); if (!available.available) throw new BookImportError(available.error!, 503); }
  const sourceHash = digest(input.data);
  const title = input.title?.trim() ?? "";
  const safeName = path.basename(input.fileName.replace(/\\/gu, "/")).slice(0, 300);
  const inputHash = digest(JSON.stringify({ sourceHash, title, kind: input.kind, fileName: safeName }));
  const release = await tryOperationLock("bookBuiltin", lockId(`upload:${input.requestId ?? inputHash}`));
  if (!release) throw new BookImportError("相同电子书上传正在处理中，请稍后重试", 409);
  try {
    if (input.requestId) {
      // Older directory clones inherited this key. The first version remains
      // the upload result even when those legacy clones are still in the DB.
      const [prior] = await db.select().from(bookVersions).where(sql`${bookVersions.draft} #>> '{metadata,requestId}' = ${input.requestId}`).orderBy(asc(bookVersions.id)).limit(1);
      if (prior) {
        if ((prior.draft?.metadata as ImportMetadata | undefined)?.inputHash !== inputHash) throw new BookImportError("上传请求标识已用于不同文件", 409);
        return { bookId: prior.bookId, versionId: prior.id, created: false };
      }
    }
    return await db.transaction(async tx => {
      const [book] = await tx.insert(books).values({ title: title || safeName.replace(/\.(epub|mobi)$/iu, ""), kind: input.kind, status: "uploaded" }).returning();
      const metadata: ImportMetadata = { title: book.title, author: "", language: "en", requestedTitle: title, kind: input.kind, inputHash, ...(input.requestId ? { requestId: input.requestId } : {}) };
      const [version] = await tx.insert(bookVersions).values({ bookId: book.id, sourceHash, parserVersion: BOOK_PARSER_VERSION, fileName: safeName, format, sourceData: input.data.toString("base64"), draft: { blocks: [], chapters: [], footnotes: {}, processedFiles: [], totalFiles: 0, metadata } }).returning();
      return { bookId: book.id, versionId: version.id, created: true };
    });
  } finally { await release(); }
}

// Caller owns the bookVersion lock. Each completed file is committed once,
// outside parsing/conversion, so restarts resume from persisted checkpoints.
export async function runBookImport(versionId: number): Promise<void> {
  const [row] = await db.select().from(bookVersions).where(eq(bookVersions.id, versionId));
  if (!row) throw new BookImportError("书籍版本不存在", 404);
  if (row.status === "ready" || row.status === "review") return;
  try {
    await db.update(bookVersions).set({ status: "importing", error: null }).where(eq(bookVersions.id, versionId));
    await db.update(books).set({ status: "importing", error: null }).where(and(eq(books.id, row.bookId), sql`${books.currentVersionId} is null`));
    let epub: Buffer = Buffer.from(row.convertedData ?? row.sourceData, "base64");
    if (row.format === "mobi" && !row.convertedData) {
      epub = await convertMobi(epub);
      await db.update(bookVersions).set({ convertedData: epub.toString("base64") }).where(eq(bookVersions.id, versionId));
    }
    const plan = await buildEpubPlan(epub);
    const importFiles = epubImportFiles(plan);
    const originalMetadata = (row.draft?.metadata ?? {}) as ImportMetadata;
    const metadata: ImportMetadata = { ...originalMetadata, ...plan.metadata, title: originalMetadata.requestedTitle || plan.metadata.title };
    let draft: BookImportDraft = row.draft ?? { blocks: [], chapters: [], footnotes: {}, processedFiles: [], totalFiles: 0, metadata };
    if (row.parserVersion !== BOOK_PARSER_VERSION || draft.processedFiles.some((file, index) => file !== importFiles[index])) throw new Error("导入草稿与解析器或原文顺序不匹配，请重新上传");
    draft = { ...draft, totalFiles: importFiles.length, metadata };
    await db.update(bookVersions).set({ draft }).where(eq(bookVersions.id, versionId));
    for (const asset of plan.assets) {
      await db.insert(bookAssets).values({ versionId, key: asset.key, mime: asset.mime, data: asset.data.toString("base64") }).onConflictDoNothing({ target: [bookAssets.versionId, bookAssets.key] });
    }
    for (const file of importFiles) {
      if (draft.processedFiles.includes(file)) continue;
      const parsed = parseEpubFile(plan, file, versionId);
      const next: BookImportDraft = { ...draft, blocks: [...draft.blocks, ...(plan.spine.includes(file) ? parsed.blocks : [])], footnotes: { ...draft.footnotes, ...parsed.footnotes }, processedFiles: [...draft.processedFiles, file] };
      await db.update(bookVersions).set({ draft: next }).where(eq(bookVersions.id, versionId));
      draft = next;
    }
    if (!draft.blocks.length) throw new Error("电子书未包含可阅读的正文");
    const chapters = validateBookChapters(buildEpubChapters(plan, draft.blocks, versionId), draft.blocks, versionId);
    draft = { ...draft, chapters };
    await db.transaction(async tx => {
      await tx.update(bookVersions).set({ draft, status: "review", error: null }).where(eq(bookVersions.id, versionId));
      await tx.update(books).set({ title: metadata.title, author: metadata.author, language: metadata.language, coverAssetId: metadata.coverAssetId ?? null, status: "review", error: null }).where(and(eq(books.id, row.bookId), sql`${books.currentVersionId} is null`));
    });
  } catch (error) {
    const message = bookErrorMessage(error);
    await db.transaction(async tx => {
      await tx.update(bookVersions).set({ status: "failed", error: message }).where(eq(bookVersions.id, versionId));
      await tx.update(books).set({ status: "failed", error: message }).where(and(eq(books.id, row.bookId), sql`${books.currentVersionId} is null`));
    });
    throw error;
  }
}

export async function confirmBookVersion(bookId: number, versionId: number, revision: number, kind?: BookKind) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(bookVersions).where(and(eq(bookVersions.id, versionId), eq(bookVersions.bookId, bookId))).for("update");
    if (!row) throw new BookImportError("书籍版本不存在", 404);
    if (row.revision !== revision) throw new BookImportError("目录已更新，请刷新后再确认", 409);
    if (row.status === "ready") return;
    if (row.status !== "review" || !row.draft || row.draft.processedFiles.length !== row.draft.totalFiles) throw new BookImportError("请先完成电子书导入");
    const chapters = validateBookChapters(row.draft.chapters, row.draft.blocks, versionId);
    const byId = new Map(row.draft.blocks.map(block => [block.id, block]));
    for (const chapter of chapters) await tx.insert(bookChapters).values({ id: chapter.id, versionId, title: chapter.title, parentId: chapter.parentId, role: chapter.role, order: chapter.order, blocks: chapter.blockIds.map(id => byId.get(id)!) });
    const metadata = row.draft.metadata as ImportMetadata;
    const [book] = await tx.select({ kind: books.kind }).from(books).where(eq(books.id, bookId));
    const selectedKind = kind ?? metadata.kind ?? (isBookKind(book.kind) ? book.kind : "thought");
    await tx.update(bookVersions).set({ status: "ready", revision: row.revision + 1, draft: { ...row.draft, metadata: { ...metadata, kind: selectedKind } as ImportMetadata }, footnotes: row.draft.footnotes, error: null }).where(eq(bookVersions.id, versionId));
    await tx.update(books).set({ currentVersionId: versionId, status: "ready", error: null, title: metadata.title, author: metadata.author, language: metadata.language, kind: selectedKind, coverAssetId: metadata.coverAssetId ?? null }).where(eq(books.id, bookId));
  });
}

export async function reviseBookVersion(bookId: number, versionId: number, revision: number, chapters: unknown, kind?: BookKind): Promise<number> {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(bookVersions).where(and(eq(bookVersions.id, versionId), eq(bookVersions.bookId, bookId))).for("update");
    if (!row) throw new BookImportError("书籍版本不存在", 404);
    if (row.revision !== revision) throw new BookImportError("目录已更新，请刷新后重试", 409);
    if (!["review", "ready"].includes(row.status) || !row.draft) throw new BookImportError("请先完成导入，再校对目录");
    const validated = validateBookChapters(chapters, row.draft.blocks, versionId);
    const draft: BookImportDraft = { ...row.draft, chapters: validated, metadata: { ...row.draft.metadata, ...(kind ? { kind } : {}) } as ImportMetadata };
    if (row.status === "review") {
      await tx.update(bookVersions).set({ draft, revision: revision + 1 }).where(eq(bookVersions.id, versionId));
      return versionId;
    }
    const [clone] = await tx.insert(bookVersions).values({ bookId, status: "review", sourceHash: row.sourceHash, parserVersion: row.parserVersion, fileName: row.fileName, format: row.format, sourceData: row.sourceData, convertedData: row.convertedData, revision: 0 }).returning();
    await tx.update(bookVersions).set({ draft: remapBookImportDraft(draft, clone.id) }).where(eq(bookVersions.id, clone.id));
    const assets = await tx.select().from(bookAssets).where(eq(bookAssets.versionId, versionId));
    for (const asset of assets) await tx.insert(bookAssets).values({ versionId: clone.id, key: asset.key, mime: asset.mime, data: asset.data, width: asset.width, height: asset.height });
    return clone.id;
  });
}

export async function seedBuiltinBooks() {
  const release = await tryOperationLock("bookBuiltin", lockId(BUILTIN_KEY));
  if (!release) {
    // First listing must wait for the owned seeding operation to publish, rather
    // than exposing a partially seeded title. Bounded wait also handles a crash.
    for (let i = 0; i < 100; i++) {
      const [ready] = await db.select({ id: books.id }).from(books).where(and(eq(books.builtinKey, BUILTIN_KEY), eq(books.status, "ready")));
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new BookImportError("内置书籍正在初始化，请稍后刷新", 503);
  }
  try {
    let [book] = await db.select().from(books).where(eq(books.builtinKey, BUILTIN_KEY));
    // A later user-corrected publication remains the active historical version.
    if (book?.currentVersionId) return;
    const source = await readFile(path.join(process.cwd(), "books", "Selected Dialogues of Plato.epub"));
    if (digest(source) !== BUILTIN_HASH) throw new Error("内置 Plato 文件校验失败");
    if (!book) [book] = await db.insert(books).values({ title: "Selected Dialogues of Plato", author: "Plato", kind: "thought", builtinKey: BUILTIN_KEY }).returning();
    let [version] = await db.select().from(bookVersions).where(and(eq(bookVersions.bookId, book.id), eq(bookVersions.sourceHash, BUILTIN_HASH), eq(bookVersions.parserVersion, BOOK_PARSER_VERSION))).orderBy(desc(bookVersions.id)).limit(1);
    if (!version) [version] = await db.insert(bookVersions).values({ bookId: book.id, sourceHash: BUILTIN_HASH, parserVersion: BOOK_PARSER_VERSION, fileName: "Selected Dialogues of Plato.epub", format: "epub", sourceData: source.toString("base64") }).returning();
    const unlock = await tryOperationLock("bookVersion", version.id);
    if (!unlock) throw new BookImportError("内置书籍正在导入，请稍后刷新", 503);
    try {
      await runBookImport(version.id);
      const [latest] = await db.select({ revision: bookVersions.revision }).from(bookVersions).where(eq(bookVersions.id, version.id));
      await confirmBookVersion(book.id, version.id, latest.revision, "thought");
    } finally { await unlock(); }
  } finally { await release(); }
}

export function validateVersionRequest(body: unknown): { revision: number; chapters?: unknown; kind?: BookKind } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BookImportError("请求内容无效");
  const value = body as Record<string, unknown>;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new BookImportError("目录修订号无效");
  if (value.kind !== undefined && !isBookKind(value.kind)) throw new BookImportError("书籍类型无效");
  return { revision: value.revision as number, chapters: value.chapters, ...(value.kind ? { kind: value.kind as BookKind } : {}) };
}

export function remapBookChapterDraftForVersion(chapters: BookChapterDraft[], blocks: ReaderBlock[], versionId: number) {
  return remapBookImportDraft({ blocks, chapters, processedFiles: [], totalFiles: 0, footnotes: {}, metadata: { title: "", author: "", language: "en" } }, versionId);
}
