import assert from "node:assert/strict";
import test from "node:test";
import type { ReadingDTO, ReadingLearningState, ReadingSelection } from "@/lib/types";
import {
  firstUnconfirmedFocus,
  readingTurnHash,
  requiredReadingFoci,
  validateReadingSelection,
  visibleMarkdownText,
} from "./reading-learning";

function reading(paragraphs: { id: string; text: string; page?: number }[]): ReadingDTO {
  return {
    id: 1, title: "Test", language: "en", status: "ready",
    paragraphs: paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.text, page: paragraph.page ?? 1 })),
    extracted: "", overview: "", error: null, revision: 1, createdAt: "2026-10-11T00:00:00.000Z", pageCount: 1,
  };
}

function state(articleKind: ReadingLearningState["articleKind"]): ReadingLearningState {
  return {
    phase: "article_analysis", stateRevision: 0, readingConfirmedAt: null, articleKind, articleKindSource: "automatic",
    currentFocus: null,
    focusStatus: { structure: "not_started", writing: "not_started", theme: "not_started", emotion: "not_started", technique: "not_started" },
    analysisNotes: {}, summary: "", analysisCompletedAt: null, legacy: null,
  };
}

test("selection text follows rendered Markdown for emphasis, links, code and math delimiters", () => {
  assert.equal(visibleMarkdownText("**Quiet** mornings [help](https://example.test). `x + 1` $a^2$"), "Quiet mornings help. x + 1 a^2");
});

test("a repeated phrase is resolved by its selected surrounding context", () => {
  const material = reading([{ id: "p1", text: "First turn, same phrase. Later, same phrase again." }]);
  const source = visibleMarkdownText(material.paragraphs[0].text);
  const start = source.lastIndexOf("same phrase");
  const selection: ReadingSelection = { segments: [{
    paragraphId: "p1", start, end: start + "same phrase".length, quote: "same phrase",
    prefix: source.slice(start - 10, start), suffix: source.slice(start + "same phrase".length, start + "same phrase".length + 8),
  }] };
  assert.equal(validateReadingSelection(material, selection)?.segments[0].start, start);
});

test("selection anchors can span adjacent English and Japanese paragraphs", () => {
  const material = reading([{ id: "en-p1", text: "The result is clear." }, { id: "ja-p2", text: "しかし、結果はまだ明らかではありません。", page: 2 }]);
  const selection: ReadingSelection = { segments: [
    { paragraphId: "en-p1", start: 4, end: 10, quote: "result", prefix: "The ", suffix: " is" },
    { paragraphId: "ja-p2", start: 0, end: 6, quote: "しかし、", prefix: "", suffix: "結果" },
  ] };
  assert.equal(validateReadingSelection(material, selection)?.segments.length, 2);
});

test("selection validation rejects invented text, invalid order and stale paragraph IDs", () => {
  const material = reading([{ id: "p1", text: "A real source sentence." }, { id: "p2", text: "Another source sentence." }]);
  const base = { start: 0, end: 5, quote: "invented", prefix: "", suffix: "" };
  assert.throws(() => validateReadingSelection(material, { segments: [{ ...base, paragraphId: "p1" }] }), /验证/);
  assert.throws(() => validateReadingSelection(material, { segments: [{ ...base, paragraphId: "missing" }] }), /不匹配/);
  assert.throws(() => validateReadingSelection(material, { segments: [
    { paragraphId: "p2", start: 0, end: 5, quote: "Anoth", prefix: "", suffix: "er" },
    { paragraphId: "p1", start: 0, end: 4, quote: "A re", prefix: "", suffix: "al" },
  ] }), /不匹配/);
});

test("article type selects three or five analysis focuses and completion advances in order", () => {
  assert.deepEqual(requiredReadingFoci("general"), ["structure", "writing", "theme"]);
  assert.deepEqual(requiredReadingFoci("literary"), ["structure", "writing", "theme", "emotion", "technique"]);
  const literary = state("literary");
  assert.equal(firstUnconfirmedFocus(literary), "structure");
  literary.focusStatus.structure = "confirmed";
  literary.focusStatus.writing = "confirmed";
  assert.equal(firstUnconfirmedFocus(literary), "theme");
});

test("turn idempotency hash binds phase, selection, bookmark and teaching revision", () => {
  const base = { text: "Explain this", images: [], phase: "free_reading", focus: null, intent: null, selection: null, paragraphIdx: 0, stateRevision: 2 };
  const hash = readingTurnHash(base);
  assert.equal(readingTurnHash(base), hash);
  assert.notEqual(readingTurnHash({ ...base, paragraphIdx: 1 }), hash);
  assert.notEqual(readingTurnHash({ ...base, stateRevision: 3 }), hash);
});
