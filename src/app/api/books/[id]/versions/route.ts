import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookVersions } from "@/db/books-schema";
import { bookApiError, bookRouteIds } from "@/lib/server/book-api";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { bookId } = bookRouteIds(await ctx.params);
    const versions = await db.select({ id: bookVersions.id, status: bookVersions.status, revision: bookVersions.revision, fileName: bookVersions.fileName, createdAt: bookVersions.createdAt, chapterCount: sql<number>`coalesce(jsonb_array_length(${bookVersions.draft}->'chapters'),0)` }).from(bookVersions).where(eq(bookVersions.bookId, bookId)).orderBy(asc(bookVersions.id));
    return Response.json({ versions });
  } catch (error) { return bookApiError(error); }
}
