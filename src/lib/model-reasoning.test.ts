import assert from "node:assert/strict";
import { test } from "node:test";
import { reasoningControl, reasoningError, reasoningEfforts } from "./model-reasoning";

test("reasoning controls follow provider and Gemini model families", () => {
  assert.equal(reasoningControl("openai-compatible", "custom-model"), "effort");
  assert.equal(reasoningControl("gemini", "models/gemini-2.5-pro"), "budget");
  assert.equal(reasoningControl("gemini", "gemini-3-pro-preview"), "effort");
  assert.equal(reasoningControl("gemini", "gemini-2.0-flash"), "unsupported");
  assert.deepEqual(reasoningEfforts("xai"), ["low", "medium", "high", "xhigh"]);
});

test("reasoning validation accepts defaults and provider-native levels", () => {
  assert.equal(reasoningError(undefined, "openai", "gpt-5"), null);
  assert.equal(reasoningError({ kind: "effort", level: "minimal" }, "openai", "gpt-5"), null);
  assert.equal(reasoningError({ kind: "effort", level: "high" }, "openai-compatible", "custom"), null);
  assert.equal(reasoningError({ kind: "effort", level: "max" }, "anthropic", "claude-opus-5-5"), null);
  assert.equal(reasoningError({ kind: "effort", level: "medium" }, "gemini", "gemini-3-pro-preview"), null);
  assert.match(reasoningError({ kind: "effort", level: "none" }, "xai", "grok-4.7") ?? "", /无效/);
  assert.equal(reasoningError({ kind: "effort", level: "xhigh" }, "xai", "grok-4.5"), null);
  assert.match(reasoningError({ kind: "budget", tokens: 128 }, "openai", "gpt-5") ?? "", /Gemini 2.5/);
  assert.match(reasoningError({ kind: "effort", level: "low" }, "gemini", "gemini-2.5-pro") ?? "", /不支持/);
});

test("Gemini 2.5 budgets use each known model's documented range", () => {
  for (const tokens of [-1, 128, 32768])
    assert.equal(reasoningError({ kind: "budget", tokens }, "gemini", "gemini-2.5-pro"), null);
  assert.match(reasoningError({ kind: "budget", tokens: 0 }, "gemini", "gemini-2.5-pro") ?? "", /128/);
  assert.match(reasoningError({ kind: "budget", tokens: 32769 }, "gemini", "gemini-2.5-pro") ?? "", /32768/);
  for (const tokens of [-1, 0, 1, 24576])
    assert.equal(reasoningError({ kind: "budget", tokens }, "gemini", "gemini-2.5-flash"), null);
  for (const tokens of [-1, 0, 512, 24576])
    assert.equal(reasoningError({ kind: "budget", tokens }, "gemini", "gemini-2.5-flash-lite"), null);
  assert.match(reasoningError({ kind: "budget", tokens: 511 }, "gemini", "gemini-2.5-flash-lite") ?? "", /512/);
  assert.match(reasoningError({ kind: "budget", tokens: 1.5 }, "gemini", "gemini-2.5-flash") ?? "", /整数/);
  assert.match(reasoningError({ kind: "budget", tokens: NaN }, "gemini", "gemini-2.5-flash") ?? "", /整数/);
  assert.match(reasoningError({ kind: "budget", tokens: 1, extra: true }, "gemini", "gemini-2.5-flash") ?? "", /整数/);
});

test("unknown Gemini 2.5 budgets defer ranges to the provider and cannot disable thinking", () => {
  assert.equal(reasoningError({ kind: "budget", tokens: -1 }, "gemini", "gemini-2.5-custom"), null);
  assert.equal(reasoningError({ kind: "budget", tokens: 32768 }, "gemini", "gemini-2.5-custom"), null);
  assert.match(reasoningError({ kind: "budget", tokens: 0 }, "gemini", "gemini-2.5-custom") ?? "", /正整数/);
  assert.match(reasoningError({ kind: "budget", tokens: Number.MAX_SAFE_INTEGER + 1 }, "gemini", "gemini-2.5-custom") ?? "", /整数/);
});
