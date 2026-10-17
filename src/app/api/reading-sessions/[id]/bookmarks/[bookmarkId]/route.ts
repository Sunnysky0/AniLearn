import { changeReadingBookmark, readingReaderContext, readingReaderResponse } from "@/lib/server/reading-reader";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; bookmarkId: string }> };
async function change(req: Request, ctx: Ctx, remove: boolean) {
  return readingReaderResponse(async () => {
    const { id, bookmarkId } = await ctx.params;
    return changeReadingBookmark(await readingReaderContext(id), bookmarkId, await req.json().catch(() => null), remove);
  });
}
export async function PATCH(req: Request, ctx: Ctx) { return change(req, ctx, false); }
export async function DELETE(req: Request, ctx: Ctx) { return change(req, ctx, true); }
