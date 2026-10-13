import { eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { bookVersions } from "@/db/books-schema";
import { bookApiError, bookRouteIds } from "@/lib/server/book-api";
import { getBookVersion, validBookId } from "@/lib/server/book-catalog";
import { BookImportError, runBookImport } from "@/lib/server/book-import";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let release: (() => Promise<void>) | null = null;
  let handedOff = false;
  try {
    const { bookId } = bookRouteIds(await ctx.params);
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body) || (body.resume !== undefined && typeof body.resume !== "boolean") || (body.versionId !== undefined && !validBookId(body.versionId))) throw new BookImportError("导入选项无效");
    const version = await getBookVersion(bookId, body.versionId);
    if (!version) throw new BookImportError("书籍版本不存在", 404);
    release = await tryOperationLock("bookVersion", version.id);
    if (!release) throw new BookImportError("书籍正在导入，请稍后重试", 409);
    if (["ready", "review"].includes(version.status)) return Response.json({ status: version.status, versionId: version.id });
    await db.update(bookVersions).set({ status: "importing", error: null }).where(eq(bookVersions.id, version.id));
    const unlock = release;
    after(async () => { try { await runBookImport(version.id); } catch { /* Saved draft permits resume after failure/restart. */ } finally { await unlock(); } });
    handedOff = true;
    return Response.json({ status: "importing", versionId: version.id }, { status: 202 });
  } catch (error) { return bookApiError(error); }
  finally { if (release && !handedOff) await release(); }
}
