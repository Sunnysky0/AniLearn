import { eq, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { validId, getReadingSummary } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
import { runReadingAnalysis } from "@/lib/server/reading-analysis";
import type { ReadingAnalysisEvent } from "@/lib/types";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validId((await ctx.params).id);
  if (!id) return Response.json({ error: "材料 ID 无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id);
  if (!release) return Response.json({ error: "材料正在识别" }, { status: 409 });
  let handedOff = false;
  try {
    const material = await getReadingSummary(id);
    if (!material) return Response.json({ error: "材料不存在" }, { status: 404 });
    const expected = material.row.expectedPageCount || material.sources.length;
    if (!expected || material.sources.length !== expected || material.sources.some((source, index) => source.idx !== index)) {
      return Response.json({ error: "请先上传全部来源页" }, { status: 400 });
    }
    const body = await req.json().catch(() => ({}));
    if (body?.restart !== undefined && typeof body.restart !== "boolean") return Response.json({ error: "识别选项无效" }, { status: 400 });
    if (body?.background !== undefined && typeof body.background !== "boolean") return Response.json({ error: "后台选项无效" }, { status: 400 });
    await db.update(readings).set({
      ...(body.restart ? { draft: {}, revision: sql`${readings.revision} + 1` } : {}),
      ...(body.background && material.row.expectedPageCount === 0 ? { expectedPageCount: expected } : {}),
      status: "analyzing", error: null,
    }).where(eq(readings.id, id));

    if (body.background) {
      after(async () => {
        try { await runReadingAnalysis(id); }
        catch { /* The saved failure state and draft are shown in the article review page. */ }
        finally { await release(); }
      });
      handedOff = true;
      return Response.json({ status: "analyzing", totalPages: expected, expectedPageCount: expected }, { status: 202 });
    }

    const stream = new ReadableStream({ async start(controller) {
      const send = (event: ReadingAnalysisEvent) => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); } catch { /* detached observer */ } };
      try {
        const reading = await runReadingAnalysis(id, ({ done, total, page }) => send({ type: "progress", done, total, page }));
        send({ type: "done", reading });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        await release();
        try { controller.close(); } catch { /* disconnected */ }
      }
    } });
    handedOff = true;
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    if (!handedOff) await release();
  }
}
