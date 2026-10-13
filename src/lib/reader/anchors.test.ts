import test from "node:test";
import assert from "node:assert/strict";
import type { ReaderDocument, ReadingDTO } from "@/lib/types";
import { anchorAt, blockText, readerText, validateReaderAnchor, validateReaderPosition } from "./anchors";
import { readingDocument, compatibleReadingSelection, readingSelectionToAnchor, readerAnchorToSelection } from "./reading-adapter";
import { readingMarkdownNodes, safeReaderHref } from "./canonical";
import { visibleMarkdownText } from "@/lib/reading-selection";
import { validateReadingSelection, readingTurnHash } from "@/lib/server/reading-learning";

const document: ReaderDocument = { key: "book:1:version:2", title: "test", language: "en", unitId: "chapter-1", units: [],
  blocks: [{ id: "a", kind: "paragraph", anchorText: "", nodes: [{ type: "text", text: "A 😀 " }, { type: "strong", children: [{ type: "text", text: "repeat" }] }, { type: "text", text: " repeat end" }] },
    { id: "b", kind: "paragraph", anchorText: "", nodes: [{ type: "ruby", text: "漢字", annotation: "かんじ" }, { type: "break" }, { type: "footnote", children: [{ type: "text", text: "1" }] }] }] };

test("semantic text excludes ruby pronunciation while preserving canonical breaks and footnote labels", () => {
  assert.equal(blockText(document.blocks[0]), "A 😀 repeat repeat end");
  assert.equal(blockText(document.blocks[1]), "漢字\n1");
  assert.equal(readerText([{ type: "math", text: "x^2" }, { type: "code", text: "code" }]), "x^2code");
  assert.equal(blockText({ id: "list", kind: "list", nodes: [], anchorText: "", items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]] }), "a\nb");
  assert.equal(blockText({ id: "table", kind: "table", nodes: [], anchorText: "", rows: [[[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]], [[{ type: "text", text: "c" }]]] }), "a\tb\nc");
});

test("anchors bind immutable version, chapter, order, exact UTF-16 offset and local context", () => {
  const anchor = anchorAt(document, "a", 12, 18)!;
  assert.equal(anchor.segments[0].quote, "repeat");
  assert.equal(validateReaderAnchor(document, anchor)?.segments[0].start, 12);
  assert.equal(validateReaderAnchor(document, { ...anchor, documentKey: "book:1:version:3" }), null);
  assert.equal(validateReaderAnchor(document, { ...anchor, unitId: "chapter-2" }), null);
  assert.equal(validateReaderAnchor(document, { ...anchor, segments: [{ ...anchor.segments[0], prefix: "wrong" }] }), null);
  assert.equal(validateReaderAnchor(document, { ...anchor, segments: [{ ...anchor.segments[0], start: 5 }] }), null);
  const second = anchorAt(document, "b", 0, 2)!;
  assert.ok(validateReaderAnchor(document, { ...anchor, segments: [...anchor.segments, ...second.segments] }));
  assert.equal(validateReaderAnchor(document, { ...anchor, segments: [...second.segments, ...anchor.segments] }), null);
  assert.equal(validateReaderAnchor(document, { ...anchor, segments: [...anchor.segments, ...anchor.segments] }), null);
});

test("position restores one canonical character with viewport offset and rejects stale documents", () => {
  const position = { documentKey: document.key, unitId: document.unitId, blockId: "a", offset: 12, viewportOffset: -3.5 };
  assert.deepEqual(validateReaderPosition(document, position), position);
  assert.equal(validateReaderPosition(document, { ...position, offset: 200 }), null);
  assert.equal(validateReaderPosition(document, { ...position, viewportOffset: Infinity }), null);
  assert.equal(validateReaderPosition(document, { ...position, documentKey: "stale" }), null);
});

const reading: ReadingDTO = { id: 1, revision: 4, title: "Article", language: "en", status: "ready", paragraphs: [
  { id: "stable-p1", text: "## Heading\n**bold** and *emphasis*, [link](https://example.org) &amp; `code` $x^2$ 😀", page: 1 },
  { id: "stable-p2", text: "> Another paragraph.", page: 2 },
], extracted: "", overview: "", error: null, createdAt: "2026-10-13", pageCount: 2 };

test("reading adapter keeps legacy visible text and stable paragraph IDs", () => {
  const source = readingDocument(reading);
  for (const [index, block] of source.blocks.entries()) assert.equal(blockText(block), visibleMarkdownText(reading.paragraphs[index].text));
  assert.equal(source.blocks[0].id, "stable-p1");
  const anchor = anchorAt(source, "stable-p1", 8, 12)!;
  const selection = readerAnchorToSelection(source, anchor)!;
  assert.deepEqual(readingSelectionToAnchor(source, selection), anchor);
  assert.deepEqual(validateReadingSelection(reading, selection), selection);
  assert.deepEqual(compatibleReadingSelection(reading, selection, anchor), selection);
  assert.throws(() => compatibleReadingSelection(reading, { segments: [{ ...selection.segments[0], paragraphId: "stable-p2" }] }, anchor));
  const input = { text: "question", images: [], phase: "free_reading", focus: null, intent: null, selection: validateReadingSelection(reading, selection), paragraphIdx: 0, stateRevision: 0 };
  assert.equal(readingTurnHash(input), readingTurnHash({ ...input, selection: validateReadingSelection(reading, compatibleReadingSelection(reading, selection, anchor)) }));
});

test("unsupported Markdown stays safe canonical text and active URL schemes are rejected", () => {
  for (const text of ["<script>alert(1)</script> **hello**", "~~deleted~~", "![alt](https://example.org/image)", "1. one\n2. two", "```js\nlet x = 1\n```", "**嵌套 *正文* 字体**"]) {
    assert.equal(readerText(readingMarkdownNodes(text)), visibleMarkdownText(text));
  }
  assert.equal(safeReaderHref("javascript:alert(1)"), undefined);
  assert.equal(safeReaderHref("data:text/html,test"), undefined);
  assert.equal(safeReaderHref("//external.example"), undefined);
  assert.equal(safeReaderHref("https://example.org/path"), "https://example.org/path");
  assert.equal(safeReaderHref("#fragment"), "#fragment");
});
