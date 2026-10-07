import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { paperPages, papers } from "@/db/schema";
import { parseDataUrl } from "@/lib/server/llm";
import { tryOperationLock } from "@/lib/server/locks";
import { MAX_PAPER_PAGES } from "@/lib/types";
import { decodePaperText, paperTextFormat } from "@/lib/paper-source";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const paperId = Number((await ctx.params).id);
  if (!Number.isInteger(paperId) || paperId <= 0 || paperId > 2147483647) return Response.json({ error: "无效的试卷 ID" }, { status: 400 });
  const release = await tryOperationLock("paper", paperId);
  if (!release) return Response.json({ error: "试卷正在处理，请稍候再上传。" }, { status: 409 });
  try {
  const [paper] = await db.select().from(papers).where(eq(papers.id, paperId));
  if (!paper) return Response.json({ error: "试卷不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { dataUrl?: string };
  const parsed = parseDataUrl(typeof body?.dataUrl === "string" ? body.dataUrl : "");
  const isImage = !!parsed && /^image\/(jpeg|png|webp|gif)$/.test(parsed.mime);
  const isText = !!parsed && !!paperTextFormat(parsed.mime);
  if (!parsed || (!isImage && !isText)) {
    return Response.json({ error: "仅支持 JPG / PNG / WEBP 图片或 Markdown / LaTeX 文本" }, { status: 400 });
  }
  if (parsed.data.length > (isText ? 2_000_000 : 12_000_000)) return Response.json({ error: isText ? "文本文件过大，单个文件最多 1.5 MB。" : "图片过大" }, { status: 413 });
  if (isText) {
    if (parsed.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data)) {
      return Response.json({ error: "文本文件数据无效。" }, { status: 400 });
    }
    try { decodePaperText(Buffer.from(parsed.data, "base64")); }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paperPages)
    .where(eq(paperPages.paperId, paperId));
  const pageIndex = Number(count);
  if (pageIndex >= MAX_PAPER_PAGES) return Response.json({ error: `单份试卷最多 ${MAX_PAPER_PAGES} 页，请拆分上传。` }, { status: 400 });
  if (paper.status === "ready" || paper.analysisDraft) return Response.json({ error: "试卷已开始解析，请另建试卷上传新页面。" }, { status: 409 });
  await db.transaction(async (tx) => {
    await tx.insert(paperPages).values({ paperId, pageIndex, mime: parsed.mime, data: parsed.data });
    await tx.update(papers).set({ pageCount: pageIndex + 1 }).where(eq(papers.id, paperId));
  });
  return Response.json({ pageIndex });
  } finally { await release(); }
}
