import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { freeMessages, freeSessions, freeTopics, freeTurns, tutors } from "@/db/schema";
import type { FreeMessageDTO, FreeSessionDTO, FreeSessionSummaryDTO, FreeTopicDTO } from "@/lib/types";

export type FreeSessionRow = typeof freeSessions.$inferSelect;
export type FreeTopicRow = typeof freeTopics.$inferSelect;
export type FreeTurnRow = typeof freeTurns.$inferSelect;
export type FreeMessageRow = typeof freeMessages.$inferSelect;

export function validFreeId(value: string | number): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

export const toFreeSessionDTO = (row: FreeSessionRow): FreeSessionDTO => ({
  id: row.id, tutorId: row.tutorId, title: row.title, currentTopicId: row.currentTopicId,
  welcomeRequestId: row.welcomeRequestId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});

export const toFreeTopicDTO = (row: FreeTopicRow): FreeTopicDTO => ({
  id: row.id, sessionId: row.sessionId, idx: row.idx, title: row.title, blocks: row.blocks ?? [],
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});

export const toFreeMessageDTO = (row: Omit<FreeMessageRow, "attachments"> & { attachments?: string[]; attachmentCount?: number }): FreeMessageDTO => ({
  id: row.id, sessionId: row.sessionId, turnId: row.turnId, topicId: row.topicId,
  role: row.role as FreeMessageDTO["role"], kind: row.kind as FreeMessageDTO["kind"],
  language: row.language as FreeMessageDTO["language"], content: row.content, speech: row.speech,
  boardMode: row.boardMode as FreeMessageDTO["boardMode"],
  attachments: Array.from({ length: row.attachmentCount ?? row.attachments?.length ?? 0 }, (_, i) =>
    `/api/free-sessions/${row.sessionId}/messages/${row.id}/attachments/${i}`),
  attachmentCount: row.attachmentCount ?? row.attachments?.length ?? 0, createdAt: row.createdAt.toISOString(),
});

export async function loadFreeSession(id: number) {
  const [session] = await db.select().from(freeSessions).where(eq(freeSessions.id, id));
  if (!session) return null;
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, session.tutorId));
  if (!tutor) return null;
  const topics = await db.select().from(freeTopics).where(eq(freeTopics.sessionId, id)).orderBy(asc(freeTopics.idx));
  const page = await db.select({
    id: freeMessages.id, sessionId: freeMessages.sessionId, turnId: freeMessages.turnId, topicId: freeMessages.topicId,
    role: freeMessages.role, kind: freeMessages.kind, language: freeMessages.language, content: freeMessages.content,
    speech: freeMessages.speech, boardMode: freeMessages.boardMode, createdAt: freeMessages.createdAt,
    attachmentCount: sql<number>`jsonb_array_length(${freeMessages.attachments})::int`,
  }).from(freeMessages).where(eq(freeMessages.sessionId, id)).orderBy(desc(freeMessages.id)).limit(51);
  const messages = await withRecentAttachments(page.slice(0, 50).reverse());
  return { session, tutor, topics, messages, hasMoreMessages: page.length > 50, oldestMessageId: messages[0]?.id ?? null };
}

export async function withRecentAttachments<T extends { id: number; role: string; topicId?: number | null; attachmentCount?: number; attachments?: string[] }>(rows: T[], priorityTopicId?: number | null): Promise<(T & { attachments: string[] })[]> {
  const candidates = rows.filter((message) => message.role === "user" && (message.attachmentCount ?? message.attachments?.length ?? 0) > 0);
  const preferred = priorityTopicId == null ? [] : candidates.filter((message) => message.topicId === priorityTopicId).slice(-2);
  const preferredIds = new Set(preferred.map((message) => message.id));
  const remaining = 2 - preferred.length;
  const otherRecent = remaining > 0 ? candidates.filter((message) => !preferredIds.has(message.id)).slice(-remaining) : [];
  const ids = [...preferred, ...otherRecent].map((message) => message.id);
  if (!ids.length) return rows.map((message) => ({ ...message, attachments: [] }));
  const images = await db.select({ id: freeMessages.id, attachments: freeMessages.attachments }).from(freeMessages).where(inArray(freeMessages.id, ids));
  const byId = new Map(images.map((message) => [message.id, message.attachments ?? []]));
  return rows.map((message) => ({ ...message, attachments: byId.get(message.id) ?? message.attachments ?? [] }));
}

export async function listFreeSessions(limit = 20, before?: { updatedAt: Date; id: number }) {
  const page = await db.select({
    session: freeSessions,
    tutor: { id: tutors.id, name: tutors.name, avatar: tutors.avatar },
    topicCount: sql<number>`count(${freeTopics.id})::int`,
    currentTopicTitle: sql<string>`coalesce(max(case when ${freeTopics.id} = ${freeSessions.currentTopicId} then ${freeTopics.title} end), '')`,
  }).from(freeSessions)
    .innerJoin(tutors, eq(tutors.id, freeSessions.tutorId))
    .leftJoin(freeTopics, eq(freeTopics.sessionId, freeSessions.id))
    .where(before ? or(lt(freeSessions.updatedAt, before.updatedAt), and(eq(freeSessions.updatedAt, before.updatedAt), lt(freeSessions.id, before.id))) : undefined)
    .groupBy(freeSessions.id, tutors.id)
    .orderBy(desc(freeSessions.updatedAt), desc(freeSessions.id))
    .limit(limit + 1);
  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  const sessions: FreeSessionSummaryDTO[] = rows.map((row) => ({
    session: {
      id: row.session.id, tutorId: row.session.tutorId, title: row.session.title,
      currentTopicId: row.session.currentTopicId, createdAt: row.session.createdAt.toISOString(),
      updatedAt: row.session.updatedAt.toISOString(),
    },
    tutor: row.tutor, topicCount: row.topicCount, currentTopicTitle: row.currentTopicTitle,
  }));
  const last = rows.at(-1);
  return { sessions, hasMore, nextCursor: hasMore && last ? `${last.session.updatedAt.toISOString()}|${last.session.id}` : null };
}
