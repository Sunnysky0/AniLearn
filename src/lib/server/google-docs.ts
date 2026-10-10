import {
  GOOGLE_DOC_EXPORT_MAX_BYTES,
  GOOGLE_DOC_MARKDOWN_MAX_BYTES,
  GOOGLE_DOC_MAX_REDIRECTS,
  isAllowedGoogleDocsRedirect,
  parseGoogleDocsUrl,
  safeGoogleDocsFilename,
  type GoogleDocsSource,
} from "../google-docs";
import { createProxyAgent } from "./http-proxy";

export class GoogleDocsImportError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface GoogleDocsPdf {
  bytes: Uint8Array;
  filename: string;
}

export interface GoogleDocsExport extends GoogleDocsPdf {
  mimeType: "application/pdf" | "text/markdown";
}

type ExportFormat = "markdown" | "pdf";
type ProxyAgent = ReturnType<typeof createProxyAgent>;

const formatDetails: Record<ExportFormat, { mimeType: GoogleDocsExport["mimeType"]; extension: ".md" | ".pdf"; maxBytes: number; accept: string }> = {
  markdown: { mimeType: "text/markdown", extension: ".md", maxBytes: GOOGLE_DOC_MARKDOWN_MAX_BYTES, accept: "text/markdown" },
  pdf: { mimeType: "application/pdf", extension: ".pdf", maxBytes: GOOGLE_DOC_EXPORT_MAX_BYTES, accept: "application/pdf" },
};

export function resolveGoogleDocsProxy(configuredProxyUrl: string): string {
  return process.env.GOOGLE_DOCS_PROXY_URL?.trim() || configuredProxyUrl.trim() ||
    process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim() ||
    process.env.ALL_PROXY?.trim() || process.env.all_proxy?.trim() || "";
}

async function withProxy<T>(proxyUrl: string, action: (agent: ProxyAgent | undefined) => Promise<T>): Promise<T> {
  const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined;
  try {
    return await action(agent);
  } finally {
    await agent?.destroy().catch(() => undefined);
  }
}

function parseSource(input: string): GoogleDocsSource {
  const source = parseGoogleDocsUrl(input);
  if (!source) throw new GoogleDocsImportError("请输入有效的 Google Docs 文档链接。", 400);
  return source;
}

export async function exportGoogleDocs(
  input: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(30_000),
  proxyUrl = "",
): Promise<GoogleDocsExport> {
  const source = parseSource(input);
  return withProxy(proxyUrl, async (agent) => {
    try {
      return await exportGoogleDocsFormat(source, "markdown", fetcher, signal, agent);
    } catch (markdownError) {
      if (signal.aborted || (markdownError instanceof GoogleDocsImportError && markdownError.message.includes("跳转地址不受支持"))) {
        throw markdownError;
      }
      // Public Docs links may support PDF but not Markdown export. Preserve the
      // existing PDF path as a fallback, including its all-tabs behavior.
      return exportGoogleDocsFormat(source, "pdf", fetcher, signal, agent);
    }
  });
}

export async function exportGoogleDocsPdf(
  input: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(30_000),
  proxyUrl = "",
): Promise<GoogleDocsPdf> {
  const source = parseSource(input);
  return withProxy(proxyUrl, async (agent) => {
    const result = await exportGoogleDocsFormat(source, "pdf", fetcher, signal, agent);
    return { bytes: result.bytes, filename: result.filename };
  });
}

async function exportGoogleDocsFormat(
  source: GoogleDocsSource,
  format: ExportFormat,
  fetcher: typeof fetch,
  signal: AbortSignal,
  agent: ProxyAgent | undefined,
): Promise<GoogleDocsExport> {
  const details = formatDetails[format];
  const url = new URL(`/document/d/${source.id}/export`, "https://docs.google.com");
  url.searchParams.set("format", format === "markdown" ? "md" : "pdf");
  // Omitting Google's optional `tab` parameter exports all tabs when supported.
  if (source.resourceKey) url.searchParams.set("resourcekey", source.resourceKey);

  let current = url;
  let redirects = 0;
  let response: Response;
  for (;;) {
    const init: RequestInit & { dispatcher?: ProxyAgent } = {
      method: "GET", redirect: "manual", headers: { Accept: details.accept }, signal,
      ...(agent ? { dispatcher: agent } : {}),
    };
    response = await fetcher(current, init);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects >= GOOGLE_DOC_MAX_REDIRECTS) throw new GoogleDocsImportError("Google Docs 导出跳转次数过多，请检查链接后重试。");
    const location = response.headers.get("location");
    if (!location) throw new GoogleDocsImportError("Google Docs 导出地址无效，请稍后重试。");
    const destination = new URL(location, current);
    if (!isAllowedGoogleDocsRedirect(destination.href)) throw new GoogleDocsImportError("Google Docs 导出跳转地址不受支持，已停止导入。", 400);
    await response.body?.cancel().catch(() => undefined);
    current = destination;
    redirects++;
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GoogleDocsImportError("无法访问此文档。请确认链接可公开查看，并允许下载或复制。", 400);
  }
  if (!response.ok) throw new GoogleDocsImportError(`Google Docs 导出失败（${response.status}），请稍后重试。`);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > details.maxBytes) {
    throw new GoogleDocsImportError(format === "markdown"
      ? "Google Docs 导出的 Markdown 超过 1.5 MB。"
      : "导出的 PDF 超过 20 MB，请压缩文档后重试。", 413);
  }
  if (!response.body) throw new GoogleDocsImportError("Google Docs 没有返回导出文件，请确认该文档允许导出。");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > details.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GoogleDocsImportError(format === "markdown"
          ? "Google Docs 导出的 Markdown 超过 1.5 MB。"
          : "导出的 PDF 超过 20 MB，请压缩文档后重试。", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (format === "pdf") {
    const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!header.startsWith("%PDF-")) throw new GoogleDocsImportError("Google Docs 返回的内容不是 PDF。请检查分享权限，或确认该文件是 Google 文档。", 400);
  } else {
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType && !["text/markdown", "text/plain", "application/octet-stream"].includes(contentType)) {
      throw new GoogleDocsImportError("Google Docs 返回的内容不是 Markdown。", 400);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GoogleDocsImportError("Google Docs 返回的 Markdown 不是有效的 UTF-8 文本。", 400);
    }
    const start = text.trimStart().slice(0, 256);
    if (!text.trim() || text.includes("\u0000") || /^(?:<!doctype\s+html\b|<html\b)/i.test(start)) {
      throw new GoogleDocsImportError("Google Docs 没有返回有效的 Markdown 原文。", 400);
    }
  }

  return {
    bytes,
    filename: safeGoogleDocsFilename(response.headers.get("content-disposition"), details.extension),
    mimeType: details.mimeType,
  };
}
