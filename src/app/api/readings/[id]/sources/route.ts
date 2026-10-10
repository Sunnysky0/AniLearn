import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { readingSources, readings } from "@/db/schema";
import { validId, getReadingSummary, decodeReadingSource } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
import { runReadingAnalysis } from "@/lib/server/reading-analysis";
export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id); if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  let handedOff = false;
  try {
    const material = await getReadingSummary(id); if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
    const body = await req.json();
    const idx = body.idx === undefined ? material.sources.length : Number(body.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= 2147483647 || (material.row.expectedPageCount > 0 && idx >= material.row.expectedPageCount)) return Response.json({ error: "来源页编号无效" }, { status: 400 });
    const source = decodeReadingSource(body.dataUrl);
    const existingAtIndex = material.sources.find((item) => item.idx === idx);
    if (existingAtIndex) {
      const [sameIndex] = await db.select({ mime: readingSources.mime, data: readingSources.data }).from(readingSources)
        .where(and(eq(readingSources.readingId, id), eq(readingSources.idx, idx)));
      const same = sameIndex?.mime === source.mime && sameIndex.data === source.data;
      if (!same) return Response.json({ error: `第 ${idx + 1} 页已存在且内容不同，无法覆盖` }, { status: 409 });
    } else {
      if (material.row.status !== "uploaded") return Response.json({ error: "已开始识别，不能再添加来源页。" }, { status: 409 });
      if (idx !== material.sources.length) return Response.json({ error: "来源页请按顺序上传；已上传内容可安全重试。" }, { status: 409 });
      await db.insert(readingSources).values({ readingId: id, idx, ...source });
    }
    const expected = material.row.expectedPageCount;
    if (expected > 0 && idx + 1 === expected && material.row.status === "uploaded") {
      await db.update(readings).set({ status: "analyzing", error: null }).where(eq(readings.id, id));
      try {
        after(async () => {
          try { await runReadingAnalysis(id); }
          catch { /* The saved failure state and draft are shown in the article review page. */ }
          finally { await release(); }
        });
        handedOff = true;
        return Response.json({ idx, analyzing: true }, { status: 202 });
      } catch (error) {
        await db.update(readings).set({ status: "failed", error: error instanceof Error ? error.message : String(error) }).where(eq(readings.id, id));
      }
    }
    return Response.json({ idx, ...(existingAtIndex ? { alreadyPresent: true } : {}) });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  finally { if (!handedOff) await release(); }
}
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id); if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const sources = await db.select({ idx: readingSources.idx, mime: readingSources.mime }).from(readingSources).where(eq(readingSources.readingId, id));
  return Response.json(sources);
}
