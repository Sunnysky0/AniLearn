import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { paperPages } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  const paperId = Number(id);
  const pageIndex = Number(n);
  if (!Number.isFinite(paperId) || !Number.isFinite(pageIndex)) {
    return new Response("Bad request", { status: 400 });
  }
  const [page] = await db
    .select()
    .from(paperPages)
    .where(and(eq(paperPages.paperId, paperId), eq(paperPages.pageIndex, pageIndex)));
  if (!page) return new Response("Not found", { status: 404 });
  const bytes = new Uint8Array(Buffer.from(page.data, "base64"));
  return new Response(bytes, {
    headers: {
      "Content-Type": `${page.mime}${page.mime.startsWith("text/") || page.mime === "application/x-tex" ? "; charset=utf-8" : ""}`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
