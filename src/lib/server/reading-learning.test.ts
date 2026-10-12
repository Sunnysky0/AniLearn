import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ReadingDTO, ReadingLearningState, ReadingSelection } from "@/lib/types";
import {
  firstUnconfirmedFocus,
  readingTurnHash,
  requiredReadingFoci,
  validateReadingSelection,
  visibleMarkdownText,
  inferReadingSelectionTask,
  isReadingSelectionTask,
  validateReadingSelectionAnswer,
  SelectionResponseError,
} from "./reading-learning";
import { createTagParser } from "./protocol";

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

function answerBlocks(raw: string) {
  const parser = createTagParser(["quote", "msg", "action", "analysis-note", "analysis-summary", "example", "exercise", "note"]);
  const blocks = [];
  for (let i = 0; i < raw.length; i += 7) blocks.push(...parser.push(raw.slice(i, i + 7)));
  blocks.push(...parser.end());
  return { blocks, stray: parser.stray() };
}

const explanation = '<msg><zh>这是形容词，此处表示用于引燃或纵火的，修饰后面的装置。</zh><ja>[穏やか] ここでは、火をつけるための装置を表しています。</ja></msg>';

test("only the three exact legacy shortcut questions infer a selection task", () => {
  assert.equal(inferReadingSelectionTask("请解释我选中的词语在此处的含义和语境。"), "vocabulary");
  assert.equal(inferReadingSelectionTask("请分析我选中句子的语法结构和关键用法。"), "grammar");
  assert.equal(inferReadingSelectionTask("请用简洁中文说明我选中内容的句意。"), "meaning");
  for (const text of ["constructor", "toString", "请解释选中词语的语法。", "请解释我选中的词语在此处的含义和语境。还有别的问题。"]) {
    assert.equal(inferReadingSelectionTask(text), null);
  }
  for (const value of [null, undefined, "continue", "", {}, 1]) assert.equal(isReadingSelectionTask(value), false);
});

test("explicit tasks change the request hash while omission preserves the old hash", () => {
  const oldInput = { text: "Explain this", images: [], phase: "free_reading", focus: null, intent: null, selection: null, paragraphIdx: 0, stateRevision: 2 };
  const oldHash = createHash("sha256").update(JSON.stringify(oldInput)).digest("hex");
  assert.equal(readingTurnHash(oldInput), oldHash);
  assert.equal(readingTurnHash({ ...oldInput, selectionTask: undefined }), oldHash);
  const hashes = ["vocabulary", "grammar", "meaning"].map((selectionTask) => readingTurnHash({ ...oldInput, selectionTask: selectionTask as "vocabulary" | "grammar" | "meaning" }));
  assert.equal(new Set([oldHash, ...hashes]).size, 4);
});

test("the reported reply is rejected even when its surrounding quote includes the selected word", () => {
  const source = "I watched the campaign develop: undersea cables cut, incendiary devices hidden in cargo packages, and arson attacks.";
  const material = reading([{ id: "2-p6", text: source }]);
  const start = source.indexOf("incendiary");
  const selection = validateReadingSelection(material, { segments: [{ paragraphId: "2-p6", start, end: start + 10, quote: "incendiary", prefix: "", suffix: "" }] })!;
  const wrong = answerBlocks('<quote lang="en" paragraph="2-p6">campaign develop: undersea cables cut, incendiary devices hidden in cargo packages, and arson attacks</quote>' + explanation + '<action>wait</action>');
  assert.throws(() => validateReadingSelectionAnswer(wrong.blocks, wrong.stray, selection, material), SelectionResponseError);
  const correct = answerBlocks('<quote lang="en" paragraph="2-p6">incendiary</quote>' + explanation + '<action>wait</action>');
  assert.doesNotThrow(() => validateReadingSelectionAnswer(correct.blocks, correct.stray, selection, material));
});

test("target validation uses visible Markdown anchors and ordered English/Japanese segments", () => {
  for (const [language, source, quote] of [["en", "Before **hot** and [hot](https://example.test) after", "hot and hot"], ["ja", "しかし、**結果**はまだ不明です。", "結果"]] as const) {
    const material = { ...reading([{ id: "p1", text: source }]), language };
    const visible = visibleMarkdownText(source);
    const start = visible.indexOf(quote);
    const selection = validateReadingSelection(material, { segments: [{ paragraphId: "p1", start, end: start + quote.length, quote, prefix: "", suffix: "" }] })!;
    const result = answerBlocks(`<quote lang="${language}" paragraph="p1">${quote}</quote>${explanation}<action>wait</action>`);
    assert.doesNotThrow(() => validateReadingSelectionAnswer(result.blocks, result.stray, selection, material));
  }
  const material = reading([{ id: "p1", text: "A real sentence." }, { id: "p2", text: "Another paragraph." }]);
  const selection = validateReadingSelection(material, { segments: [
    { paragraphId: "p1", start: 7, end: 15, quote: "sentence", prefix: "A real ", suffix: "." },
    { paragraphId: "p2", start: 0, end: 7, quote: "Another", prefix: "", suffix: " paragraph." },
  ] })!;
  const first = '<quote lang="en" paragraph="p1">sentence</quote>';
  const second = '<quote lang="en" paragraph="p2">Another</quote>';
  for (const [raw, passes] of [[first + second, true], [second + first, false], [first, false]] as const) {
    const result = answerBlocks(raw + explanation + '<action>wait</action>');
    if (passes) assert.doesNotThrow(() => validateReadingSelectionAnswer(result.blocks, result.stray, selection, material));
    else assert.throws(() => validateReadingSelectionAnswer(result.blocks, result.stray, selection, material), SelectionResponseError);
  }
});

test("selection validation rejects incomplete or unrelated output before saving an answer", () => {
  const material = reading([{ id: "p1", text: "incendiary devices" }]);
  const selection = validateReadingSelection(material, { segments: [{ paragraphId: "p1", start: 0, end: 10, quote: "incendiary", prefix: "", suffix: " devices" }] })!;
  const quote = '<quote lang="en" paragraph="p1">incendiary</quote>';
  for (const raw of [
    quote + '<action>wait</action>',
    quote.replace('lang="en"', 'lang="ja"') + explanation + '<action>wait</action>',
    quote.replace('paragraph="p1"', 'paragraph="p2"') + explanation + '<action>wait</action>',
    explanation + quote + '<action>wait</action>',
    quote + explanation + '<action>continue</action>',
    quote + explanation + '<action>wait</action>' + explanation,
    quote + explanation + '<analysis-note focus="structure">无关分析</analysis-note><action>wait</action>',
    quote + explanation.replace('</zh>', '') + '<action>wait</action>',
    quote + '<msg><zh>English only.</zh><ja>[calm] 日本語です。</ja></msg><action>wait</action>',
    quote + explanation.replace('这是形容词，此处表示用于引燃或纵火的，修饰后面的装置。', 'これは形容詞です。') + '<action>wait</action>',
    quote + explanation + '<action>wait',
    'extra output' + quote + explanation + '<action>wait</action>',
  ]) {
    const result = answerBlocks(raw);
    assert.throws(() => validateReadingSelectionAnswer(result.blocks, result.stray, selection, material), SelectionResponseError, raw);
  }
  const noSpeech = answerBlocks(quote + explanation.replace(/<ja>[\s\S]*?<\/ja>/, '<ja></ja>') + '<action>wait</action>');
  assert.doesNotThrow(() => validateReadingSelectionAnswer(noSpeech.blocks, noSpeech.stray, selection, material), "Speech repair is separate from selection regeneration");
  const mixedChat = answerBlocks(quote + explanation.replace('这是形容词', '「明らか」是形容词') + '<action>wait</action>');
  assert.throws(() => validateReadingSelectionAnswer(mixedChat.blocks, mixedChat.stray, selection, material),
    (error: unknown) => error instanceof SelectionResponseError && error.issue === 'explanation');
});
