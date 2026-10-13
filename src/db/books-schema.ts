import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { BookAnalysisDraft, BookChapterLearning, BookImportDraft, ReaderAnchor, ReaderBlock, ReaderFootnote, ReaderPosition } from "@/lib/types";
import { tutors } from "./schema";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const books = pgTable("books", {
  id: serial("id").primaryKey(), title: text("title").notNull(), author: text("author").notNull().default(""),
  language: text("language").notNull().default("en"), kind: text("kind").notNull().default("thought"),
  status: text("status").notNull().default("uploaded"), currentVersionId: integer("current_version_id"),
  builtinKey: text("builtin_key"), coverAssetId: text("cover_asset_id"), error: text("error"), createdAt: createdAt(),
}, t => [uniqueIndex("books_builtin_key_uq").on(t.builtinKey)]);
export const bookVersions = pgTable("book_versions", {
  id: serial("id").primaryKey(), bookId: integer("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("uploaded"), revision: integer("revision").notNull().default(0),
  sourceHash: text("source_hash").notNull(), parserVersion: text("parser_version").notNull(),
  fileName: text("file_name").notNull(), format: text("format").notNull(), sourceData: text("source_data").notNull(),
  convertedData: text("converted_data"), draft: jsonb("draft").$type<BookImportDraft>(),
  footnotes: jsonb("footnotes").$type<Record<string, ReaderFootnote>>().notNull().default({}),
  error: text("error"), createdAt: createdAt(),
});
export const bookChapters = pgTable("book_chapters", {
  id: text("id").primaryKey(), versionId: integer("version_id").notNull().references(() => bookVersions.id, { onDelete: "cascade" }),
  title: text("title").notNull(), parentId: text("parent_id"), role: text("role").notNull().default("main"),
  order: integer("sort_order").notNull(), blocks: jsonb("blocks").$type<ReaderBlock[]>().notNull().default([]),
}, t => [index("book_chapters_version_order").on(t.versionId, t.order)]);
export const bookAssets = pgTable("book_assets", {
  id: serial("id").primaryKey(), versionId: integer("version_id").notNull().references(() => bookVersions.id, { onDelete: "cascade" }),
  key: text("asset_key").notNull(), mime: text("mime").notNull(), data: text("data").notNull(), width: integer("width"), height: integer("height"),
}, t => [uniqueIndex("book_assets_version_key_uq").on(t.versionId, t.key)]);
export const bookSessions = pgTable("book_sessions", {
  id: serial("id").primaryKey(), bookId: integer("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  versionId: integer("version_id").notNull().references(() => bookVersions.id),
  tutorId: integer("tutor_id").notNull().references(() => tutors.id), currentChapterId: text("current_chapter_id").notNull(),
  status: text("status").notNull().default("active"), summary: text("summary").notNull().default(""),
  summaryDraft: jsonb("summary_draft").$type<BookAnalysisDraft>(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const bookChapterStates = pgTable("book_chapter_states", {
  id: serial("id").primaryKey(), sessionId: integer("session_id").notNull().references(() => bookSessions.id, { onDelete: "cascade" }),
  chapterId: text("chapter_id").notNull().references(() => bookChapters.id),
  learning: jsonb("learning").$type<BookChapterLearning>().notNull(), position: jsonb("position").$type<ReaderPosition>(),
  analysisDraft: jsonb("analysis_draft").$type<BookAnalysisDraft>(),
}, t => [uniqueIndex("book_chapter_states_session_chapter_uq").on(t.sessionId, t.chapterId)]);
export const bookTurns = pgTable("book_turns", {
  id: serial("id").primaryKey(), sessionId: integer("session_id").notNull().references(() => bookSessions.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), inputHash: text("input_hash").notNull(), chapterId: text("chapter_id").notNull(),
  phase: text("phase").notNull(), focus: text("focus"), intent: text("intent"), status: text("status").notNull().default("running"),
  action: text("action"), createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex("book_turns_session_request_uq").on(t.sessionId, t.requestId)]);
export const bookMessages = pgTable("book_messages", {
  id: serial("id").primaryKey(), sessionId: integer("session_id").notNull().references(() => bookSessions.id, { onDelete: "cascade" }),
  turnId: integer("turn_id").references(() => bookTurns.id, { onDelete: "cascade" }), chapterId: text("chapter_id").notNull(),
  role: text("role").notNull(), kind: text("kind").notNull().default("text"), language: text("language").notNull().default("zh-CN"),
  content: text("content").notNull(), speech: text("speech").notNull().default(""),
  attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
  phase: text("phase").notNull().default("free_reading"), focus: text("focus"), anchor: jsonb("anchor").$type<ReaderAnchor>(), createdAt: createdAt(),
}, t => [index("book_messages_session_idx").on(t.sessionId, t.id)]);
export const bookPersonalNotes = pgTable("book_personal_notes", {
  id: serial("id").primaryKey(), versionId: integer("version_id").notNull().references(() => bookVersions.id, { onDelete: "cascade" }),
  chapterId: text("chapter_id"), kind: text("kind").notNull(), clientId: text("client_id").notNull(), content: text("content").notNull(),
  anchor: jsonb("anchor").$type<ReaderAnchor>(), revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex("book_personal_notes_version_client_uq").on(t.versionId, t.clientId)]);
