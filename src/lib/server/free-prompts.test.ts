import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFreeTutorMessages, buildFreeTutorSystem } from "./free-prompts";
import type { FreeMessageRow } from "./free-data";

function message(id: number, role: "user" | "tutor", topicId: number | null, content: string): FreeMessageRow {
  return {
    id, sessionId: 1, turnId: id, topicId, role, kind: "text", language: "zh-CN", content,
    speech: "", boardMode: null, attachments: [], createdAt: new Date(id * 1000),
  };
}

const tutor = { name: "导师", personality: "耐心", teachingStyle: "清楚", speakingStyle: "自然", voiceStyle: "", greeting: "" } as never;

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

test("a failed turn without a bound topic may select or create one on retry", () => {
  const prompt = buildFreeTutorSystem(tutor, { title: "自由提问", topicCount: 0, recovery: true });
  assert.match(prompt, /尚未绑定话题/);
  assert.match(prompt, /选择沿用或新建话题/);
  assert.doesNotMatch(prompt, /沿用当前话题继续/);
  assert.doesNotMatch(prompt, /不要新建话题/);
});

test("a partially saved turn stays on its already bound topic when retried", () => {
  const prompt = buildFreeTutorSystem(tutor, { title: "自由提问", topicTitle: "一次方程", topicCount: 1, recovery: true });
  assert.match(prompt, /沿用当前话题继续/);
  assert.match(prompt, /不要新建话题/);
});
