import assert from "node:assert/strict";
import { test } from "node:test";
import { fullPlan, goalCovered, parseLearningPlan, directoryDTO } from "./learning-plan";
import { parseInventory } from "./analysis";
import type { PaperInventory } from "@/lib/types";

const inventory: PaperInventory = { title: "测试", overview: "", items: [0, 1, 2].map((idx) => ({ idx, number: String(idx + 1), page: 1, endPage: 1, content: "题目" })) };
test("plans preserve stable original indices and reject duplicate topics or unknown targets", () => {
  const plan = parseLearningPlan('<plan><unit idx="2" reason="难题"><goal topic="skills">关键转化</goal></unit><unit idx="0"><goal topic="knowledge">等式性质</goal></unit></plan>', inventory, "focused", 3, "");
  assert.deepEqual(plan.units.map((u) => u.idx), [0, 2]);
  assert.throws(() => parseLearningPlan('<plan><unit idx="5"><goal topic="skills">方法</goal></unit></plan>', inventory, "focused", 1, ""));
  assert.throws(() => parseLearningPlan('<plan><unit idx="0"><goal topic="skills">甲</goal><goal topic="skills">乙</goal></unit></plan>', inventory, "focused", 1, ""));
  assert.throws(() => parseLearningPlan('<plan><unit idx="0"><goal topic="skills">方法</goal></unit></plan>', inventory, "thorough", 1, ""));
  assert.throws(() => parseLearningPlan('<plan><unit idx="0"><goal topic="extension">拓展</goal></unit></plan>', inventory, "advanced", 1, ""));
});
test("changed goals require fresh evidence; legacy full-topic evidence remains valid", () => {
  const parse = (description: string) => parseLearningPlan(`<plan><unit idx="0"><goal topic="skills">${description}</goal></unit></plan>`, inventory, "essential", 1, "").units[0].goals[0];
  const old = parse("等价变形"), changed = parse("函数综合迁移");
  assert.equal(goalCovered(changed, 0, { [old.id]: "旧证据" }), false);
  assert.equal(goalCovered(parse("等价变形"), 0, { [old.id]: "旧证据" }), true);
  assert.equal(goalCovered(fullPlan(inventory.items).units[0].goals[0], 0, { solution: "历史求解证据" }), true);
});
test("directory exposes nullable analysis without invented answers", () => {
  const directory = directoryDTO(inventory, []);
  assert.equal(directory.length, 3);
  assert.ok(directory.every((item) => item.analysis === null));
  assert.deepEqual(parseInventory('<inventory pages="1" count="1"><overview>分类</overview><item number="1" page="1" endpage="1" topics="等式性质" difficulty="2">题目</item></inventory>', 1).items[0].idx, 0);
});
