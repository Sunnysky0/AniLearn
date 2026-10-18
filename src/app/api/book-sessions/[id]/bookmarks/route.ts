import { bookReaderContext, bookReaderResponse, createBookBookmark, getBookBookmarks } from "@/lib/server/book-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => getBookBookmarks(await bookReaderContext((await ctx.params).id)));
}
export async function POST(req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => createBookBookmark(await bookReaderContext((await ctx.params).id), await req.json().catch(() => null)));
}
