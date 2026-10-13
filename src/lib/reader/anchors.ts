import type { ReaderAnchor, ReaderBlock, ReaderDocument, ReaderNode, ReaderPosition } from "@/lib/book-types";

/** This is also the exact text used by the DOM leaves and persisted offsets. */
export function readerText(nodes: ReaderNode[]): string {
  return nodes.map((node) => node.type === "break" ? "\n" : node.children?.length ? readerText(node.children) : node.text ?? "").join("");
}

export function blockText(block: ReaderBlock): string {
  if (block.kind === "list" && block.items) return block.items.map(readerText).join("\n");
  if (block.kind === "table" && block.rows) return block.rows.map((row) => row.map(readerText).join("\t")).join("\n");
  return readerText(block.nodes);
}

export function validateReaderAnchor(document: ReaderDocument, value: unknown): ReaderAnchor | null {
  if (!value || typeof value !== "object") return null;
  const anchor = value as ReaderAnchor;
  if (anchor.version !== 2 || anchor.documentKey !== document.key || anchor.unitId !== document.unitId ||
    !Array.isArray(anchor.segments) || !anchor.segments.length || anchor.segments.length > 50) return null;
  const indices = new Map(document.blocks.map((block, index) => [block.id, index]));
  let previous = -1;
  let previousEnd = -1;
  let size = 0;
  const segments: ReaderAnchor["segments"] = [];
  for (const candidate of anchor.segments) {
    if (!candidate || typeof candidate.blockId !== "string" || !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) || candidate.start < 0 || candidate.end <= candidate.start ||
      typeof candidate.quote !== "string" || !candidate.quote || typeof candidate.prefix !== "string" ||
      typeof candidate.suffix !== "string" || candidate.prefix.length > 200 || candidate.suffix.length > 200) return null;
    const index = indices.get(candidate.blockId);
    if (index === undefined || index < previous || (index === previous && candidate.start < previousEnd)) return null;
    const source = blockText(document.blocks[index]);
    if (candidate.end > source.length || source.slice(candidate.start, candidate.end) !== candidate.quote ||
      (candidate.prefix && !source.slice(0, candidate.start).endsWith(candidate.prefix)) ||
      (candidate.suffix && !source.slice(candidate.end).startsWith(candidate.suffix))) return null;
    size += Array.from(candidate.quote).length;
    if (size > 4000) return null;
    segments.push({ blockId: candidate.blockId, start: candidate.start, end: candidate.end, quote: candidate.quote,
      prefix: source.slice(Math.max(0, candidate.start - 40), candidate.start), suffix: source.slice(candidate.end, candidate.end + 40) });
    previous = index;
    previousEnd = candidate.end;
  }
  return { version: 2, documentKey: document.key, unitId: document.unitId, segments };
}

export function validateReaderPosition(document: ReaderDocument, value: unknown): ReaderPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as ReaderPosition;
  if (position.documentKey !== document.key || position.unitId !== document.unitId || typeof position.blockId !== "string" ||
    !Number.isSafeInteger(position.offset) || position.offset < 0 || !Number.isFinite(position.viewportOffset) ||
    Math.abs(position.viewportOffset) > 10000) return null;
  const block = document.blocks.find((block) => block.id === position.blockId);
  if (!block || position.offset > blockText(block).length) return null;
  return { documentKey: document.key, unitId: document.unitId, blockId: position.blockId, offset: position.offset,
    viewportOffset: position.viewportOffset };
}

export function anchorQuote(anchor: ReaderAnchor): string { return anchor.segments.map((segment) => segment.quote).join(" … "); }

export function anchorAt(document: ReaderDocument, blockId: string, start: number, end: number): ReaderAnchor | null {
  const block = document.blocks.find((block) => block.id === blockId);
  if (!block) return null;
  const text = blockText(block);
  return validateReaderAnchor(document, { version: 2, documentKey: document.key, unitId: document.unitId,
    segments: [{ blockId, start, end, quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 40), start), suffix: text.slice(end, end + 40) }] });
}
