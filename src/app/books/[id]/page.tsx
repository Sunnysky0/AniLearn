import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { AppHeader } from "@/components/AppHeader";
import BookMaterialView from "@/components/books/BookMaterialView";
import { db } from "@/db";
import { bookSessions, bookVersions } from "@/db/schema";
import { ensureBuiltinBooks, getBookMaterial } from "@/lib/server/book-catalog";
import { listTutors } from "@/lib/server/data";
import { validId } from "@/lib/server/readings";
export const dynamic = "force-dynamic";
export default async function BookPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ versionId?: string }> }) {
  await ensureBuiltinBooks(); const id = validId((await params).id);
  const requestedVersion = (await searchParams).versionId;
  const versionId = requestedVersion === undefined ? undefined : validId(requestedVersion);
  if (requestedVersion !== undefined && !versionId) notFound();
  const material = id && await getBookMaterial(id, versionId ?? undefined); if (!material) notFound();
  const sessions = await db.select({ id: bookSessions.id, tutorId: bookSessions.tutorId, versionId: bookSessions.versionId, status: bookSessions.status, updatedAt: bookSessions.updatedAt }).from(bookSessions).where(eq(bookSessions.bookId, material.book.id)).orderBy(desc(bookSessions.updatedAt));
  const versions = await db.select({ id: bookVersions.id, status: bookVersions.status, createdAt: bookVersions.createdAt }).from(bookVersions).where(eq(bookVersions.bookId, material.book.id)).orderBy(desc(bookVersions.id));
  return <div><AppHeader /><BookMaterialView key={material.version.id} initial={material} tutors={await listTutors()} classrooms={sessions.map(s => ({ ...s, updatedAt: s.updatedAt.toISOString() }))} versions={versions.map(version => ({ ...version, createdAt: version.createdAt.toISOString() }))} /></div>;
}
