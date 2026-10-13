import { bookApiError, bookRouteIds, queryVersionId } from "@/lib/server/book-api";
import { getBookMaterial } from "@/lib/server/book-catalog";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { bookId } = bookRouteIds(await ctx.params);
    const material = await getBookMaterial(bookId, queryVersionId(req));
    return material ? Response.json(material) : Response.json({ error: "书籍或版本不存在" }, { status: 404 });
  } catch (error) { return bookApiError(error); }
}
