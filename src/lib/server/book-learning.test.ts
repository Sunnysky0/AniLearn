import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedPreviousMemories, allowsBookSummary, bookFoci, bookTurnHash, changeBookLearning, initialBookLearning } from "./book-learning";
import type { BookTurnRequest, ReaderUnit } from "@/lib/types";

test("book progress requires explicit reading, focus confirmation and chapter summary", () => {
  let state = initialBookLearning("thought"); assert.equal(state.phase, "free_reading"); assert.equal(state.readingConfirmedAt, null);
  assert.throws(() => changeBookLearning(state, "thought", "confirm_focus"));
  state = changeBookLearning(state, "thought", "start_analysis"); assert.ok(state.readingConfirmedAt);
  assert.equal(state.currentFocus, "concepts");
  for (const focus of bookFoci("thought")) { assert.equal(state.currentFocus, focus); state.analysisNotes[focus] = "结合原文讨论了这一角度。"; state = changeBookLearning(state, "thought", "confirm_focus"); }
  assert.throws(() => changeBookLearning(state, "thought", "complete_analysis")); state.summary = "本章整理了概念与论证。";
  assert.ok(changeBookLearning(state, "thought", "complete_analysis").completedAt);
});
test("summary and prior context respect explicit reading and book order", () => {
  const units: ReaderUnit[] = [0, 1, 2].map(order => ({ id: `c${order}`, title: `chapter${order}`, order, parentId: null, role: "main", blockCount: 3 }));
  const states = units.map(unit => ({ chapterId: unit.id, learning: { ...initialBookLearning("thought"), memory: `MEMORY${unit.id}` } }));
  states[2].learning.readingConfirmedAt = "now"; assert.deepEqual(allowedPreviousMemories(units, "c1", states), []);
  states[0].learning.readingConfirmedAt = "now"; assert.deepEqual(allowedPreviousMemories(units, "c1", states).map(memory => memory.chapterId), ["c0"]);
  assert.equal(allowsBookSummary(units, states), false); states[1].learning.readingConfirmedAt = "now";
  assert.equal(allowsBookSummary(units, states), true); assert.ok(states.every(state => !state.learning.completedAt));
});
test("turn hashes bind source, teaching state, selected text and explicit notes", () => {
  const body: BookTurnRequest = { requestId: "request-1", versionId: 1, chapterId: "c1", phase: "free_reading", stateRevision: 0 };
  const hash = bookTurnHash(body, "提问", []); assert.equal(bookTurnHash({ ...body, requestId: "request-2" }, "提问", []), hash);
  for (const changes of [{ versionId: 2 }, { chapterId: "c2" }, { stateRevision: 1 }, { noteIds: [3] }]) assert.notEqual(bookTurnHash({ ...body, ...changes }, "提问", []), hash);
});
