// Unified streaming client for OpenAI / Anthropic / Grok (xAI) / Gemini.
// Uses raw fetch + SSE parsing so no vendor SDKs are required.
import type { ProviderId } from "@/lib/types";
import { createProxyAgent } from "./http-proxy";

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
  connectionId?: string;
  proxyUrl?: string;
}

export interface ChatOptions {
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** A safe diagnostic label; never include prompt or user data. */
  stage?: string;
}

export type LLMErrorCode =
  | "LLM_DNS_ERROR"
  | "LLM_CONNECT_TIMEOUT"
  | "LLM_TIMEOUT"
  | "LLM_TURN_TIMEOUT"
  | "LLM_PROXY_AUTH"
  | "LLM_PROXY_ERROR"
  | "LLM_PROXY_INVALID"
  | "LLM_TLS_ERROR"
  | "LLM_CONNECTION_REFUSED"
  | "LLM_CONNECTION_RESET"
  | "LLM_NETWORK_ERROR"
  | "LLM_STREAM_INTERRUPTED"
  | "LLM_OUTPUT_TRUNCATED"
  | "LLM_CANCELLED"
  | "LLM_AUTH_ERROR"
  | "LLM_PERMISSION_ERROR"
  | "LLM_MODEL_NOT_FOUND"
  | "LLM_RATE_LIMITED"
  | "LLM_UPSTREAM_ERROR"
  | "LLM_REQUEST_FAILED";

export class LLMRequestError extends Error {
  constructor(message: string, readonly code: LLMErrorCode, readonly upstreamStatus?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LLMRequestError";
  }
}

interface InternalChatOptions extends ChatOptions {
  dispatcher?: ReturnType<typeof createProxyAgent>;
}

type ProxyRequestInit = RequestInit & { dispatcher?: ReturnType<typeof createProxyAgent> };

function requestInit(init: RequestInit, opts: InternalChatOptions): ProxyRequestInit {
  return { ...init, cache: "no-store", ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) };
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
    throw new LLMRequestError("模型输出达到长度上限，内容未完成，请重试或更换模型。", "LLM_OUTPUT_TRUNCATED");
  }
  throw new LLMRequestError("模型未能正常完成输出，请检查服务状态后重试。", "LLM_UPSTREAM_ERROR");
}

function errorCauses(error: unknown) {
  const codes = new Set<string>();
  const names = new Set<string>();
  let proxyStatus: number | undefined;
  const seen = new Set<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const cause = value as { name?: string; code?: string | number; message?: string; cause?: unknown; errors?: unknown[] };
    if (cause.code !== undefined) codes.add(String(cause.code));
    if (cause.name) names.add(cause.name);
    const tunnel = cause.message?.match(/Proxy response \((\d{3})\) !== 200|Proxy Authentication Required \((407)\)/i);
    if (tunnel) proxyStatus = Number(tunnel[1] || tunnel[2]);
    visit(cause.cause);
    if (Array.isArray(cause.errors)) cause.errors.forEach(visit);
  };
  visit(error);
  return { codes, names, proxyStatus };
}

function networkError(error: unknown, cfg: LLMConfig, signal?: AbortSignal): LLMRequestError {
  if (error instanceof LLMRequestError) return error;
  const reason = signal?.aborted ? signal.reason as { name?: string; message?: string } | undefined : undefined;
  if (reason?.message?.includes("讲解超过 270 秒"))
    return new LLMRequestError(reason.message, "LLM_TURN_TIMEOUT", undefined, error);
  if (reason?.name === "TimeoutError")
    return new LLMRequestError("模型请求超时，请稍后重试；如果反复超时，请检查服务状态或连接网络。", "LLM_TIMEOUT", undefined, error);
  if (signal?.aborted)
    return new LLMRequestError("本轮模型请求已取消。", "LLM_CANCELLED", undefined, error);

  const cause = errorCauses(error);
  if (cfg.proxyUrl && cause.proxyStatus === 407)
    return new LLMRequestError("模型代理认证失败，请检查代理地址、用户名和密码。", "LLM_PROXY_AUTH", 407, error);
  if (cfg.proxyUrl && cause.proxyStatus)
    return new LLMRequestError(`模型代理拒绝连接 (${cause.proxyStatus})，请检查代理配置和访问权限。`, "LLM_PROXY_ERROR", cause.proxyStatus, error);
  if (cause.codes.has("UND_ERR_CONNECT_TIMEOUT") || cause.codes.has("ETIMEDOUT"))
    return new LLMRequestError("连接模型服务超时，请检查服务状态，或确认模型连接代理正在运行。", "LLM_CONNECT_TIMEOUT", undefined, error);
  if (cause.names.has("TimeoutError") || cause.codes.has("UND_ERR_HEADERS_TIMEOUT") || cause.codes.has("UND_ERR_BODY_TIMEOUT"))
    return new LLMRequestError("模型请求超时，请稍后重试。", "LLM_TIMEOUT", undefined, error);
  if (cause.codes.has("ENOTFOUND") || cause.codes.has("EAI_AGAIN"))
    return new LLMRequestError("无法解析模型服务或代理地址（DNS），请检查服务器网络和此连接的代理设置。", "LLM_DNS_ERROR", undefined, error);
  if ([...cause.codes].some((code) => /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)))
    return new LLMRequestError("模型服务或代理的 TLS 证书验证失败，请检查证书和系统时间。", "LLM_TLS_ERROR", undefined, error);
  if (cause.codes.has("ECONNREFUSED"))
    return new LLMRequestError("模型服务拒绝连接，请检查地址、端口和代理运行状态。", "LLM_CONNECTION_REFUSED", undefined, error);
  if (cause.codes.has("ECONNRESET"))
    return new LLMRequestError("模型服务连接中断，请检查网络后重试。", "LLM_CONNECTION_RESET", undefined, error);
  if (cause.codes.has("UND_ERR_SOCKET") || (error instanceof TypeError && /terminated|stream/i.test(error.message)))
    return new LLMRequestError("模型响应流意外中断，请检查网络后重试。", "LLM_STREAM_INTERRUPTED", undefined, error);
  return new LLMRequestError("无法连接模型服务，请检查服务商地址、服务器网络和代理设置。", "LLM_NETWORK_ERROR", undefined, error);
}

function normalizeStreamError(error: unknown, cfg: LLMConfig, signal: AbortSignal): LLMRequestError {
  if (error instanceof LLMRequestError) return error;
  const causes = errorCauses(error);
  const hasNetworkCause = [...causes.codes].some((code) =>
    /^(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|CERT.*|TLS.*|SSL.*|SELF_SIGNED.*|UNABLE_TO_VERIFY.*|UND_ERR_.*)$/.test(code),
  );
  if (signal.aborted || error instanceof TypeError || hasNetworkCause) return networkError(error, cfg, signal);
  if (error instanceof SyntaxError)
    return new LLMRequestError("模型服务返回了无法解析的响应，请稍后重试。", "LLM_REQUEST_FAILED", undefined, error);
  return new LLMRequestError("模型服务在生成过程中返回错误，请检查连接设置或稍后重试。", "LLM_UPSTREAM_ERROR", undefined, error);
}

function redactErrorText(message: string, cfg: LLMConfig): string {
  const secrets = [cfg.apiKey, cfg.proxyUrl ?? ""];
  if (cfg.proxyUrl) {
    try {
      const proxy = new URL(cfg.proxyUrl);
      const username = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      secrets.push(proxy.username, proxy.password, username, password);
      if (username || password) secrets.push(Buffer.from(`${username}:${password}`).toString("base64"));
    } catch { /* Invalid proxy settings are reported without the URL. */ }
  }
  let safe = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join("[已隐藏]");
  return safe.replace(/(Bearer|Basic)\s+\S+/gi, "$1 [已隐藏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/\s+/g, " ").slice(0, 300);
}

function extractError(raw: string): string | null {
  try {
    const j = JSON.parse(raw);
    const obj = Array.isArray(j) ? j[0] : j;
    const detail = obj?.error?.message ?? obj?.message ?? obj?.error;
    return typeof detail === "string" ? detail : null;
  } catch {
    return null;
  }
}

async function ensureOk(res: Response, cfg: LLMConfig) {
  if (res.ok) return;
  const raw = await res.text().catch(() => "");
  const detail = raw ? extractError(raw) : null;
  const safeDetail = detail ? redactErrorText(detail, cfg) : "";
  let code: LLMErrorCode = "LLM_UPSTREAM_ERROR";
  let message = "接口暂时不可用，请稍后重试。";
  if (cfg.proxyUrl && res.status === 407) {
    code = "LLM_PROXY_AUTH";
    message = "模型代理认证失败，请检查代理地址、用户名和密码。";
  } else if (res.status === 401) {
    code = "LLM_AUTH_ERROR";
    message = "API Key 无效或已过期，请检查模型连接的密钥。";
  } else if (res.status === 403) {
    code = "LLM_PERMISSION_ERROR";
    message = "当前密钥没有使用此模型的权限，请检查服务商配置。";
  } else if (res.status === 404) {
    code = "LLM_MODEL_NOT_FOUND";
    message = "模型服务地址或模型名称不存在，请检查连接设置。";
  } else if (res.status === 429) {
    code = "LLM_RATE_LIMITED";
    message = "模型请求过于频繁或达到用量限制，请稍后重试。";
  } else if (res.status === 400) {
    message = "模型服务拒绝了本次请求，请检查模型名称和请求格式。";
  } else if (res.status < 500) {
    message = "模型服务拒绝了本次请求，请检查连接设置。";
  }
  throw new LLMRequestError(`${LABEL[cfg.provider]} 接口错误 (${res.status})：${message}${safeDetail ? ` ${safeDetail}` : ""}`, code, res.status);
}

function baseOf(cfg: LLMConfig) {
  return (cfg.baseUrl?.trim() || BASE[cfg.provider]).replace(/\/+$/, "");
}

// ---------------- OpenAI-compatible (OpenAI, xAI) ----------------
async function* streamOpenAICompat(cfg: LLMConfig, opts: InternalChatOptions): AsyncGenerator<string> {
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
  const res = await fetch(`${baseOf(cfg)}/chat/completions`, requestInit({
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
  }, opts));
  await ensureOk(res, cfg);
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
    if (j.error) throw new LLMRequestError("模型服务在生成过程中返回错误，请检查连接设置或稍后重试。", "LLM_UPSTREAM_ERROR");
    const delta = j.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) yield delta;
    const reason = j.choices?.[0]?.finish_reason;
    checkFinish(reason);
    if (reason) finished = true;
  }
  if (!finished) throw new LLMRequestError("模型连接提前断开，输出未完成，请重试。", "LLM_STREAM_INTERRUPTED");
}

// ---------------- Anthropic ----------------
async function* streamAnthropic(cfg: LLMConfig, opts: InternalChatOptions): AsyncGenerator<string> {
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
    fetch(url, requestInit({
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
    }, opts));
  const max = opts.maxTokens ?? 8192;
  let res = await doFetch(max);
  if (res.status === 400 && max > 8192) {
    const t = await res.clone().text().catch(() => "");
    if (/max_tokens/i.test(t)) res = await doFetch(8192);
  }
  await ensureOk(res, cfg);
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
      throw new LLMRequestError("模型服务在生成过程中返回错误，请检查连接设置或稍后重试。", "LLM_UPSTREAM_ERROR");
    } else if (j.type === "message_stop") {
      finished = true;
      break;
    } else if (j.type === "message_delta") {
      checkFinish(j.delta?.stop_reason);
    }
  }
  if (!finished) throw new LLMRequestError("模型连接提前断开，输出未完成，请重试。", "LLM_STREAM_INTERRUPTED");
}

// ---------------- Gemini ----------------
async function* streamGemini(cfg: LLMConfig, opts: InternalChatOptions): AsyncGenerator<string> {
  const root = baseOf(cfg).replace(/\/v1(beta)?$/, "");
  const model = cfg.model.replace(/^models\//, "");
  const url = `${root}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const contents = normalize(opts.messages).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts.map((p) =>
      p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } },
    ),
  }));
  const res = await fetch(url, requestInit({
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 8192 },
    }),
    signal: opts.signal,
  }, opts));
  await ensureOk(res, cfg);
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
    if (j.error) throw new LLMRequestError("Gemini 服务在生成过程中返回错误，请检查连接设置或稍后重试。", "LLM_UPSTREAM_ERROR");
    if (j.promptFeedback?.blockReason) throw new LLMRequestError("Gemini 拒绝了本次输入，请检查材料或更换模型。", "LLM_UPSTREAM_ERROR");
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (p.text && !p.thought) yield p.text;
    }
    const reason = j.candidates?.[0]?.finishReason;
    checkFinish(reason);
    if (reason) finished = true;
  }
  if (!finished) throw new LLMRequestError("模型连接提前断开，输出未完成，请重试。", "LLM_STREAM_INTERRUPTED");
}

export async function* streamChat(cfg: LLMConfig, opts: ChatOptions): AsyncGenerator<string> {
  const startedAt = Date.now();
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(180_000),
  ]);
  let dispatcher: ReturnType<typeof createProxyAgent> | undefined;
  const options: InternalChatOptions = { ...opts, signal };
  try {
    if (cfg.proxyUrl) {
      try { dispatcher = createProxyAgent(cfg.proxyUrl); }
      catch (error) { throw new LLMRequestError("模型代理地址无效，请检查此连接的代理设置。", "LLM_PROXY_INVALID", undefined, error); }
      options.dispatcher = dispatcher;
    }
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
  } catch (error) {
    const normalized = normalizeStreamError(error, cfg, signal);
    console.error("LLM request failed", JSON.stringify({
      connectionId: cfg.connectionId ?? "unknown",
      model: cfg.model,
      stage: opts.stage ?? "unspecified",
      elapsedMs: Date.now() - startedAt,
      code: normalized.code,
      ...(normalized.upstreamStatus ? { upstreamStatus: normalized.upstreamStatus } : {}),
    }));
    throw normalized;
  } finally {
    await dispatcher?.destroy().catch(() => undefined);
  }
}

export async function complete(cfg: LLMConfig, opts: ChatOptions): Promise<string> {
  let out = "";
  for await (const d of streamChat(cfg, opts)) out += d;
  return out;
}

export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!m) return null;
  return { mime: m[1], data: m[2] };
}
