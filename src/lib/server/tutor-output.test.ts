import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCoverage, recoverCoverage } from "./tutor-output";
import type { LLMConfig } from "./llm";

const cfg: LLMConfig = { provider: "openai", model: "gpt-5-test", apiKey: "test-only", baseUrl: "https://models.invalid/v1", reasoning: { kind: "effort", level: "high" } };
const first = "先通过等价变形，将未知数单独留在左边。";
const second = "再代回原方程检验所得结果是否成立。";
function response(text: string, finish = "stop") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

test("coverage recovery verifies and aggregates distinct quotes with the configured reasoning and budget", async () => {
  const previous = globalThis.fetch;
  try {
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return response(`<covered topic="skills">${first}</covered><covered topic="skills">${second}</covered>`);
    };
    const result = await recoverCoverage(cfg, {}, [first, second], new AbortController().signal, ["skills"]);
    assert.equal(result.status, "covered");
    assert.equal(result.coverage.skills, `${first}\n\n${second}`);
    assert.equal(request?.max_completion_tokens, 8192);
    assert.equal(request?.reasoning_effort, "high");
  } finally { globalThis.fetch = previous; }
});

test("invalid quotes and output failures never become missing teaching or partial evidence", async () => {
  const previous = globalThis.fetch;
  try {
    const cases = [
      { output: `<covered topic="skills">${first}${second}</covered>`, finish: "stop", code: "COVERAGE_EVIDENCE_INVALID" },
      { output: `<covered topic="skills">## 方法技巧\n${first}</covered>`, finish: "stop", code: "COVERAGE_EVIDENCE_INVALID" },
      { output: `<covered topic="skills">${first}</covered><covered topic="skills">伪造的另一段讲解内容。</covered>`, finish: "stop", code: "COVERAGE_EVIDENCE_INVALID" },
      { output: `<covered topic="skills">${first}`, finish: "stop", code: "COVERAGE_FORMAT_INVALID" },
      { output: "", finish: "length", code: "LLM_OUTPUT_TRUNCATED" },
    ];
    for (const item of cases) {
      globalThis.fetch = async () => response(item.output, item.finish);
      const result = await recoverCoverage(cfg, {}, [first, second], new AbortController().signal, ["skills"]);
      assert.equal(result.status, "check_failed");
      assert.equal(result.code, item.code);
      assert.deepEqual(result.coverage, {});
    }
    globalThis.fetch = async () => response("");
    assert.equal((await recoverCoverage(cfg, {}, [first], new AbortController().signal, ["skills"])).status, "missing");
  } finally { globalThis.fetch = previous; }
});

test("headings and completion declarations cannot count as teaching evidence", () => {
  for (const quote of ["## 核心知识点与方法总结", "这一题已经完整讲解。", "方法技巧"]) {
    assert.equal(acceptCoverage({}, "skills", quote, [quote]), false);
  }
});
