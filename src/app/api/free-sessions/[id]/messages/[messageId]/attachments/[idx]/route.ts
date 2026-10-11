import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { freeMessages } from "@/db/schema";
import { validFreeId } from "@/lib/server/free-data";
import { parseDataUrl } from "@/lib/server/llm";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; messageId: string; idx: string }> }) {
  const params = await ctx.params;
  const sessionId = validFreeId(params.id), messageId = validFreeId(params.messageId), idx = Number(params.idx);
  if (!sessionId || !messageId || !Number.isSafeInteger(idx) || idx < 0 || idx > 3) return Response.json({ error: "图片编号无效。" }, { status: 400 });
  const [row] = await db.select({ attachments: freeMessages.attachments }).from(freeMessages).where(and(eq(freeMessages.id, messageId), eq(freeMessages.sessionId, sessionId)));
  const dataUrl = row?.attachments?.[idx];
  const parsed = dataUrl && parseDataUrl(dataUrl);
  if (!parsed) return Response.json({ error: "图片不存在。" }, { status: 404 });
  return new Response(Buffer.from(parsed.data, "base64"), { headers: {
    "Content-Type": parsed.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
  } });
}
