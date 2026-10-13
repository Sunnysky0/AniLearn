import { bookApiError, bookRouteIds } from "@/lib/server/book-api";
import { getBookDocument } from "@/lib/server/book-catalog";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; versionId: string; chapterId: string }> }) {
  try {
    const params = await ctx.params;
    const { bookId, versionId } = bookRouteIds(params);
    const document = await getBookDocument(bookId, versionId!, params.chapterId);
    return document ? Response.json(document) : Response.json({ error: "章节不存在" }, { status: 404 });
  } catch (error) { return bookApiError(error); }
}
