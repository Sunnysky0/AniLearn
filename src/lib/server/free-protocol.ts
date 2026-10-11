import type { FreeTurnAction, FreeTurnIntent } from "@/lib/types";
import type { TagBlock } from "./protocol";

export class FreeTurnProtocolGuard {
  private first = true;
  private topicSeen = false;
  private actionSeen = false;

  constructor(private readonly intent?: FreeTurnIntent) {}

  accept(block: TagBlock): FreeTurnAction | null {
    if (!block.closed) throw new Error("导师回复未完整结束，请重试。");
    if (this.actionSeen) throw new Error("action 必须是回复的最后一个标签。");
    if (this.first) {
      if (this.intent !== "greeting" && this.intent !== "goodbye" && block.tag !== "topic") {
        throw new Error("导师回复缺少开头的话题标记。");
      }
      if ((this.intent === "greeting" || this.intent === "goodbye") && block.tag === "topic") {
        throw new Error("欢迎与告别回复不能修改话题。");
      }
      this.first = false;
    } else if (block.tag === "topic") {
      throw new Error("每轮只能包含一个 topic 标签。");
    }
    if (block.tag === "topic") this.topicSeen = true;
    if (block.tag !== "action") return null;
    this.actionSeen = true;
    const value = block.body.trim();
    if (!["wait", "continue", "next", "finish"].includes(value)) throw new Error("导师回复的 action 无效。");
    if (this.intent === "greeting" || this.intent === "goodbye" || value === "next" || value === "finish") return "wait";
    return value as FreeTurnAction;
  }

  finish(stray: string) {
    if (!this.actionSeen) throw new Error("导师回复缺少最终 action 标签。");
    if (this.intent !== "greeting" && this.intent !== "goodbye" && !this.topicSeen) throw new Error("导师回复缺少话题标记。");
    if (stray.trim()) throw new Error("导师回复包含标签外的额外内容。");
  }
}
