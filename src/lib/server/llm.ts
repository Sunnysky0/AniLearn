// Unified streaming client for OpenAI / Anthropic / Grok (xAI) / Gemini.
// Uses raw fetch + SSE parsing so no vendor SDKs are required.
import type { ProviderId } from "@/lib/types";

export type LLMPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string };

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMPart[];
}

export interface LLMConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ChatOptions {
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

const LABEL: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "Grok (xAI)",
  gemini: "Gemini",
};

const BASE: Record<ProviderId, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

interface NormMessage {
  role: "user" | "assistant";
  parts: LLMPart[];
}

function toParts(c: LLMMessage["content"]): LLMPart[] {
  const parts: LLMPart[] = typeof c === "string" ? [{ type: "text", text: c }] : c;
  return parts.filter((p) => p.type === "image" || p.text.trim().length > 0);
}

/** Merge consecutive roles, make sure the conversation starts with a user turn. */
function normalize(messages: LLMMessage[]): NormMessage[] {
  const out: NormMessage[] = [];
  for (const m of messages) {
    let parts = toParts(m.content);
    if (m.role === "assistant") {
      const t = parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      parts = t ? [{ type: "text", text: t }] : [];
    }
    if (!parts.length) parts = [{ type: "text", text: m.role === "user" ? "（继续）" : "……" }];
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts.push(...parts);
    else out.push({ role: m.role, parts: [...parts] });
  }
  if (!out.length || out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ type: "text", text: "（开始）" }] });
  }
  return out;
}

function joinText(parts: LLMPart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

async function* sse(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function checkFinish(reason?: string | null) {
  if (!reason || ["stop", "end_turn", "stop_sequence", "STOP"].includes(reason)) return;
  if (["length", "max_tokens", "MAX_TOKENS"].includes(reason)) {
    throw new Error("模型输出达到长度上限，内容未完成，请重试或更换模型。");
  }
  throw new Error(`模型未正常完成输出（${reason}），请重试。`);
}

function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const obj = Array.isArray(j) ? j[0] : j;
    return obj?.error?.message || obj?.message || obj?.error || raw;
  } catch {
    return raw;
  }
}

async function ensureOk(res: Response, provider: ProviderId) {
  if (res.ok) return;
  const raw = await res.text().catch(() => "");
  const msg = String(extractError(raw) || res.statusText).slice(0, 600);
  throw new Error(`${LABEL[provider]} 接口错误 (${res.status})：${msg}`);
}

function baseOf(cfg: LLMConfig) {
  return (cfg.baseUrl?.trim() || BASE[cfg.provider]).replace(/\/+$/, "");
}

// ---------------- OpenAI-compatible (OpenAI, xAI) ----------------
async function* streamOpenAICompat(cfg: LLMConfig, opts: ChatOptions): AsyncGenerator<string> {
  const msgs = normalize(opts.messages).map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: joinText(m.parts) };
    const hasImage = m.parts.some((p) => p.type === "image");
    if (!hasImage) return { role: "user", content: joinText(m.parts) };
    return {
      role: "user",
      content: m.parts.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}`, detail: "high" } },
      ),
    };
  });
  const res = await fetch(`${baseOf(cfg)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: opts.system }, ...msgs],
      stream: true,
      ...(cfg.provider === "openai" && /^(?:gpt-5|o\d)/.test(cfg.model)
        ? { max_completion_tokens: opts.maxTokens ?? 8192 }
        : { max_tokens: opts.maxTokens ?? 8192 }),
    }),
    signal: opts.signal,
  });
  await ensureOk(res, cfg.provider);
  let finished = false;
  for await (const ev of sse(res)) {
    if (ev.data === "[DONE]") { finished = true; break; }
    let j: {
      error?: { message?: string };
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
    };
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.error) throw new Error(`${LABEL[cfg.provider]}：${j.error.message || "stream error"}`);
    const delta = j.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) yield delta;
    const reason = j.choices?.[0]?.finish_reason;
    checkFinish(reason);
    if (reason) finished = true;
  }
  if (!finished) throw new Error("模型连接提前断开，输出未完成，请重试。");
}

// ---------------- Anthropic ----------------
async function* streamAnthropic(cfg: LLMConfig, opts: ChatOptions): AsyncGenerator<string> {
  const base = baseOf(cfg);
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const messages = normalize(opts.messages).map((m) => ({
    role: m.role,
    content: m.parts.map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } },
    ),
  }));
  const doFetch = (maxTokens: number) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system: opts.system,
        messages,
        stream: true,
      }),
      signal: opts.signal,
    });
  const max = opts.maxTokens ?? 8192;
  let res = await doFetch(max);
  if (res.status === 400 && max > 8192) {
    const t = await res.clone().text().catch(() => "");
    if (/max_tokens/i.test(t)) res = await doFetch(8192);
  }
  await ensureOk(res, "anthropic");
  let finished = false;
  for await (const ev of sse(res)) {
    let j: {
      type?: string;
      delta?: { type?: string; text?: string; stop_reason?: string | null };
      error?: { message?: string };
    };
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) {
      yield j.delta.text;
    } else if (j.type === "error") {
      throw new Error(`Anthropic：${j.error?.message || "stream error"}`);
    } else if (j.type === "message_stop") {
      finished = true;
      break;
    } else if (j.type === "message_delta") {
      checkFinish(j.delta?.stop_reason);
    }
  }
  if (!finished) throw new Error("模型连接提前断开，输出未完成，请重试。");
}

// ---------------- Gemini ----------------
async function* streamGemini(cfg: LLMConfig, opts: ChatOptions): AsyncGenerator<string> {
  const root = baseOf(cfg).replace(/\/v1(beta)?$/, "");
  const model = cfg.model.replace(/^models\//, "");
  const url = `${root}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const contents = normalize(opts.messages).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts.map((p) =>
      p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } },
    ),
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 8192 },
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "gemini");
  let finished = false;
  for await (const ev of sse(res)) {
    let j: {
      error?: { message?: string };
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.error) throw new Error(`Gemini：${j.error.message || "stream error"}`);
    if (j.promptFeedback?.blockReason) throw new Error("Gemini 拒绝了本次输入，请检查材料或更换模型。");
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (p.text && !p.thought) yield p.text;
    }
    const reason = j.candidates?.[0]?.finishReason;
    checkFinish(reason);
    if (reason) finished = true;
  }
  if (!finished) throw new Error("模型连接提前断开，输出未完成，请重试。");
}

export async function* streamChat(cfg: LLMConfig, opts: ChatOptions): AsyncGenerator<string> {
  const options = { ...opts, signal: AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(180_000),
  ]) };
  switch (cfg.provider) {
    case "anthropic":
      yield* streamAnthropic(cfg, options);
      break;
    case "gemini":
      yield* streamGemini(cfg, options);
      break;
    case "openai":
    case "xai":
    default:
      yield* streamOpenAICompat(cfg, options);
  }
}

export async function complete(cfg: LLMConfig, opts: ChatOptions): Promise<string> {
  let out = "";
  for await (const d of streamChat(cfg, opts)) out += d;
  return out;
}

export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (!m) return null;
  return { mime: m[1], data: m[2] };
}
