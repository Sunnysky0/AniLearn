import { eq } from "drizzle-orm";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { getReading, hasPageDraft, paragraphsFromPages, validId } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id);
  if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id);
  if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  try {
    const material = await getReading(id);
    if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
    const body = await req.json().catch(() => null);
    if (!body || !Number.isInteger(body.revision) || body.revision !== material.row.revision) return Response.json({ error: "材料已变化，请刷新后重试" }, { status: 409 });
    const total = material.row.expectedPageCount || material.sources.length;
    const complete = material.sources.length === total && material.sources.every((source, index) => source.idx === index && hasPageDraft(material.row.draft, source.idx));
    if (!complete) return Response.json({ error: "仍有来源页未识别，请完成识别后再确认" }, { status: 409 });
    const pages = material.sources.map((source) => material.row.draft[String(source.idx)]);
    const extracted = pages.join("\n\n");
    const revision = material.row.revision + 1;
    const paragraphs = paragraphsFromPages(pages, revision);
    const [row] = await db.update(readings).set({ extracted, paragraphs, revision, status: "ready", error: null })
      .where(eq(readings.id, id)).returning();
    return Response.json({ id: row.id, status: row.status, revision: row.revision, pageCount: material.sources.length, expectedPageCount: row.expectedPageCount });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await release();
  }
}
