import { createReadingBookmark, getReadingBookmarks, readingReaderContext, readingReaderResponse } from "@/lib/server/reading-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  return readingReaderResponse(async () => getReadingBookmarks(await readingReaderContext((await ctx.params).id)));
}
export async function POST(req: Request, ctx: Ctx) {
  return readingReaderResponse(async () => createReadingBookmark(await readingReaderContext((await ctx.params).id), await req.json().catch(() => null)));
}
