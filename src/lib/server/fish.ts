import type { FishApiError } from "@/lib/types";
import { createProxyAgent, httpProxyPreview, normalizeHttpProxy } from "./http-proxy";

export function normalizeFishProxy(value: string): string {
  try {
    return normalizeHttpProxy(value);
  } catch {
    throw new Error("代理地址必须为有效的 HTTP/HTTPS 地址，例如 http://127.0.0.1:18081，不得包含路径、查询参数或片段。");
  }
}

export function fishProxyPreview(value: string): string {
  return httpProxyPreview(value);
}

export class FishRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status = 502, readonly upstreamStatus?: number) {
    super(message);
  }
}

function networkError(error: unknown, proxy: boolean): FishRequestError {
  const codes = new Set<string>();
  const seen = new Set<object>();
  let proxyStatus: number | undefined;
  function visit(value: unknown) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const e = value as { name?: string; code?: string; message?: string; cause?: unknown; errors?: unknown[] };
    if (e.code) codes.add(e.code);
    if (e.name) codes.add(e.name);
    const tunnel = e.message?.match(/Proxy response \((\d{3})\) !== 200|Proxy Authentication Required \((407)\)/);
    if (tunnel) proxyStatus = Number(tunnel[1] || tunnel[2]);
    visit(e.cause);
    if (Array.isArray(e.errors)) e.errors.forEach(visit);
  }
  visit(error);
  const target = proxy ? "代理服务器或 Fish Audio" : "Fish Audio";
  const hint = proxy ? "请检查代理地址、端口及代理软件是否运行。" : "请检查服务器网络，或在语音设置中配置代理地址。";
  if (proxy && proxyStatus === 407)
    return new FishRequestError("代理认证失败，请检查代理用户名和密码。", "FISH_PROXY_AUTH");
  if (proxy && proxyStatus)
    return new FishRequestError(`代理拒绝建立连接 (${proxyStatus})。请检查代理配置与访问权限。`, "FISH_PROXY_ERROR");
  if (codes.has("UND_ERR_CONNECT_TIMEOUT") || codes.has("ETIMEDOUT"))
    return new FishRequestError(`连接${target}超时。${hint}`, "FISH_CONNECT_TIMEOUT", 504);
  if (codes.has("TimeoutError") || codes.has("UND_ERR_HEADERS_TIMEOUT") || codes.has("UND_ERR_BODY_TIMEOUT"))
    return new FishRequestError("Fish Audio 请求超时，请稍后重试；课堂将继续显示文字。", "FISH_TIMEOUT", 504);
  if (codes.has("AbortError"))
    return new FishRequestError("Fish Audio 请求已取消。", "FISH_CANCELLED", 499);
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN"))
    return new FishRequestError(`无法解析${target}的地址。${hint}`, "FISH_DNS_ERROR");
  if (codes.has("ECONNREFUSED"))
    return new FishRequestError(`${target}拒绝连接。${hint}`, "FISH_CONNECTION_REFUSED");
  if ([...codes].some((code) => /CERT|TLS|SSL|SELF_SIGNED/.test(code)))
    return new FishRequestError("Fish Audio 或代理的 TLS 证书验证失败，请检查证书与系统时间。", "FISH_TLS_ERROR");
  return new FishRequestError(`无法连接${target}。${hint}`, "FISH_NETWORK_ERROR");
}

function redact(message: string, key: string, proxyUrl: string): string {
  const secrets = [key, proxyUrl];
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    secrets.push(url.username, url.password, decodeURIComponent(url.username), decodeURIComponent(url.password));
    if (url.username || url.password)
      secrets.push(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64"));
  }
  let safe = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join("[已隐藏]");
  return safe.replace(/(Bearer|Basic)\s+\S+/gi, "$1 [已隐藏]").replace(/\s+/g, " ").slice(0, 300);
}

async function httpError(response: Response, key: string, proxyUrl: string): Promise<FishRequestError> {
  const messages: Record<number, string> = {
    400: "请求参数或声音 ID 无效，请检查所选声音。",
    401: "API Key 无效或已过期，请检查密钥。",
    402: "账户余额不足，请前往 Fish Audio 充值，或选择账户可用的模型。",
    403: "当前密钥无权使用此模型或声音。",
    404: "模型或声音不存在，请检查模型名称和声音 ID。",
    407: "代理认证失败，请检查代理用户名和密码。",
    429: "请求过于频繁或超过并发限制，请稍后重试。",
  };
  const raw = await response.text();
  let detail = "";
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === "string") detail = redact(body.message, key, proxyUrl);
  } catch {
    // Edge gateways may return HTML; never expose that body to the client.
  }
  const message = messages[response.status] || (response.status >= 500
    ? "服务暂时不可用，请稍后重试。" : "请求失败，请检查模型与声音配置。");
  return new FishRequestError(`Fish Audio (${response.status})：${message}${detail ? ` ${detail}` : ""}`,
    `FISH_HTTP_${response.status}`, 502, response.status);
}

// Keep the dispatcher alive until the response body is consumed, including on cancellation.
export async function fishRequest<T>(
  path: string,
  config: { key: string; proxyUrl: string },
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  let agent: ReturnType<typeof createProxyAgent> | undefined;
  try {
    if (config.proxyUrl) agent = createProxyAgent(config.proxyUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.key}`);
    const options: RequestInit & { dispatcher?: ReturnType<typeof createProxyAgent> } = {
      ...init, headers, cache: "no-store", ...(agent ? { dispatcher: agent } : {}),
    };
    const response = await fetch(`https://api.fish.audio${path}`, options);
    if (!response.ok) throw await httpError(response, config.key, config.proxyUrl);
    return await read(response);
  } catch (error) {
    if (error instanceof FishRequestError) throw error;
    if (error instanceof SyntaxError)
      throw new FishRequestError("Fish Audio 返回了无法解析的响应，请稍后重试。", "FISH_INVALID_RESPONSE");
    if (init.signal?.aborted && init.signal.reason?.name === "AbortError")
      throw new FishRequestError("Fish Audio 请求已取消。", "FISH_CANCELLED", 499);
    if (init.signal?.aborted && init.signal.reason?.name === "TimeoutError")
      throw networkError(init.signal.reason, !!config.proxyUrl);
    throw networkError(error, !!config.proxyUrl);
  } finally {
    await agent?.destroy().catch(() => {});
  }
}

export function fishErrorResponse(error: unknown): Response {
  const e = error instanceof FishRequestError ? error : networkError(error, false);
  const body: FishApiError = { error: e.message, code: e.code, ...(e.upstreamStatus ? { upstreamStatus: e.upstreamStatus } : {}) };
  return Response.json(body,
    { status: e.status });
}
