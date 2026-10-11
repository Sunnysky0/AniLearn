import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingMessages } from "@/db/schema";
import { validId } from "@/lib/server/readings";
import { parseDataUrl } from "@/lib/server/llm";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; messageId: string; idx: string }> }) {
  const params = await ctx.params;
  const sessionId = validId(params.id);
  const messageId = validId(params.messageId);
  const imageIdx = Number(params.idx);
  if (!sessionId || !messageId || !Number.isInteger(imageIdx) || imageIdx < 0 || imageIdx >= 4) {
    return Response.json({ error: "图片地址无效。" }, { status: 400 });
  }
  const [message] = await db.select({ attachments: readingMessages.attachments })
    .from(readingMessages)
    .where(and(eq(readingMessages.id, messageId), eq(readingMessages.sessionId, sessionId)));
  const dataUrl = message?.attachments?.[imageIdx];
  const parsed = parseDataUrl(dataUrl ?? "");
  if (!parsed || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(parsed.mime)) {
    return Response.json({ error: "图片不存在。" }, { status: 404 });
  }
  return new Response(Buffer.from(parsed.data, "base64"), {
    headers: {
      "Content-Type": parsed.mime,
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
