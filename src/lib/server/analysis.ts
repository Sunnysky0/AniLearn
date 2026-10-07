import type { AnalyzedProblem, PaperInventory } from "@/lib/types";
import { createTagParser, innerTag, listItems, type TagBlock } from "./protocol";

export function parseInventory(raw: string, pageCount: number): PaperInventory {
  const parser = createTagParser(["inventory"]);
  const blocks = [...parser.push(raw), ...parser.end()];
  const block = blocks[0];
  if (blocks.length !== 1 || !block.closed || Number(block.attrs.pages) !== pageCount) {
    throw new Error("题目清单未完整覆盖全部页面，请重试。");
  }
  const itemParser = createTagParser(["item"]);
  const items = [...itemParser.push(block.body), ...itemParser.end()].map((b) => {
    const page = Number(b.attrs.page);
    const endPage = Number(b.attrs.endpage);
    if (!b.closed || !b.attrs.number || !b.body.trim() ||
      !Number.isInteger(page) || !Number.isInteger(endPage) || page < 1 || endPage < page || endPage > pageCount) {
      throw new Error("题目清单的题号、题干或页码不完整，请重试。");
    }
    return { number: b.attrs.number, page, endPage, content: b.body.trim() };
  });
  if (!items.length || Number(block.attrs.count) !== items.length || new Set(items.map((p) => p.number)).size !== items.length) {
    throw new Error("题目数量或题号校验失败，请重试。");
  }
  const overview = innerTag(block.body, "overview");
  if (!overview) throw new Error("试卷整体分析缺失，请重试。");
  return { title: block.attrs.title || "", overview, items };
}

export function parseAnalyzedProblem(b: TagBlock, item: PaperInventory["items"][number]): AnalyzedProblem {
  const required = (tag: string) => {
    const value = innerTag(b.body, tag);
    if (!value || !new RegExp(`</${tag}\\s*>`, "i").test(b.body)) {
      throw new Error(`第 ${item.number} 题的 ${tag} 内容未完成，请重试。`);
    }
    return value;
  };
  if (!b.closed || b.attrs.number !== item.number || Number(b.attrs.page) !== item.page) {
    throw new Error(`第 ${item.number} 题未完整输出，或题号与页码不匹配，请重试。`);
  }
  const content = required("content");
  const answer = required("answer");
  const solution = required("solution");
  const keyPoints = listItems(required("keypoints"));
  const skills = listItems(required("skills"));
  const knowledgePoints = listItems(required("knowledge")).map((line) => {
    const [name, source, ...rest] = line.split(/\s*[|｜]\s*/);
    return { name: name?.trim() || "", source: source?.trim() || "", detail: rest.join(" | ").trim() };
  });
  if (!keyPoints.length || !skills.length || !knowledgePoints.length ||
    knowledgePoints.some((k) => !k.name || !k.source || !k.detail)) {
    throw new Error(`第 ${item.number} 题的关键点、教材知识点或方法不完整，请重试。`);
  }
  if (!["student_first", "direct_teach"].includes(b.attrs.strategy)) {
    throw new Error(`第 ${item.number} 题缺少教学策略，请重试。`);
  }
  return {
    number: item.number, page: item.page, content, answer, solution, keyPoints, knowledgePoints, skills,
    type: b.attrs.type || "", title: b.attrs.title || "",
    difficulty: Math.max(1, Math.min(5, Number(b.attrs.difficulty) || 3)),
    strategy: b.attrs.strategy, strategyReason: required("reason"),
    studentWork: innerTag(b.body, "student") || "",
  };
}
