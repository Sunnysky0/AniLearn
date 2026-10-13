import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookAssets, bookVersions } from "@/db/books-schema";
import { bookApiError, bookRouteIds } from "@/lib/server/book-api";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; versionId: string; assetId: string }> }) {
  try {
    const params = await ctx.params;
    const { bookId, versionId } = bookRouteIds(params);
    if (!/^asset-[a-f0-9]{20}$/u.test(params.assetId)) return Response.json({ error: "资源 ID 无效" }, { status: 400 });
    const [asset] = await db.select({ data: bookAssets.data, mime: bookAssets.mime }).from(bookAssets).innerJoin(bookVersions, eq(bookVersions.id, bookAssets.versionId)).where(and(eq(bookVersions.bookId, bookId), eq(bookAssets.versionId, versionId!), eq(bookAssets.key, params.assetId)));
    if (!asset) return Response.json({ error: "资源不存在" }, { status: 404 });
    return new Response(new Uint8Array(Buffer.from(asset.data, "base64")), { headers: { "Content-Type": asset.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'none'" } });
  } catch (error) { return bookApiError(error); }
}
