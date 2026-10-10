import { ProxyAgent } from "undici";

export function normalizeHttpProxy(value: string): string {
  const input = value.trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.pathname !== "/" || url.search || url.hash) throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.href;
  } catch {
    throw new Error("代理地址必须为有效的 HTTP/HTTPS 地址，例如 http://127.0.0.1:18081，不得包含路径、查询参数或片段。");
  }
}

export function httpProxyPreview(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.username || url.password ? "***@" : ""}${url.host}`;
  } catch {
    return "已配置";
  }
}

export function createProxyAgent(proxyUrl: string): ProxyAgent {
  const url = new URL(normalizeHttpProxy(proxyUrl));
  const token = url.username || url.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
    : undefined;
  url.username = "";
  url.password = "";
  return new ProxyAgent({ uri: url.href, token });
}
