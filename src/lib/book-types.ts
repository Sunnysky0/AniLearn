// Shared reader and book contracts; I/O remains in the client/server adapters.
export type ReaderNodeType = "text" | "strong" | "emphasis" | "code" | "link" | "break" | "ruby" | "footnote" | "math";
export interface ReaderNode {
  type: ReaderNodeType;
  text?: string;
  children?: ReaderNode[];
  href?: string;
  target?: string;
  annotation?: string;
  display?: boolean;
}
export interface ReaderBlock {
  id: string;
  kind: "paragraph" | "heading" | "quote" | "list" | "table" | "image" | "pre" | "rule";
  nodes: ReaderNode[];
  anchorText: string;
  level?: number;
  items?: ReaderNode[][];
  rows?: ReaderNode[][][];
  ordered?: boolean;
  assetId?: string;
  alt?: string;
  width?: number;
  height?: number;
  markdown?: string;
  source?: { path?: string; fragment?: string; fragments?: string[]; page?: number };
}
export type BookChapterRole = "front" | "main" | "back";
export interface ReaderUnit {
  id: string; title: string; parentId: string | null; role: BookChapterRole; order: number; blockCount?: number;
}
export interface ReaderResource { id: string; mime: string; url: string; width?: number; height?: number }
export interface ReaderFootnote { id: string; nodes: ReaderNode[]; unitId?: string; blockId?: string }
export interface ReaderDocument {
  key: string; title: string; language: string; unitId: string;
  units: ReaderUnit[]; blocks: ReaderBlock[];
  resources?: ReaderResource[]; footnotes?: Record<string, ReaderFootnote>;
}
export interface ReaderAnchorSegment {
  blockId: string; start: number; end: number; quote: string; prefix: string; suffix: string;
}
export interface ReaderAnchor { version: 2; documentKey: string; unitId: string; segments: ReaderAnchorSegment[] }
export interface ReaderPosition { documentKey: string; unitId: string; blockId: string; offset: number; viewportOffset: number }
export type ReaderSelectionTask = "vocabulary" | "grammar" | "meaning";
export interface ReaderAnnotation { id: number | string; anchor: ReaderAnchor; content: string }
export interface ReaderBookmark {
  id: number; clientId: string; position: ReaderPosition; title: string; excerpt: string;
  revision: number; updatedAt: string;
}
export interface ReaderProps {
  document: ReaderDocument;
  layout?: "scroll" | "paged";
  initialPosition?: ReaderPosition | null;
  entryPosition?: ReaderPosition | null;
  bookmarks?: ReaderBookmark[];
  onBookmarkCreate?: (position: ReaderPosition) => Promise<void>;
  onBookmarkRename?: (bookmark: ReaderBookmark, title: string) => Promise<void>;
  onBookmarkDelete?: (bookmark: ReaderBookmark) => Promise<void>;
  status?: React.ReactNode;
  inspectAnchor?: ReaderAnchor | null;
  annotations?: ReaderAnnotation[];
  onPositionChange?: (position: ReaderPosition) => void;
  onSelectionTask?: (task: ReaderSelectionTask, anchor: ReaderAnchor) => void;
  onQuestion?: (anchor: ReaderAnchor) => void;
  onAnnotation?: (anchor: ReaderAnchor, content: string) => void | Promise<void>;
  onUnitChange?: (unitId: string, inspect?: boolean) => void;
  onInspectionChange?: (inspecting: boolean) => void;
}
export type BookKind = "literary" | "thought" | "classical";
export type BookLanguage = "zh" | "en" | "ja";
export type BookStatus = "uploaded" | "importing" | "review" | "ready" | "failed";
export interface BookChapterDraft extends ReaderUnit { blockIds: string[] }
export interface BookImportDraft {
  blocks: ReaderBlock[]; chapters: BookChapterDraft[];
  footnotes: Record<string, ReaderFootnote>;
  processedFiles: string[]; totalFiles: number;
  metadata: { title: string; author: string; language: BookLanguage; coverAssetId?: string };
}
export interface BookDTO {
  id: number; title: string; author: string; language: BookLanguage; kind: BookKind;
  status: BookStatus; currentVersionId: number | null; builtinKey: string | null;
  coverUrl: string | null; error: string | null; createdAt: string;
}
export interface BookVersionDTO {
  id: number; bookId: number; status: BookStatus; revision: number; sourceHash: string;
  parserVersion: string; fileName: string; format: "epub" | "mobi";
  chapters: BookChapterDraft[]; completedFiles: number; totalFiles: number;
  running: boolean; resumable: boolean; error: string | null;
}
export interface BookChapterDTO extends ReaderUnit { versionId: number; blocks: ReaderBlock[] }
export interface BookMaterialDTO { book: BookDTO; version: BookVersionDTO; chapters: ReaderUnit[] }
export type BookPhase = "free_reading" | "chapter_analysis";
export type BookFocus = "content" | "structure" | "language" | "theme" | "emotion" | "concepts" | "argument" | "implications" | "words" | "meaning" | "ideas";
export interface BookAnalysisDraft {
  status: "idle" | "running" | "ready" | "failed";
  sourceKey: string; totalChunks: number;
  chunks: Record<string, { start: number; end: number; summary: string }>;
  merges: Record<string, string>; context: string; error: string | null;
}
export interface BookChapterLearning {
  phase: BookPhase; stateRevision: number; readingConfirmedAt: string | null;
  currentFocus: BookFocus | null;
  focusStatus: Partial<Record<BookFocus, "not_started" | "in_progress" | "confirmed">>;
  analysisNotes: Partial<Record<BookFocus, string>>;
  summary: string; completedAt: string | null; memory: string;
}
export interface BookChapterStateDTO {
  chapterId: string; learning: BookChapterLearning;
  position: ReaderPosition | null; analysis: BookAnalysisDraft;
}
export interface BookSessionDTO {
  id: number; bookId: number; versionId: number; tutorId: number;
  currentChapterId: string; status: string; summary: string;
  summaryDraft: BookAnalysisDraft | null;
  chapters: BookChapterStateDTO[]; updatedAt: string;
}
export interface BookPersonalNote {
  id: number; versionId: number; chapterId: string | null;
  kind: "annotation" | "chapter" | "book"; clientId: string;
  content: string; anchor: ReaderAnchor | null; revision: number; updatedAt: string;
}
export interface BookMessage {
  id: number; role: "user" | "tutor"; content: string; speech: string;
  chapterId: string; kind: "text" | "quote" | "example" | "exercise" | "feedback";
  language: "zh-CN" | BookLanguage; attachments: string[]; attachmentCount: number;
  phase: BookPhase; focus: BookFocus | null; anchor: ReaderAnchor | null;
}
export interface BookTurnRequest {
  requestId: string; versionId: number; chapterId: string; phase: BookPhase; stateRevision: number;
  focus?: BookFocus | null; anchor?: ReaderAnchor | null; selectionTask?: ReaderSelectionTask;
  text?: string; images?: string[]; intent?: "continue" | "goodbye" | "chapter_summary";
  noteIds?: number[];
}
export type BookTurnEvent =
  | { type: "message"; message: BookMessage }
  | { type: "analysis"; chapter: BookChapterStateDTO }
  | { type: "done"; requestId: string; session: BookSessionDTO; action: "wait"; goodbye?: boolean }
  | { type: "error"; error: string };
export const MAX_BOOK_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_BOOK_EXPANDED_BYTES = 256 * 1024 * 1024;
