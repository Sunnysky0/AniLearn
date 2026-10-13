import type { ReaderAnchor, ReaderDocument, ReaderPosition } from "@/lib/book-types";
import { blockText, validateReaderAnchor } from "./anchors";

function hasRenderedText(element: HTMLElement): boolean {
  // A skipped content-visibility group can retain plausible, stale descendant
  // rectangles. They are never evidence for the visible reading position.
  if (typeof element.checkVisibility === "function") return element.checkVisibility({ contentVisibilityAuto: true });
  // Loaded Reader groups use real layout, so old browsers only need to reject
  // hidden trees. Auto groups from older consumers fail closed when visibility
  // cannot be established by the browser API.
  const group = element.closest<HTMLElement>("[data-reader-chunk]");
  if (group && typeof window.getComputedStyle === "function" && window.getComputedStyle(group).contentVisibility === "auto") return false;
  return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
}

export function readerElement(root: HTMLElement, blockId: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-reader-block]")).find((element) => element.dataset.readerBlock === blockId && hasRenderedText(element)) ?? null;
}

function textLeaves(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-reader-start]")).filter((leaf) => !leaf.closest("[data-reader-ignore]"));
}

export function readerSelection(root: HTMLElement, document: ReaderDocument): ReaderAnchor | null {
  const selected = window.getSelection();
  if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
  const range = selected.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const segments: ReaderAnchor["segments"] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-reader-block]")) {
    if (!hasRenderedText(element) || !range.intersectsNode(element)) continue;
    const block = document.blocks.find((candidate) => candidate.id === element.dataset.readerBlock);
    if (!block) continue;
    const source = blockText(block);
    let start = Infinity;
    let end = -1;
    for (const leaf of textLeaves(element)) {
      if (!range.intersectsNode(leaf)) continue;
      const base = Number(leaf.dataset.readerStart);
      const limit = Number(leaf.dataset.readerEnd);
      if (leaf.dataset.readerAtomic !== undefined) { start = Math.min(start, base); end = Math.max(end, limit); continue; }
      const node = leaf.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
      const a = range.startContainer === node ? range.startOffset : 0;
      const b = range.endContainer === node ? range.endOffset : node.textContent?.length ?? 0;
      if (b > a) { start = Math.min(start, base + a); end = Math.max(end, base + b); }
    }
    if (!Number.isFinite(start) || end <= start) continue;
    const raw = source.slice(start, end);
    const quote = raw.trim();
    if (!quote) continue;
    start += raw.indexOf(quote); end = start + quote.length;
    segments.push({ blockId: block.id, start, end, quote, prefix: source.slice(Math.max(0, start - 40), start), suffix: source.slice(end, end + 40) });
  }
  return validateReaderAnchor(document, { version: 2, documentKey: document.key, unitId: document.unitId, segments });
}

export function readerRange(root: HTMLElement, blockId: string, offset: number): Range | null {
  const block = readerElement(root, blockId);
  if (!block || !hasRenderedText(block)) return null;
  const leaves = textLeaves(block);
  const leaf = leaves.find((item) => Number(item.dataset.readerStart) <= offset && Number(item.dataset.readerEnd) > offset)
    ?? leaves.findLast((item) => Number(item.dataset.readerEnd) === offset && Number(item.dataset.readerStart) < offset) ?? leaves[0];
  if (!leaf) return null;
  const range = window.document.createRange();
  const node = leaf.firstChild;
  if (leaf.dataset.readerAtomic !== undefined || !node || node.nodeType !== Node.TEXT_NODE) range.selectNode(leaf);
  else {
    const local = Math.max(0, Math.min(node.textContent?.length ?? 0, offset - Number(leaf.dataset.readerStart)));
    range.setStart(node, local); range.setEnd(node, Math.min(node.textContent?.length ?? 0, local + 1));
  }
  return range;
}

export function currentReaderPosition(root: HTMLElement, document: ReaderDocument): ReaderPosition | null {
  const bounds = root.getBoundingClientRect();
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-reader-block]")).filter(hasRenderedText);
  const element = blocks.find((block) => block.getBoundingClientRect().bottom > bounds.top + 12) ?? blocks.at(-1);
  if (!element?.dataset.readerBlock) return null;
  const block = document.blocks.find((candidate) => candidate.id === element.dataset.readerBlock);
  if (!block) return null;
  const leaves = textLeaves(element);
  const first = leaves.find((leaf) => leaf.getBoundingClientRect().bottom > bounds.top + 12) ?? leaves[0];
  let offset = first ? Number(first.dataset.readerStart) : 0;
  if (first && first.dataset.readerAtomic === undefined && first.firstChild?.nodeType === Node.TEXT_NODE) {
    const node = first.firstChild as Text;
    // Find the first visible character of wrapped text instead of restoring the paragraph top.
    let left = 0; let right = node.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2); const probe = window.document.createRange();
      probe.setStart(node, mid); probe.setEnd(node, Math.min(node.length, mid + 1));
      if (probe.getBoundingClientRect().bottom <= bounds.top + 12) left = mid + 1; else right = mid;
    }
    offset += left;
  }
  const range = readerRange(root, block.id, offset);
  const rect = range?.getBoundingClientRect();
  return { documentKey: document.key, unitId: document.unitId, blockId: block.id, offset,
    viewportOffset: (rect?.height ? rect.top : element.getBoundingClientRect().top) - bounds.top };
}
