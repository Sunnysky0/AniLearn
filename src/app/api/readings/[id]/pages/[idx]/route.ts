import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readingSources, readings } from "@/db/schema";
import { getReadingDraftKeys, validId } from "@/lib/server/readings";
import { tryOperationLock } from "@/lib/server/locks";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; idx: string }> };

function pageIndex(value: string) {
  const idx = Number(value);
  return Number.isInteger(idx) && idx >= 0 && idx < 2147483647 ? idx : null;
}

export async function GET(_req: Request, ctx: Context) {
  const params = await ctx.params;
  const id = validId(params.id);
  const idx = pageIndex(params.idx);
  if (!id || idx === null) return Response.json({ error: "来源页无效" }, { status: 400 });
  const [source] = await db.select({ mime: readingSources.mime }).from(readingSources)
    .where(and(eq(readingSources.readingId, id), eq(readingSources.idx, idx)));
  if (!source) return Response.json({ error: "来源页不存在" }, { status: 404 });
  const [row] = await db.select({ expectedPageCount: readings.expectedPageCount, revision: readings.revision, status: readings.status,
    recognized: sql<boolean>`${readings.draft} ? ${String(idx)}`, text: sql<string | null>`${readings.draft} ->> ${String(idx)}` })
    .from(readings).where(eq(readings.id, id));
  if (!row) return Response.json({ error: "材料不存在" }, { status: 404 });
  return Response.json({
    idx,
    total: row.expectedPageCount,
    mime: source.mime,
    recognized: row.recognized,
    blank: row.recognized && row.text === "",
    text: row.text ?? "",
    revision: row.revision,
    status: row.status,
  });
}

export async function PATCH(req: Request, ctx: Context) {
  const params = await ctx.params;
  const id = validId(params.id);
  const idx = pageIndex(params.idx);
  if (!id || idx === null) return Response.json({ error: "来源页无效" }, { status: 400 });
  const release = await tryOperationLock("reading", id);
  if (!release) return Response.json({ error: "材料正在处理" }, { status: 409 });
  try {
    const [row] = await db.select({ revision: readings.revision, status: readings.status, expectedPageCount: readings.expectedPageCount })
      .from(readings).where(eq(readings.id, id));
    if (!row) return Response.json({ error: "材料不存在" }, { status: 404 });
    const [source] = await db.select({ idx: readingSources.idx }).from(readingSources)
      .where(and(eq(readingSources.readingId, id), eq(readingSources.idx, idx)));
    if (!source) return Response.json({ error: "来源页不存在" }, { status: 404 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.text !== "string") return Response.json({ error: "校对原文无效" }, { status: 400 });
    if (!Number.isInteger(body.revision) || body.revision !== row.revision) return Response.json({ error: "材料已变化，请刷新后重试" }, { status: 409 });
    const sources = await db.select({ idx: readingSources.idx }).from(readingSources).where(eq(readingSources.readingId, id));
    const draftKeys = await getReadingDraftKeys(id);
    draftKeys.add(String(idx));
    const total = row.expectedPageCount || sources.length;
    const allReviewed = sources.length === total && sources.every((item) => item.idx < total && draftKeys.has(String(item.idx)));
    const status = allReviewed || row.status === "ready" ? "review" : row.status;
    const [updated] = await db.update(readings).set({ draft: sql`jsonb_set(${readings.draft}, ARRAY[${String(idx)}], to_jsonb(${body.text}::text), true)`, status, error: null, revision: row.revision + 1 })
      .where(eq(readings.id, id)).returning({ revision: readings.revision, status: readings.status });
    return Response.json({ idx, recognized: true, blank: body.text.trim() === "", text: body.text, revision: updated.revision, status: updated.status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await release();
  }
}
