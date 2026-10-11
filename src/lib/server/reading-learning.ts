import { createHash } from "node:crypto";
import type {
  ReadingDTO,
  ReadingFocus,
  ReadingLearningState,
  ReadingSelection,
  ReadingSelectionSegment,
} from "@/lib/types";
import { visibleMarkdownText } from "@/lib/reading-selection";

export { visibleMarkdownText } from "@/lib/reading-selection";

export const READING_FOCI: ReadingFocus[] = ["structure", "writing", "theme", "emotion", "technique"];

export const READING_FOCUS_LABELS: Record<ReadingFocus, string> = {
  structure: "文章结构", writing: "写作思路", theme: "文章主旨", emotion: "情感表达", technique: "表现手法",
};

export function requiredReadingFoci(kind: ReadingLearningState["articleKind"]): ReadingFocus[] {
  return kind === "literary" ? READING_FOCI : READING_FOCI.slice(0, 3);
}

export function firstUnconfirmedFocus(state: ReadingLearningState): ReadingFocus | null {
  return requiredReadingFoci(state.articleKind).find((focus) => state.focusStatus[focus] !== "confirmed") ?? null;
}

export function isReadingFocus(value: unknown): value is ReadingFocus {
  return typeof value === "string" && READING_FOCI.includes(value as ReadingFocus);
}

function findQuotedRange(source: string, segment: ReadingSelectionSegment): { start: number; end: number } | null {
  const candidates: { start: number; score: number; distance: number }[] = [];
  let from = 0;
  while (segment.quote && from <= source.length) {
    const start = source.indexOf(segment.quote, from);
    if (start < 0) break;
    const before = source.slice(Math.max(0, start - segment.prefix.length), start);
    const after = source.slice(start + segment.quote.length, start + segment.quote.length + segment.suffix.length);
    let prefixMatch = 0;
    while (prefixMatch < before.length && prefixMatch < segment.prefix.length && before[before.length - 1 - prefixMatch] === segment.prefix[segment.prefix.length - 1 - prefixMatch]) prefixMatch++;
    let suffixMatch = 0;
    while (suffixMatch < after.length && suffixMatch < segment.suffix.length && after[suffixMatch] === segment.suffix[suffixMatch]) suffixMatch++;
    candidates.push({ start, score: prefixMatch + suffixMatch, distance: Math.abs(start - segment.start) });
    from = start + Math.max(1, segment.quote.length);
  }
  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  if (!candidates.length) return null;
  return { start: candidates[0].start, end: candidates[0].start + segment.quote.length };
}

export function validateReadingSelection(reading: ReadingDTO, value: unknown): ReadingSelection | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || !Array.isArray((value as ReadingSelection).segments)) {
    throw new Error("原文选区格式不正确。");
  }
  const segments = (value as ReadingSelection).segments;
  if (!segments.length || segments.length > 50) throw new Error("原文选区无效，请重新选择。");
  let selectedLength = 0;
  let previousIdx = -1;
  const validated: ReadingSelectionSegment[] = [];
  for (const valueSegment of segments) {
    const segment = valueSegment as ReadingSelectionSegment;
    if (!segment || typeof segment.paragraphId !== "string" || typeof segment.quote !== "string" || !segment.quote ||
      !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > 1_000_000 ||
      typeof segment.prefix !== "string" || typeof segment.suffix !== "string") {
      throw new Error("原文选区格式不正确，请重新选择。");
    }
    const idx = reading.paragraphs.findIndex((paragraph) => paragraph.id === segment.paragraphId);
    if (idx < previousIdx || idx < 0) throw new Error("原文选区与当前文章不匹配，请重新选择。");
    previousIdx = idx;
    const source = visibleMarkdownText(reading.paragraphs[idx].text);
    const located = findQuotedRange(source, segment);
    if (!located) {
      throw new Error("无法在文章原文中验证所选内容，请重新选择。");
    }
    selectedLength += Array.from(segment.quote).length;
    if (selectedLength > 4000) throw new Error("原文选区最多 4000 个字符。");
    validated.push({
      paragraphId: segment.paragraphId, start: located.start, end: located.end, quote: segment.quote,
      prefix: source.slice(Math.max(0, located.start - 40), located.start), suffix: source.slice(located.end, located.end + 40),
    });
  }
  return { segments: validated };
}

export function readingSelectionPrompt(reading: ReadingDTO, selection: ReadingSelection | null): string {
  if (!selection) return "";
  return selection.segments.map((segment) => {
    const index = reading.paragraphs.findIndex((paragraph) => paragraph.id === segment.paragraphId);
    const paragraph = reading.paragraphs[index];
    return `第 ${index + 1} 段（来源页 ${paragraph.page}）：\n${segment.prefix}【${segment.quote}】${segment.suffix}`;
  }).join("\n\n");
}

export function readingTurnHash(input: {
  text: string; images: string[]; phase: string; focus: string | null; intent: string | null; selection: ReadingSelection | null; paragraphIdx: number; stateRevision: number;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
