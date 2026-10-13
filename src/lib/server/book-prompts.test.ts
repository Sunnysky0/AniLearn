import test from "node:test";
import assert from "node:assert/strict";
import type { BookTurnRequest, ReaderDocument, TutorDTO } from "@/lib/types";
import { anchorAt } from "@/lib/reader/anchors";
import { bookQuoteAnchor, BookSelectionResponseError, bookTurnSystem, parseBookPreparation, validateBookSelectionAnswer } from "./book-prompts";
import { bookQuestionEvidence, initialBookLearning } from "./book-learning";
import { createTagParser } from "./protocol";

const document: ReaderDocument = { key: "book:2:version:3", title: "Current chapter", unitId: "c1", language: "en", units: [],
  blocks: Array.from({ length: 8 }, (_, index) => ({ id: `b${index}`, kind: "paragraph", anchorText: `CURRENT-${index} visible text`, nodes: [{ type: "text", text: `CURRENT-${index} visible text` }] })) };
const tutor: TutorDTO = { id: 1, name: "导师", avatar: "", tags: [], tagline: "", personality: "沉稳", teachingStyle: "启发", speakingStyle: "简洁", voiceId: "test", voiceName: "test", voiceStyle: "落ち着いた", greeting: "", isPreset: false };

test("free questions use the saved canonical reading position and only its neighbours", () => {
  const request: BookTurnRequest = { requestId: "request-123456789", versionId: 3, chapterId: "c1", phase: "free_reading", stateRevision: 0 };
  const evidence = bookQuestionEvidence(document, request, { documentKey: document.key, unitId: document.unitId, blockId: "b5", offset: 7, viewportOffset: 0 });
  assert.ok(evidence.includes("CURRENT-4")); assert.ok(evidence.includes("CURRENT-5")); assert.ok(evidence.includes("CURRENT-6"));
  assert.ok(!evidence.includes("CURRENT-0")); assert.ok(!evidence.includes("CURRENT-7"));
  const anchor = anchorAt(document, "b2", 0, 9)!;
  assert.ok(bookQuestionEvidence(document, { ...request, anchor }).includes("CURRENT-2"));
});

test("selection answer requires ordered exact targets, Chinese explanation and one terminal wait", () => {
  const anchor = anchorAt(document, "b2", 0, 9)!;
  const valid = `<quote lang="en" block="b2">CURRENT-2</quote><msg><zh>这句话强调此处的核心概念。</zh><ja>[落ち着いた] この部分を確認しましょう。</ja></msg><action>wait</action>`;
  const parse = (raw: string) => { const parser = createTagParser(["quote", "msg", "action", "analysis-note"]); return { blocks: [...parser.push(raw), ...parser.end()], stray: parser.stray() }; };
  const accepted = parse(valid); assert.doesNotThrow(() => validateBookSelectionAnswer(accepted.blocks, accepted.stray, document, anchor));
  for (const raw of [valid.replace("CURRENT-2", "CURRENT-3"), valid.replace('block="b2"', 'block="b3"'), valid.replace("<action>wait", "<action>continue"), valid + "outside", valid.replace("这句话强调此处的核心概念。", "この語は大切です。"), valid.replace("<msg>", '<analysis-note focus="theme">').replace("</msg>", "</analysis-note>")]) {
    const candidate = parse(raw); assert.throws(() => validateBookSelectionAnswer(candidate.blocks, candidate.stray, document, anchor), BookSelectionResponseError);
  }
});

test("ordinary quotes bind the current immutable chapter and visible canonical text", () => {
  const quote = { tag: "quote", attrs: { lang: "en", block: "b3" }, body: "CURRENT-3", closed: true };
  assert.equal(bookQuoteAnchor(document, quote)?.segments[0].quote, "CURRENT-3");
  assert.equal(bookQuoteAnchor(document, { ...quote, body: "FOREIGN-CHAPTER" }), null);
  assert.equal(bookQuoteAnchor(document, { ...quote, attrs: { lang: "ja", block: "b3" } }), null);
});

test("prep tags are complete, unique, and do not silently accept truncated output", () => {
  assert.equal(parseBookPreparation("<book-context>本章围绕概念展开。</book-context>", "book-context"), "本章围绕概念展开。");
  for (const raw of ["<book-context>没有结束", "prefix<book-context>内容</book-context>", "<book-context>内容</book-context><book-context>又一条</book-context>"]) assert.throws(() => parseBookPreparation(raw, "book-context"));
});

test("turn prompt stays in the requested chapter and never expands free reading into whole-chapter guidance", () => {
  const learning = initialBookLearning("thought");
  const request: BookTurnRequest = { requestId: "request-123456789", versionId: 3, chapterId: "c1", phase: "free_reading", stateRevision: 0 };
  const system = bookTurnSystem({ tutor, document, kind: "thought", learning, request, evidence: "CURRENT-EVIDENCE", context: "ANALYSIS-ONLY-CONTEXT", memories: [], notes: [], recovering: false });
  assert.ok(system.startsWith("[BOOK_TURN]")); assert.ok(system.includes("CURRENT-EVIDENCE"));
  assert.ok(!system.includes("ANALYSIS-ONLY-CONTEXT")); assert.ok(system.includes("只回答此问题，不主动讲章节"));
});
