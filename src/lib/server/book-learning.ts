import { createHash } from "node:crypto";
import type { BookAnalysisDraft, BookChapterLearning, BookFocus, BookKind, BookMessage, BookTurnRequest, ReaderDocument, ReaderPosition, ReaderUnit } from "@/lib/types";
import { blockText } from "@/lib/reader/anchors";

export const BOOK_FOCUS_LABELS: Record<BookFocus, string> = {
  content: "情节与人物", structure: "叙事结构", language: "语言手法", theme: "主题", emotion: "情感表达",
  concepts: "核心概念", argument: "论证过程", implications: "思想推演",
  words: "字词与句读", meaning: "句意与典故", ideas: "篇章义理",
};
export function bookFoci(kind: BookKind): BookFocus[] {
  return kind === "literary" ? ["content", "structure", "language", "theme", "emotion"]
    : kind === "classical" ? ["words", "meaning", "ideas"] : ["concepts", "argument", "implications"];
}
export function initialBookLearning(kind: BookKind): BookChapterLearning {
  return { phase: "free_reading", stateRevision: 0, readingConfirmedAt: null, currentFocus: null,
    focusStatus: Object.fromEntries(bookFoci(kind).map(focus => [focus, "not_started"])),
    analysisNotes: {}, summary: "", completedAt: null, memory: "" };
}
export function initialBookAnalysis(sourceKey: string): BookAnalysisDraft {
  return { status: "idle", sourceKey, totalChunks: 0, chunks: {}, merges: {}, context: "", error: null };
}
export function changeBookLearning(state: BookChapterLearning, kind: BookKind, action: string, focus?: unknown, now = new Date().toISOString()): BookChapterLearning {
  const next = structuredClone(state); const foci = bookFoci(kind);
  if (action === "confirm_reading") { next.readingConfirmedAt ??= now; }
  else if (action === "start_analysis") {
    next.readingConfirmedAt ??= now; next.phase = "chapter_analysis";
    next.currentFocus = foci.find(candidate => next.focusStatus[candidate] !== "confirmed") ?? null;
    if (next.currentFocus) next.focusStatus[next.currentFocus] = "in_progress";
  } else if (action === "return_to_reading") { next.phase = "free_reading"; }
  else if (action === "set_focus") {
    if (next.phase !== "chapter_analysis" || !foci.includes(focus as BookFocus)) throw new Error("当前导读角度无效。");
    next.currentFocus = focus as BookFocus;
    if (next.focusStatus[next.currentFocus] !== "confirmed") next.focusStatus[next.currentFocus] = "in_progress";
  } else if (action === "confirm_focus") {
    const current = next.currentFocus;
    if (next.phase !== "chapter_analysis" || !current || !next.analysisNotes[current]?.trim()) throw new Error("请先讨论当前角度，再确认理解。");
    next.focusStatus[current] = "confirmed";
    next.currentFocus = foci.find(candidate => next.focusStatus[candidate] !== "confirmed") ?? null;
    if (next.currentFocus) next.focusStatus[next.currentFocus] = "in_progress";
  } else if (action === "complete_analysis") {
    if (next.phase !== "chapter_analysis" || !foci.every(candidate => next.focusStatus[candidate] === "confirmed") || !next.summary.trim()) throw new Error("请先确认所有角度并生成本章总结。");
    next.completedAt ??= now;
  } else throw new Error("课堂操作无效。");
  next.stateRevision++; return next;
}
export function bookTurnHash(request: BookTurnRequest, text: string, images: string[]) {
  return createHash("sha256").update(JSON.stringify({ versionId: request.versionId, chapterId: request.chapterId,
    phase: request.phase, stateRevision: request.stateRevision, focus: request.focus ?? null,
    anchor: request.anchor ?? null, selectionTask: request.selectionTask ?? null,
    intent: request.intent ?? null, noteIds: request.noteIds ?? [], text, images })).digest("hex");
}
export function allowsBookSummary(units: ReaderUnit[], states: { chapterId: string; learning: BookChapterLearning }[]) {
  const main = units.filter(unit => unit.role === "main" && (unit.blockCount ?? 1) > 0);
  return main.length > 0 && main.every(unit => states.some(state => state.chapterId === unit.id && !!state.learning.readingConfirmedAt));
}
export function allowedPreviousMemories(units: ReaderUnit[], currentId: string, states: { chapterId: string; learning: BookChapterLearning; analysis?: BookAnalysisDraft }[]) {
  const current = units.find(unit => unit.id === currentId); if (!current) return [];
  return units.filter(unit => unit.order < current.order).flatMap(unit => {
    const state = states.find(candidate => candidate.chapterId === unit.id);
    if (!state?.learning.readingConfirmedAt) return [];
    const text = state.learning.memory || state.learning.summary || state.analysis?.context || "";
    return text ? [{ chapterId: unit.id, title: unit.title, text }] : [];
  });
}
export function bookQuestionEvidence(document: ReaderDocument, request: BookTurnRequest, position?: ReaderPosition | null): string {
  if (request.anchor) return request.anchor.segments.map(segment => {
    const block = document.blocks.find(candidate => candidate.id === segment.blockId);
    if (!block) return "";
    const text = blockText(block);
    return `[正文块 ${block.id}]\n${text.slice(Math.max(0, segment.start - 500), Math.min(text.length, segment.end + 500))}`;
  }).join("\n\n");
  // A free question uses only the reading location and its neighbours.
  const located = position?.unitId === document.unitId && position.documentKey === document.key ? document.blocks.findIndex(block => block.id === position.blockId) : -1;
  const current = located >= 0 ? located : Math.max(0, document.blocks.findIndex(block => blockText(block).trim()));
  return document.blocks.slice(Math.max(0, current - 1), current + 2).map(block => `[正文块 ${block.id}]\n${blockText(block).slice(0, 2200)}`).join("\n\n");
}
export function allowedBookHistory(messages: BookMessage[], chapterId: string) { return messages.filter(message => message.chapterId === chapterId).slice(-24); }
