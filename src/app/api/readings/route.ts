import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingSources } from "@/db/schema";
import { readingDTO } from "@/lib/server/readings";
import { MAX_PAPER_TEXT_BYTES } from "@/lib/types";
export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await db.select().from(readings).orderBy(desc(readings.createdAt));
  return Response.json(rows.map((row) => readingDTO(row)));
}
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "材料信息无效" }, { status: 400 });
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (Buffer.byteLength(text, "utf8") > MAX_PAPER_TEXT_BYTES) return Response.json({ error: "原文最多 1.5 MB" }, { status: 413 });
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(readings).values({ title: title || "未命名外刊", language: body.language === "ja" ? "ja" : "en" }).returning();
    if (text) await tx.insert(readingSources).values({ readingId: created.id, idx: 0, mime: "text/plain", data: Buffer.from(text).toString("base64") });
    return created;
  });
  return Response.json(readingDTO(row, text ? 1 : 0));
}
