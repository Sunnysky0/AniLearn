import { getReadingReaderState, readingReaderContext, readingReaderResponse, saveReadingReaderState } from "@/lib/server/reading-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  return readingReaderResponse(async () => getReadingReaderState(await readingReaderContext((await ctx.params).id)));
}
export async function PATCH(req: Request, ctx: Ctx) {
  return readingReaderResponse(async () => saveReadingReaderState(await readingReaderContext((await ctx.params).id), await req.json().catch(() => null)));
}
