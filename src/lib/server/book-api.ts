import { BookImportError, bookErrorMessage } from "./book-import";
import { validBookId } from "./book-catalog";

export function bookApiError(error: unknown, fallbackStatus = 500) {
  return Response.json({ error: bookErrorMessage(error) }, { status: error instanceof BookImportError ? error.status : fallbackStatus });
}
export function bookRouteIds(params: { id: string; versionId?: string }) {
  const bookId = validBookId(params.id);
  const versionId = params.versionId === undefined ? undefined : validBookId(params.versionId);
  if (!bookId || versionId === null) throw new BookImportError("书籍或版本 ID 无效");
  return { bookId, versionId };
}
export function queryVersionId(req: Request) {
  const raw = new URL(req.url).searchParams.get("versionId");
  if (raw === null) return undefined;
  const version = validBookId(raw);
  if (!version) throw new BookImportError("书籍版本 ID 无效");
  return version;
}

export async function readLimitedMultipart(req: Request, maxBytes: number): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/iu.test(type)) throw new BookImportError("请使用文件上传表单");
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new BookImportError("电子书不能超过 50 MiB", 413);
  if (!req.body) throw new BookImportError("缺少电子书文件");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new BookImportError("电子书不能超过 50 MiB", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return await new Response(merged, { headers: { "content-type": type } }).formData(); }
  catch { throw new BookImportError("上传表单无效"); }
}
