import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookMessages } from "@/db/books-schema";
import { validBookId } from "@/lib/server/book-catalog";
import { parseDataUrl } from "@/lib/server/llm";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; messageId: string; idx: string }> }) {
  const params = await ctx.params; const id = validBookId(params.id); const messageId = validBookId(params.messageId);
  if (!id || !messageId || !/^\d+$/.test(params.idx) || Number(params.idx) > 3) return Response.json({ error: "图片编号无效。" }, { status: 400 });
  const [row] = await db.select({ images: bookMessages.attachments }).from(bookMessages).where(and(eq(bookMessages.id, messageId), eq(bookMessages.sessionId, id)));
  const image = parseDataUrl(row?.images[Number(params.idx)] ?? "");
  if (!image || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mime)) return Response.json({ error: "图片不存在。" }, { status: 404 });
  return new Response(Buffer.from(image.data, "base64"), { headers: { "Content-Type": image.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
