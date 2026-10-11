import { parseDataUrl } from "./llm";
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TEXT_CHARS, MAX_CHAT_TURN_BODY_BYTES } from "@/lib/types";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface ChatInputBody {
  body: Record<string, unknown>;
  text: string;
  images: string[];
}

export function validateChatInput(value: unknown): ChatInputBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式不正确。");
  const body = value as Record<string, unknown>;
  const text = typeof body.text === "undefined" ? "" : typeof body.text === "string" ? body.text.trim() : null;
  if (text === null) throw new Error("提问内容格式不正确。");
  if (Array.from(text).length > MAX_CHAT_TEXT_CHARS) throw new Error("单条文字最多 4000 字，请分成几条消息发送。");
  if (typeof body.images !== "undefined" && !Array.isArray(body.images)) throw new Error("图片内容格式不正确。");
  const images = (Array.isArray(body.images) ? body.images : []).map((image) => {
    if (typeof image !== "string") throw new Error("图片内容格式不正确。");
    const parsed = parseDataUrl(image);
    if (!parsed || !IMAGE_MIMES.has(parsed.mime) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data)) {
      throw new Error("只支持 JPEG、PNG、WebP 或 GIF 图片。");
    }
    if (Buffer.from(parsed.data, "base64").byteLength > MAX_CHAT_IMAGE_BYTES) {
      throw new Error("单张图片请控制在 2 MiB 以内。");
    }
    return image;
  });
  if (images.length > MAX_CHAT_IMAGES) throw new Error("每条消息最多附加 4 张图片。");
  return { body, text, images };
}

export async function readChatInputRequest(req: Request): Promise<ChatInputBody> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_CHAT_TURN_BODY_BYTES) throw new Error("图片总量过大，请减少图片或压缩后重试。");
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_CHAT_TURN_BODY_BYTES) throw new Error("图片总量过大，请减少图片或压缩后重试。");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("请求格式不正确。"); }
  return validateChatInput(value);
}
