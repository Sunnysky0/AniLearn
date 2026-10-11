import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFreeTutorMessages } from "./free-prompts";
import type { FreeMessageRow } from "./free-data";

function message(id: number, role: "user" | "tutor", topicId: number | null, content: string): FreeMessageRow {
  return {
    id, sessionId: 1, turnId: id, topicId, role, kind: "text", language: "zh-CN", content,
    speech: "", boardMode: null, attachments: [], createdAt: new Date(id * 1000),
  };
}

test("context keeps the current question and prioritizes its topic inside the 60,000-character budget", () => {
  const history: FreeMessageRow[] = [message(1, "tutor", 2, "KEEP_CURRENT_TOPIC")];
  for (let index = 1; index < 60; index++) {
    history.push(message(index + 1, index % 2 ? "user" : "tutor", 1, `${index === 1 ? "DROP_OLD_TOPIC" : "RECENT"}_${index}_${"x".repeat(1400)}`));
  }
  history.push(message(61, "user", 1, "LATEST_INPUT"));
  const output = buildFreeTutorMessages(history, [], { currentImages: [], recovering: false, currentTopicId: 2 });
  const packed = JSON.stringify(output);
  assert.match(packed, /KEEP_CURRENT_TOPIC/);
  assert.match(packed, /LATEST_INPUT/);
  assert.doesNotMatch(packed, /DROP_OLD_TOPIC/);
  assert.ok(packed.length < 70_000);
});
