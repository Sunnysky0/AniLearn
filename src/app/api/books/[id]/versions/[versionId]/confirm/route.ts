import { bookApiError, bookRouteIds } from "@/lib/server/book-api";
import { getBookMaterial } from "@/lib/server/book-catalog";
import { BookImportError, confirmBookVersion, validateVersionRequest } from "@/lib/server/book-import";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  let release: (() => Promise<void>) | null = null;
  try {
    const { bookId, versionId } = bookRouteIds(await ctx.params);
    const body = validateVersionRequest(await req.json().catch(() => null));
    release = await tryOperationLock("bookVersion", versionId!);
    if (!release) throw new BookImportError("书籍正在导入或校对", 409);
    await confirmBookVersion(bookId, versionId!, body.revision, body.kind);
    await release(); release = null;
    return Response.json(await getBookMaterial(bookId, versionId!));
  } catch (error) { return bookApiError(error, 400); }
  finally { if (release) await release(); }
}
