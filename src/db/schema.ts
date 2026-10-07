import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  BoardBlock,
  KnowledgePoint,
  ProblemProgress,
  SettingsData,
  AnalysisDraft,
  ClassroomSnapshot,
  TeachingCoverage,
} from "../lib/types";
import { DEFAULT_TUTOR_AVATAR } from "../lib/types";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey(),
  data: jsonb("data").$type<Partial<SettingsData>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tutors = pgTable("tutors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull().default(DEFAULT_TUTOR_AVATAR),
  subject: text("subject").notNull().default("数学"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  tagline: text("tagline").notNull().default(""),
  personality: text("personality").notNull().default(""),
  teachingStyle: text("teaching_style").notNull().default(""),
  speakingStyle: text("speaking_style").notNull().default(""),
  voiceId: text("voice_id").notNull().default(""),
  voiceName: text("voice_name").notNull().default(""),
  voiceStyle: text("voice_style").notNull().default(""),
  greeting: text("greeting").notNull().default(""),
  isPreset: boolean("is_preset").notNull().default(false),
  createdAt: createdAt(),
});

export const papers = pgTable("papers", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  subject: text("subject").notNull().default("数学"),
  status: text("status").notNull().default("uploaded"),
  overview: text("overview").notNull().default(""),
  error: text("error"),
  pageCount: integer("page_count").notNull().default(0),
  analysisDraft: jsonb("analysis_draft").$type<AnalysisDraft>(),
  createdAt: createdAt(),
});

export const paperPages = pgTable(
  "paper_pages",
  {
    id: serial("id").primaryKey(),
    paperId: integer("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    mime: text("mime").notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("paper_pages_paper_idx").on(t.paperId, t.pageIndex)],
);

export const problems = pgTable(
  "problems",
  {
    id: serial("id").primaryKey(),
    paperId: integer("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    number: text("number").notNull().default(""),
    type: text("type").notNull().default(""),
    title: text("title").notNull().default(""),
    content: text("content").notNull().default(""),
    answer: text("answer").notNull().default(""),
    solution: text("solution").notNull().default(""),
    keyPoints: jsonb("key_points").$type<string[]>().notNull().default([]),
    knowledgePoints: jsonb("knowledge_points").$type<KnowledgePoint[]>().notNull().default([]),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    difficulty: integer("difficulty").notNull().default(3),
    strategy: text("strategy").notNull().default("direct_teach"),
    strategyReason: text("strategy_reason").notNull().default(""),
    studentWork: text("student_work").notNull().default(""),
    page: integer("page").notNull().default(1),
  },
  (t) => [index("problems_paper_idx").on(t.paperId, t.idx)],
);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  paperId: integer("paper_id")
    .notNull()
    .references(() => papers.id, { onDelete: "cascade" }),
  tutorId: integer("tutor_id")
    .notNull()
    .references(() => tutors.id, { onDelete: "cascade" }),
  currentIdx: integer("current_idx").notNull().default(0),
  status: text("status").notNull().default("active"),
  progress: jsonb("progress").$type<Record<string, ProblemProgress>>().notNull().default({}),
  snapshot: jsonb("snapshot").$type<ClassroomSnapshot>(),
  coverage: jsonb("coverage").$type<Record<string, TeachingCoverage>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    kind: text("kind").notNull().default("text"),
    content: text("content").notNull().default(""),
    speech: text("speech").notNull().default(""),
    problemIdx: integer("problem_idx").notNull().default(0),
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("messages_session_idx").on(t.sessionId, t.id)],
);

export const boards = pgTable(
  "boards",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    problemIdx: integer("problem_idx").notNull(),
    title: text("title").notNull().default(""),
    blocks: jsonb("blocks").$type<BoardBlock[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("boards_session_problem_uq").on(t.sessionId, t.problemIdx)],
);
