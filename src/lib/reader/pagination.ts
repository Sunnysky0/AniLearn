import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import { blockText } from "./anchors";
import { readerElement, readerRange } from "./dom-selection";

export const PAGE_GAP = 48;
export function columnIndex(x: number, stride: number): number {
  return stride > 0 ? Math.max(0, Math.floor((x + .5) / stride)) : 0;
}
export function columnCount(scrollWidth: number, width: number, gap = PAGE_GAP): number {
  return width > 0 ? Math.max(1, Math.ceil((scrollWidth + gap - 1) / (width + gap))) : 1;
}
export function clampPage(page: number, count: number): number { return Math.max(0, Math.min(Math.max(0, count - 1), Math.trunc(page) || 0)); }

export function positionPage(article: HTMLElement, position: ReaderPosition, stride: number): number | null {
  const range = readerRange(article, position.blockId, position.offset);
  const rect = range?.getBoundingClientRect() ?? readerElement(article, position.blockId)?.getBoundingClientRect();
  return rect && rect.height ? columnIndex(rect.left - article.getBoundingClientRect().left, stride) : null;
}

/** Locate the first canonical character in a CSS column, including a paragraph
 * that began several pages earlier. Text ranges retain the original offsets. */
export function pagePosition(article: HTMLElement, document: ReaderDocument, page: number, width: number): ReaderPosition | null {
  const stride = width + PAGE_GAP; const origin = article.getBoundingClientRect().left;
  const left = page * stride; const right = left + width;
  const blocks = new Map(document.blocks.map(block => [block.id, block]));
  for (const element of article.querySelectorAll<HTMLElement>("[data-reader-block]")) {
    const blockId = element.dataset.readerBlock;
    if (!blockId || !blocks.has(blockId)) continue;
    if (!Array.from(element.getClientRects()).some(rect => rect.right - origin > left + .5 && rect.left - origin < right - .5)) continue;
    for (const leaf of element.querySelectorAll<HTMLElement>("[data-reader-start]")) {
      if (leaf.closest("[data-reader-ignore]")) continue;
      const base = Number(leaf.dataset.readerStart); const end = Number(leaf.dataset.readerEnd);
      if (end <= base) continue;
      const node = leaf.firstChild;
      let offset = base;
      if (leaf.dataset.readerAtomic !== undefined || !node || node.nodeType !== 3) {
        if (columnIndex(leaf.getBoundingClientRect().left - origin, stride) !== page) continue;
      } else {
        const text = node.textContent ?? "";
        const pageOf = (index: number) => {
          const range = window.document.createRange(); range.setStart(node, index); range.setEnd(node, Math.min(text.length, index + 1));
          return columnIndex(range.getBoundingClientRect().left - origin, stride);
        };
        let low = 0; let high = text.length;
        while (low < high) { const mid = Math.floor((low + high) / 2); if (pageOf(mid) < page) low = mid + 1; else high = mid; }
        if (low >= text.length || pageOf(low) !== page) continue;
        // Never start a bookmark in the middle of a UTF-16 surrogate pair.
        if (low > 0 && /[\uDC00-\uDFFF]/.test(text[low]) && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
        offset += low;
      }
      return { documentKey: document.key, unitId: document.unitId, blockId, offset, viewportOffset: 0 };
    }
    if (!blockText(blocks.get(blockId)!)) return { documentKey: document.key, unitId: document.unitId, blockId, offset: 0, viewportOffset: 0 };
  }
  return null;
}

export function readingPercentage(document: ReaderDocument, position: ReaderPosition | null): number {
  if (!position || position.documentKey !== document.key || position.unitId !== document.unitId) return 0;
  let total = 0; let before = 0; let found = false;
  for (const block of document.blocks) {
    const length = blockText(block).length;
    if (block.id === position.blockId) { before = total + Math.min(length, position.offset); found = true; }
    total += length;
  }
  return found && total ? Math.min(100, Math.round(before / total * 100)) : 0;
}

export function paginationKey(key: string, target: EventTarget | null, hasSelection: boolean, blocked: boolean): number {
  if (blocked || hasSelection || !["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(key)) return 0;
  if (target && "closest" in target && typeof target.closest === "function" &&
    target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=dialog],[role=slider],[data-reader-local-scroll]")) return 0;
  return key === "ArrowLeft" || key === "PageUp" ? -1 : 1;
}
