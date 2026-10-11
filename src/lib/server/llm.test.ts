import assert from "node:assert/strict";
import { test } from "node:test";
import { ProxyAgent } from "undici";
import { complete, LLMRequestError, streamChat } from "./llm";

const encoder = new TextEncoder();
const config = (provider: "openai" | "xai" | "anthropic" | "gemini", proxyUrl?: string) => ({
  provider, model: "audit-model", apiKey: "do-not-log-api-key", baseUrl: "https://models.invalid/v1", connectionId: "audit-connection", proxyUrl,
});

function responseFor(provider: "openai" | "xai" | "anthropic" | "gemini") {
  const chunks = provider === "anthropic"
    ? [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    : provider === "gemini"
      ? [
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
      ]
      : [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(encoder.encode(chunks[index++]));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

test("all provider adapters use the configured proxy until their SSE response is fully read", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const provider of ["openai", "xai", "anthropic", "gemini"] as const) {
      let dispatcher: ProxyAgent | undefined;
      let destroyCount = 0;
      globalThis.fetch = async (_input, init) => {
        dispatcher = (init as RequestInit & { dispatcher?: ProxyAgent }).dispatcher;
        assert.ok(dispatcher instanceof ProxyAgent, `${provider} request should use ProxyAgent`);
        const destroy = dispatcher.destroy.bind(dispatcher);
        dispatcher.destroy = ((...args: Parameters<ProxyAgent["destroy"]>) => {
          destroyCount++;
          return destroy(...args);
        }) as ProxyAgent["destroy"];
        return responseFor(provider);
      };
      assert.equal(await complete(config(provider, "http://proxy-user:proxy-password@127.0.0.1:18081"), {
        system: "system", messages: [{ role: "user", content: "question" }], stage: "proxy-test",
      }), "ok");
      assert.ok(dispatcher instanceof ProxyAgent);
      assert.ok(destroyCount >= 1, `${provider} dispatcher should be destroyed after body consumption`);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("cancelling a model stream cancels its reader and releases its proxy", async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  let destroyCount = 0;
  try {
    globalThis.fetch = async (_input, init) => {
      const dispatcher = (init as RequestInit & { dispatcher?: ProxyAgent }).dispatcher;
      assert.ok(dispatcher instanceof ProxyAgent);
      const destroy = dispatcher.destroy.bind(dispatcher);
      dispatcher.destroy = ((...args: Parameters<ProxyAgent["destroy"]>) => {
        destroyCount++;
        return destroy(...args);
      }) as ProxyAgent["destroy"];
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
        },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    };
    const iterator = streamChat(config("openai", "http://127.0.0.1:18081"), {
      system: "system", messages: [{ role: "user", content: "question" }],
    })[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { done: false, value: "first" });
    await iterator.return?.(undefined);
    assert.equal(cancelled, true);
    assert.ok(destroyCount >= 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("network failures retain stable safe error codes", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const cases = [
      { code: "ENOTFOUND", expected: "LLM_DNS_ERROR" },
      { code: "UND_ERR_CONNECT_TIMEOUT", expected: "LLM_CONNECT_TIMEOUT" },
      { code: "CERT_HAS_EXPIRED", expected: "LLM_TLS_ERROR" },
    ] as const;
    for (const item of cases) {
      globalThis.fetch = async () => {
        const cause = Object.assign(new Error("upstream diagnostic with do-not-log-api-key"), { code: item.code });
        throw new TypeError("fetch failed", { cause });
      };
      await assert.rejects(
        complete(config("gemini"), { system: "system", messages: [{ role: "user", content: "private prompt" }] }),
        (error: unknown) => error instanceof LLMRequestError && error.code === item.expected &&
          /DNS|超时|TLS/.test(error.message) && !error.message.includes("do-not-log-api-key") &&
          !error.message.includes("private prompt"),
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("proxy authentication, stream interruption, and truncation are reported distinctly", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("proxy auth required", { status: 407 });
    await assert.rejects(
      complete(config("gemini", "http://127.0.0.1:18081"), { system: "", messages: [] }),
      (error: unknown) => error instanceof LLMRequestError && error.code === "LLM_PROXY_AUTH" && /代理认证失败/.test(error.message),
    );

    globalThis.fetch = async () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    await assert.rejects(
      complete(config("openai"), { system: "", messages: [] }),
      (error: unknown) => error instanceof LLMRequestError && error.code === "LLM_STREAM_INTERRUPTED",
    );

    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
    await assert.rejects(
      complete(config("openai"), { system: "", messages: [] }),
      (error: unknown) => error instanceof LLMRequestError && error.code === "LLM_OUTPUT_TRUNCATED",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("requests without a proxy continue to use direct fetch", async () => {
  const previousFetch = globalThis.fetch;
  let dispatcher: unknown;
  try {
    globalThis.fetch = async (_input, init) => {
      dispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      return responseFor("openai");
    };
    await complete(config("openai"), { system: "", messages: [] });
    assert.equal(dispatcher, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
