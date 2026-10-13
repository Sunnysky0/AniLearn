import type { ReaderAnchor, ReaderBlock, ReaderDocument, ReaderPosition } from "@/lib/book-types";
import type { ReadingDTO, ReadingSelection } from "@/lib/types";
import { readingMarkdownNodes } from "./canonical";
import { blockText, validateReaderAnchor, validateReaderPosition } from "./anchors";

export function readingDocument(reading: ReadingDTO): ReaderDocument {
  const unitId = "article";
  return { key: `reading:${reading.id}:${reading.revision}`, title: reading.title, language: reading.language, unitId,
    units: [{ id: unitId, title: reading.title, parentId: null, role: "main", order: 0, blockCount: reading.paragraphs.length }],
    blocks: reading.paragraphs.map((paragraph): ReaderBlock => {
      const nodes = readingMarkdownNodes(paragraph.text);
      const heading = /^\s*(#{1,6})\s/.exec(paragraph.text);
      return { id: paragraph.id, kind: heading ? "heading" : /^\s*>/.test(paragraph.text) ? "quote" : "paragraph", nodes,
        anchorText: "", level: heading?.[1].length, markdown: paragraph.text, source: { page: paragraph.page } };
    }).map((block) => ({ ...block, anchorText: blockText(block) })),
  };
}

export function readingSelectionToAnchor(document: ReaderDocument, selection: ReadingSelection | null | undefined): ReaderAnchor | null {
  if (!selection) return null;
  return validateReaderAnchor(document, { version: 2, documentKey: document.key, unitId: document.unitId,
    segments: selection.segments.map(({ paragraphId, ...segment }) => ({ ...segment, blockId: paragraphId })) });
}

export function readerAnchorToSelection(document: ReaderDocument, value: unknown): ReadingSelection | null {
  const anchor = validateReaderAnchor(document, value);
  return anchor ? { segments: anchor.segments.map(({ blockId, ...segment }) => ({ ...segment, paragraphId: blockId })) } : null;
}

export function readingInitialPosition(document: ReaderDocument, position: unknown, currentIdx: number): ReaderPosition | null {
  return validateReaderPosition(document, position) ?? (document.blocks[currentIdx] ? { documentKey: document.key,
    unitId: document.unitId, blockId: document.blocks[currentIdx].id, offset: 0, viewportOffset: 0 } : null);
}

/** Reject conflicting dual representations while preserving legacy callers. */
export function compatibleReadingSelection(reading: ReadingDTO, selection: ReadingSelection | null | undefined, readerAnchor: unknown) {
  if (readerAnchor == null) return selection;
  const document = readingDocument(reading);
  const mapped = readerAnchorToSelection(document, readerAnchor);
  if (!mapped) throw new Error("原文选区与当前文章不匹配，请重新选择。");
  if (selection && JSON.stringify(selection.segments.map(({ paragraphId, start, end, quote }) => ({ paragraphId, start, end, quote }))) !==
    JSON.stringify(mapped.segments.map(({ paragraphId, start, end, quote }) => ({ paragraphId, start, end, quote })))) {
    throw new Error("原文选区的两种定位不一致，请重新选择。");
  }
  return mapped;
}
