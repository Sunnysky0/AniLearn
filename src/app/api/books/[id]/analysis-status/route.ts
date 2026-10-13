import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookVersions } from "@/db/books-schema";
import { bookApiError, bookRouteIds, queryVersionId } from "@/lib/server/book-api";
import { bookVersionActivity } from "@/lib/server/book-catalog";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { bookId } = bookRouteIds(await ctx.params);
    const requested = queryVersionId(req);
    // This projection deliberately excludes sourceData, convertedData and full drafts.
    const [row] = await db.select({ versionId: bookVersions.id, status: bookVersions.status, revision: bookVersions.revision, error: bookVersions.error,
      completedFiles: sql<number>`coalesce(jsonb_array_length(${bookVersions.draft}->'processedFiles'), 0)`,
      totalFiles: sql<number>`coalesce((${bookVersions.draft}->>'totalFiles')::int, 0)`,
    }).from(bookVersions).where(requested ? and(eq(bookVersions.bookId, bookId), eq(bookVersions.id, requested)) : eq(bookVersions.bookId, bookId)).orderBy(desc(bookVersions.id)).limit(1);
    if (!row) return Response.json({ error: "书籍版本不存在" }, { status: 404 });
    const { running } = await bookVersionActivity(row.versionId);
    return Response.json({ ...row, running, resumable: !running && ["uploaded", "importing", "failed"].includes(row.status) });
  } catch (error) { return bookApiError(error); }
}
