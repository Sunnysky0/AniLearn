import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTurnHash, initialFreeTitle, readFreeTurnRequest } from "./free-input";

const id = "request-000000000001";
const request = (value: unknown) => new Request("http://localhost/api/free-sessions/1/turn", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

test("free turn accepts text and bounded images without truncating student input", async () => {
  const image = `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`;
  const parsed = await readFreeTurnRequest(request({ requestId: id, text: "  问题  ", images: [image] }));
  assert.equal(parsed.text, "问题");
  assert.deepEqual(parsed.images, [image]);
  await assert.rejects(readFreeTurnRequest(request({ requestId: id, text: "x".repeat(4001) })), /最多 4000/);
  await assert.rejects(readFreeTurnRequest(request({ requestId: id, images: Array(5).fill(image) })), /最多附加 4 张/);
  await assert.rejects(readFreeTurnRequest(request({ requestId: id, images: ["data:image/png;base64,!!!!"] })), /图片/);
});

test("stable request fingerprints detect changed payloads and generated titles stay local", () => {
  const first = { requestId: id, text: "怎样解方程？", topicId: null };
  assert.equal(freeTurnHash(first), freeTurnHash({ ...first }));
  assert.notEqual(freeTurnHash(first), freeTurnHash({ ...first, text: "换一个问题" }));
  assert.equal(initialFreeTitle("  求解   一元二次方程  ", []), "求解 一元二次方程");
  assert.equal(Array.from(initialFreeTitle("字".repeat(80), [])).length, 32);
  assert.equal(initialFreeTitle("", ["data:image/jpeg;base64,AA=="]), "图片提问");
});
