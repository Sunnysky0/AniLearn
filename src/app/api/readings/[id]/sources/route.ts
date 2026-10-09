import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readingSources } from "@/db/schema";
import { validId, getReading, decodeReadingSource, MAX_PAPER_PAGES } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id); if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  try {
    const material = await getReading(id); if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
    if (material.row.status !== "uploaded") return Response.json({ error: "已开始识别，请新建材料上传。" }, { status: 409 });
    if (material.sources.length >= MAX_PAPER_PAGES) return Response.json({ error: `最多 ${MAX_PAPER_PAGES} 页` }, { status: 400 });
    const body = await req.json(); const source = decodeReadingSource(body.dataUrl);
    await db.insert(readingSources).values({ readingId: id, idx: material.sources.length, ...source });
    return Response.json({ idx: material.sources.length });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  finally { await release(); }
}
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const sources = await db.select({ idx: readingSources.idx, mime: readingSources.mime }).from(readingSources).where(eq(readingSources.readingId, id));
  return Response.json(sources);
}
