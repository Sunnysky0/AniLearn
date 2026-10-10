import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSources } from "@/db/schema";
import { readingDTO, readingSummaryDTO } from "@/lib/server/readings";
import { MAX_PAPER_TEXT_BYTES } from "@/lib/types";
export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await db.select({ id: readings.id, title: readings.title, language: readings.language, status: readings.status, overview: readings.overview, error: readings.error, revision: readings.revision, createdAt: readings.createdAt, expectedPageCount: readings.expectedPageCount })
    .from(readings).orderBy(desc(readings.createdAt));
  return Response.json(rows.map((row) => readingSummaryDTO(row)));
}
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "材料信息无效" }, { status: 400 });
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const expectedPageCount = body.expectedPageCount === undefined ? 0 : body.expectedPageCount;
  if (!Number.isInteger(expectedPageCount) || expectedPageCount < 0 || expectedPageCount > 2147483647) return Response.json({ error: "来源页数无效" }, { status: 400 });
  if (text && expectedPageCount > 1) return Response.json({ error: "请将文章原文作为一个来源页上传" }, { status: 400 });
  if (Buffer.byteLength(text, "utf8") > MAX_PAPER_TEXT_BYTES) return Response.json({ error: "原文最多 1.5 MB" }, { status: 413 });
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(readings).values({ title: title || "未命名外刊", language: body.language === "ja" ? "ja" : "en", expectedPageCount }).returning();
    if (text) await tx.insert(readingSources).values({ readingId: created.id, idx: 0, mime: "text/plain", data: Buffer.from(text).toString("base64") });
    return created;
  });
  return Response.json(readingDTO(row, text ? 1 : 0));
}
