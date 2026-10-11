import { createHash } from "node:crypto";
import type { FreeTurnRequest } from "@/lib/types";
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TURN_BODY_BYTES } from "@/lib/types";
import { readChatInputRequest } from "./chat-input";

export const MAX_FREE_TURN_BODY_BYTES = MAX_CHAT_TURN_BODY_BYTES;
export const MAX_FREE_IMAGE_BYTES = MAX_CHAT_IMAGE_BYTES;

export async function readFreeTurnRequest(req: Request): Promise<FreeTurnRequest> {
  const { body, text, images } = await readChatInputRequest(req);
  if (typeof body.requestId !== "string" || !/^[\w-]{16,140}$/.test(body.requestId)) throw new Error("请求编号无效，请重试。");
  if (body.intent !== undefined && !["greeting", "continue", "goodbye"].includes(String(body.intent))) throw new Error("课堂动作无效。");
  if (body.topicId !== undefined && body.topicId !== null && (!Number.isSafeInteger(body.topicId) || Number(body.topicId) <= 0)) throw new Error("话题编号无效，请刷新后重试。");
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
