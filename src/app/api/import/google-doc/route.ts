import { GOOGLE_DOC_EXPORT_TIMEOUT_MS } from "@/lib/google-docs";
import { getSettings } from "@/lib/server/settings";
import { exportGoogleDocs, GoogleDocsImportError, resolveGoogleDocsProxy } from "@/lib/server/google-docs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isConnectionTimeout(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const candidate = value as { name?: unknown; code?: unknown; cause?: unknown; errors?: unknown[] };
    if (candidate.name === "TimeoutError" || candidate.code === "UND_ERR_CONNECT_TIMEOUT" || candidate.code === "ETIMEDOUT") return true;
    if (candidate.cause) pending.push(candidate.cause);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return false;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.url !== "string" || body.url.length > 2048) {
    return Response.json({ error: "请提供有效的 Google Docs 链接。" }, { status: 400 });
  }

  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(GOOGLE_DOC_EXPORT_TIMEOUT_MS)]);
    const settings = await getSettings();
    const proxyUrl = resolveGoogleDocsProxy(settings.fish.proxyUrl);
    const document = await exportGoogleDocs(body.url, fetch, signal, proxyUrl);
    const bodyBuffer = new ArrayBuffer(document.bytes.byteLength);
    new Uint8Array(bodyBuffer).set(document.bytes);
    const extension = document.mimeType === "text/markdown" ? ".md" : ".pdf";
    return new Response(bodyBuffer, {
      headers: {
        "Content-Type": document.mimeType === "text/markdown" ? "text/markdown; charset=utf-8" : "application/pdf",
        "Content-Length": String(document.bytes.byteLength),
        "Content-Disposition": `attachment; filename="google-doc${extension}"; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
        "X-File-Name": encodeURIComponent(document.filename),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (req.signal.aborted) return Response.json({ error: "导入已取消。" }, { status: 499 });
    if (error instanceof GoogleDocsImportError) return Response.json({ error: error.message }, { status: error.status });
    if (isConnectionTimeout(error)) return Response.json({ error: "连接 Google Docs 超时，请检查服务器网络或代理设置后重试。" }, { status: 504 });
    return Response.json({ error: "读取 Google Docs 失败，请确认文档公开且允许导出。" }, { status: 502 });
  }
}
