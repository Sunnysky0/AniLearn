import { createHash } from "node:crypto";
import { parseDataUrl } from "./llm";
import type { FreeTurnRequest } from "@/lib/types";

export const MAX_FREE_TURN_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_FREE_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function readFreeTurnRequest(req: Request): Promise<FreeTurnRequest> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FREE_TURN_BODY_BYTES) throw new Error("图片总量过大，请减少图片或压缩后重试。");
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_FREE_TURN_BODY_BYTES) throw new Error("图片总量过大，请减少图片或压缩后重试。");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("请求格式不正确。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式不正确。");
  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !/^[\w-]{16,140}$/.test(body.requestId)) throw new Error("请求编号无效，请重试。");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (typeof body.text !== "undefined" && typeof body.text !== "string") throw new Error("提问内容格式不正确。");
  if (Array.from(text).length > 4000) throw new Error("单条文字最多 4000 字，请分成几条消息发送。");
  if (body.intent !== undefined && !["greeting", "continue", "goodbye"].includes(String(body.intent))) throw new Error("课堂动作无效。");
  if (body.topicId !== undefined && body.topicId !== null && (!Number.isSafeInteger(body.topicId) || Number(body.topicId) <= 0)) throw new Error("话题编号无效，请刷新后重试。");
  if (body.images !== undefined && !Array.isArray(body.images)) throw new Error("图片内容格式不正确。");
  const images = (Array.isArray(body.images) ? body.images : []).map((image) => {
    if (typeof image !== "string") throw new Error("图片内容格式不正确。");
    const parsed = parseDataUrl(image);
    if (!parsed || !IMAGE_MIMES.has(parsed.mime) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data)) {
      throw new Error("只支持 JPEG、PNG、WebP 或 GIF 图片。");
    }
    if (Buffer.from(parsed.data, "base64").byteLength > MAX_FREE_IMAGE_BYTES) throw new Error("单张图片请控制在 2 MiB 以内。");
    return image;
  });
  if (images.length > 4) throw new Error("每条消息最多附加 4 张图片。");
  const intent = body.intent as FreeTurnRequest["intent"];
  if ((intent === "greeting" || intent === "goodbye") && (text || images.length)) throw new Error("欢迎或告别请求不能附带提问内容。");
  if (!text && !images.length && !["greeting", "continue", "goodbye"].includes(String(intent))) throw new Error("请输入问题或附上一张图片。");
  return { requestId: body.requestId, text, images, topicId: body.topicId as number | null | undefined, intent };
}

export function freeTurnHash(body: FreeTurnRequest) {
  return createHash("sha256").update(JSON.stringify({
    text: body.text ?? "", images: body.images ?? [], topicId: body.topicId ?? null, intent: body.intent ?? null,
  })).digest("hex");
}

export function initialFreeTitle(text: string, images: string[]) {
  if (!text) return images.length ? "图片提问" : "自由提问";
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 32).join("");
}
