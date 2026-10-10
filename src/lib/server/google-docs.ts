import {
  GOOGLE_DOC_EXPORT_MAX_BYTES,
  GOOGLE_DOC_MAX_REDIRECTS,
  isAllowedGoogleDocsRedirect,
  parseGoogleDocsUrl,
  safeGoogleDocsFilename,
} from "../google-docs";

export class GoogleDocsImportError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface GoogleDocsPdf {
  bytes: Uint8Array;
  filename: string;
}

export async function exportGoogleDocsPdf(
  input: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<GoogleDocsPdf> {
  const source = parseGoogleDocsUrl(input);
  if (!source) throw new GoogleDocsImportError("请输入有效的 Google Docs 文档链接。", 400);

  const url = new URL(`/document/d/${source.id}/export`, "https://docs.google.com");
  url.searchParams.set("format", "pdf");
  // Omitting Google's optional `tab` parameter exports all tabs, regardless of which tab a shared link selected.
  if (source.resourceKey) url.searchParams.set("resourcekey", source.resourceKey);

  let current = url;
  let redirects = 0;
  let response: Response;
  for (;;) {
    response = await fetcher(current, { method: "GET", redirect: "manual", headers: { Accept: "application/pdf" }, signal });
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
  if (Number.isFinite(declaredLength) && declaredLength > GOOGLE_DOC_EXPORT_MAX_BYTES) {
    throw new GoogleDocsImportError("导出的 PDF 超过 20 MB，请压缩文档后重试。", 413);
  }
  if (!response.body) throw new GoogleDocsImportError("Google Docs 没有返回 PDF 文件，请确认该文档允许导出。");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GOOGLE_DOC_EXPORT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GoogleDocsImportError("导出的 PDF 超过 20 MB，请压缩文档后重试。", 413);
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
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!header.startsWith("%PDF-")) throw new GoogleDocsImportError("Google Docs 返回的内容不是 PDF。请检查分享权限，或确认该文件是 Google 文档。", 400);
  return { bytes, filename: safeGoogleDocsFilename(response.headers.get("content-disposition")) };
}
