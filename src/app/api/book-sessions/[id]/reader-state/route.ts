import { bookReaderContext, bookReaderResponse, getBookReaderState, saveBookReaderState } from "@/lib/server/book-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => getBookReaderState(await bookReaderContext((await ctx.params).id)));
}
export async function PATCH(req: Request, ctx: Ctx) {
  return bookReaderResponse(async () => saveBookReaderState(await bookReaderContext((await ctx.params).id), await req.json().catch(() => null)));
}
