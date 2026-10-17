import test from "node:test";
import assert from "node:assert/strict";
import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import { anchorAt, blockText } from "./anchors";
import { readerSelection } from "./dom-selection";
import { clampPage, columnCount, columnIndex, pagePosition, paginationKey, positionPage, readingPercentage } from "./pagination";

function geometry(text: string, charactersPerPage = 12) {
  const width = 500; const stride = 548; let translated = 0;
  const node = { nodeType: 3, textContent: text, length: text.length };
  const rect = (offset: number) => ({ left: translated + Math.floor(offset / charactersPerPage) * stride + offset % charactersPerPage * 8,
    right: translated + Math.floor(offset / charactersPerPage) * stride + offset % charactersPerPage * 8 + 8, top: 10, bottom: 30, height: 20 });
  const leaves: any[] = [{ dataset: { readerStart: "0", readerEnd: String(text.length) }, firstChild: node, closest: () => null }];
  const element = { dataset: { readerBlock: "b" }, querySelectorAll: () => leaves, checkVisibility: () => true,
    getClientRects: () => Array.from({ length: Math.ceil(text.length / charactersPerPage) }, (_, index) => ({ left: translated + index * stride, right: translated + index * stride + width })),
    getBoundingClientRect: () => rect(0) };
  const article = { querySelectorAll: () => [element], getBoundingClientRect: () => ({ left: translated }), contains: () => true } as unknown as HTMLElement;
  const document: ReaderDocument = { key: "reading:1:2", title: "Article", language: "ja", unitId: "article", units: [],
    blocks: [{ id: "b", kind: "paragraph", nodes: [{ type: "text", text }], anchorText: text }] };
  const previous = { window: globalThis.window, Node: globalThis.Node };
  let selected: any = null;
  globalThis.Node = { TEXT_NODE: 3 } as unknown as typeof Node;
  globalThis.window = { getSelection: () => selected, document: { createRange: () => {
    let offset = 0;
    return { setStart(_node: unknown, value: number) { offset = value; }, setEnd() {}, getBoundingClientRect: () => rect(offset) };
  } } } as unknown as Window & typeof globalThis;
  return { article, document, width, stride, leaves, rect,
    translate(value: number) { translated = value; }, reflow(value: number) { charactersPerPage = value; },
    selection(start: number, end: number) { selected = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: node, endContainer: node, startOffset: start, endOffset: end, intersectsNode: () => true }) }; },
    close() { Object.assign(globalThis, previous); } };
}

test("column boundaries tolerate subpixel rounding without a phantom final page", () => {
  assert.equal(columnCount(500, 500), 1); assert.equal(columnCount(1048, 500), 2);
  assert.equal(columnCount(1596.3, 500), 3); assert.equal(columnIndex(548, 548), 1);
  assert.equal(clampPage(-1, 3), 0); assert.equal(clampPage(30, 3), 2); assert.equal(clampPage(NaN, 0), 0);
});

test("one long bilingual paragraph has distinct original character anchors on every page", () => {
  const fixture = geometry("A repeated phrase. 日本語の文章。A repeated phrase. 😀 end.");
  try {
    const positions = [0, 1, 2, 3].map(page => pagePosition(fixture.article, fixture.document, page, fixture.width)!);
    assert.deepEqual(positions.map(position => position.offset), [0, 12, 24, 36]);
    for (const [page, position] of positions.entries()) assert.equal(positionPage(fixture.article, position, fixture.stride), page);
    assert.equal(pagePosition(fixture.article, fixture.document, 100, fixture.width), null);
    fixture.translate(-1096);
    assert.equal(pagePosition(fixture.article, fixture.document, 2, fixture.width)?.offset, 24);
    assert.equal(positionPage(fixture.article, positions[2], fixture.stride), 2);
  } finally { fixture.close(); }
});

test("layout geometry can change without changing the saved UTF-16 character", () => {
  const fixture = geometry("英語 and 日本語 😀 ".repeat(200));
  const saved: ReaderPosition = { documentKey: fixture.document.key, unitId: "article", blockId: "b", offset: 193, viewportOffset: 0 };
  try {
    for (const capacity of [12, 60, 17, 8, 90, 34]) {
      fixture.reflow(capacity);
      assert.equal(positionPage(fixture.article, saved, fixture.stride), Math.floor(193 / capacity));
      assert.equal(saved.offset, 193);
    }
  } finally { fixture.close(); }
});

test("atomic formulas and rich-text boundaries keep their canonical offsets", () => {
  const fixture = geometry("firstx^2日本語", 5);
  try {
    fixture.leaves.splice(0, 1,
      { dataset: { readerStart: "0", readerEnd: "5" }, firstChild: { nodeType: 3, textContent: "first" }, closest: () => null },
      { dataset: { readerStart: "5", readerEnd: "8", readerAtomic: "" }, firstChild: null, closest: () => null, getBoundingClientRect: () => fixture.rect(5) });
    assert.equal(pagePosition(fixture.article, fixture.document, 1, fixture.width)?.offset, 5);
  } finally { fixture.close(); }
});

test("native selections on a later page still validate against the whole original block", () => {
  const fixture = geometry("Same phrase. Same phrase. 日本語 😀 ends.");
  try {
    fixture.translate(-548); fixture.selection(13, 24);
    const selected = readerSelection(fixture.article, fixture.document)!;
    assert.equal(selected.segments[0].start, 13);
    assert.equal(selected.segments[0].quote, "Same phrase");
    assert.deepEqual(selected, anchorAt(fixture.document, "b", 13, 24));
  } finally { fixture.close(); }
});

test("page navigation does not consume editing, dialog, selection or local scrolling keys", () => {
  assert.equal(paginationKey("ArrowRight", null, false, false), 1);
  assert.equal(paginationKey("PageUp", null, false, false), -1);
  assert.equal(paginationKey("ArrowDown", null, false, false), 0);
  for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"]) {
    assert.equal(paginationKey(key, null, true, false), 0);
    assert.equal(paginationKey(key, null, false, true), 0);
    assert.equal(paginationKey(key, { closest: () => ({}) } as unknown as EventTarget, false, false), 0);
  }
});

test("thousand-paragraph articles and percentage calculations have no paragraph cap", () => {
  const document: ReaderDocument = { key: "reading:1:8", title: "Long article", language: "en", unitId: "article", units: [],
    blocks: Array.from({ length: 1003 }, (_, index) => ({ id: `b${index}`, kind: "paragraph", nodes: [{ type: "text", text: "word ".repeat(400) }], anchorText: "" })) };
  assert.ok(document.blocks.reduce((sum, block) => sum + blockText(block).length, 0) > 1_500_000);
  assert.equal(readingPercentage(document, { documentKey: document.key, unitId: "article", blockId: "b1002", offset: 2000, viewportOffset: 0 }), 100);
  assert.equal(readingPercentage(document, { documentKey: "stale", unitId: "article", blockId: "b1002", offset: 2000, viewportOffset: 0 }), 0);
});
