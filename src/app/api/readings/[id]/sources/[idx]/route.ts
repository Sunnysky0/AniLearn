import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readingSources } from "@/db/schema";
import { validId } from "@/lib/server/readings";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; idx: string }> }) {
  const params = await ctx.params; const id = validId(params.id); const idx = Number(params.idx);
  if (!id || !Number.isInteger(idx) || idx < 0) return Response.json({ error: "来源页无效" }, { status: 400 });
  const [source] = await db.select().from(readingSources).where(and(eq(readingSources.readingId, id), eq(readingSources.idx, idx)));
  if (!source) return Response.json({ error: "来源页不存在" }, { status: 404 });
  return new Response(Buffer.from(source.data, "base64"), { headers: { "Content-Type": source.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
