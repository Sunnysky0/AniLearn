import { eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { bookVersions } from "@/db/books-schema";
import { MAX_BOOK_UPLOAD_BYTES } from "@/lib/types";
import { bookApiError, readLimitedMultipart } from "@/lib/server/book-api";
import { getBookMaterial, listBooks } from "@/lib/server/book-catalog";
import { BookImportError, createBookUpload, isBookKind, runBookImport } from "@/lib/server/book-import";
import { getMobiCapability } from "@/lib/server/book-mobi";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  try { return Response.json({ books: await listBooks(), mobi: await getMobiCapability() }); }
  catch (error) { return bookApiError(error); }
}

export async function POST(req: Request) {
  let release: (() => Promise<void>) | null = null;
  let handedOff = false;
  try {
    const form = await readLimitedMultipart(req, MAX_BOOK_UPLOAD_BYTES + 1024 * 1024);
    if (["file", "kind", "title", "requestId"].some(key => form.getAll(key).length > 1)) throw new BookImportError("上传字段不能重复");
    const file = form.get("file");
    const kind = form.get("kind");
    const title = form.get("title");
    const requestId = form.get("requestId");
    if (!(file instanceof File) || !file.size) throw new BookImportError("请选择电子书文件");
    if (file.size > MAX_BOOK_UPLOAD_BYTES) throw new BookImportError("电子书不能超过 50 MiB", 413);
    if (!isBookKind(kind) || (title !== null && typeof title !== "string") || (requestId !== null && typeof requestId !== "string")) throw new BookImportError("上传选项无效");
    const upload = await createBookUpload({ data: Buffer.from(await file.arrayBuffer()), fileName: file.name, kind, ...(title ? { title } : {}), ...(requestId ? { requestId } : {}) });
    release = await tryOperationLock("bookVersion", upload.versionId);
    const [version] = await db.select({ status: bookVersions.status }).from(bookVersions).where(eq(bookVersions.id, upload.versionId));
    if (release && !["ready", "review"].includes(version.status)) {
      await db.update(bookVersions).set({ status: "importing", error: null }).where(eq(bookVersions.id, upload.versionId));
      const unlock = release;
      after(async () => { try { await runBookImport(upload.versionId); } catch { /* Saved failure state permits manual resume. */ } finally { await unlock(); } });
      handedOff = true;
    }
    if (release && !handedOff) { await release(); release = null; }
    const material = await getBookMaterial(upload.bookId, upload.versionId);
    return Response.json({ book: material!.book, version: material!.version }, { status: material!.version.status === "ready" || material!.version.status === "review" ? 200 : 202 });
  } catch (error) { return bookApiError(error); }
  finally { if (release && !handedOff) await release(); }
}
