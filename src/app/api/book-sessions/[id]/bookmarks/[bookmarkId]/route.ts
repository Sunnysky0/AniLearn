import { bookReaderContext, bookReaderResponse, changeBookBookmark } from "@/lib/server/book-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; bookmarkId: string }> };
export async function PATCH(req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => { const params = await ctx.params; return changeBookBookmark(await bookReaderContext(params.id), params.bookmarkId, await req.json().catch(() => null)); });
}
export async function DELETE(req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => { const params = await ctx.params; return changeBookBookmark(await bookReaderContext(params.id), params.bookmarkId, await req.json().catch(() => null), true); });
}
