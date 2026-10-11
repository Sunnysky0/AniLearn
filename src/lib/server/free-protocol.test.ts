import assert from "node:assert/strict";
import { test } from "node:test";
import { createTagParser } from "./protocol";
import { FreeTurnProtocolGuard } from "./free-protocol";

test("free protocol parses tags split across stream chunks and keeps LaTeX intact", () => {
  const parser = createTagParser(["topic", "msg", "board", "action"]);
  const guard = new FreeTurnProtocolGuard();
  const output = '<topic mode="new" title="代数"></topic><msg><zh>先整理条件。</zh><ja>[calm] 条件を整理しましょう。</ja></msg><board mode="append">$$x^2-4=0$$</board><action>wait</action>';
  const blocks = [...parser.push(output.slice(0, 43)), ...parser.push(output.slice(43, 109)), ...parser.push(output.slice(109)), ...parser.end()];
  assert.deepEqual(blocks.map((block) => block.tag), ["topic", "msg", "board", "action"]);
  assert.equal(blocks[2].body, "$$x^2-4=0$$");
  blocks.forEach((block) => guard.accept(block));
  guard.finish(parser.stray());
});

test("free protocol rejects missing, repeated, late, and unclosed topic/action tags", () => {
  const block = (tag: string, body = "", closed = true) => ({ tag, attrs: {}, body, closed });
  assert.throws(() => new FreeTurnProtocolGuard().accept(block("msg")), /开头的话题/);
  const duplicate = new FreeTurnProtocolGuard();
  duplicate.accept(block("topic"));
  assert.throws(() => duplicate.accept(block("topic")), /只能包含一个/);
  const late = new FreeTurnProtocolGuard();
  late.accept(block("topic")); late.accept(block("action", "wait"));
  assert.throws(() => late.accept(block("msg")), /最后一个/);
  assert.throws(() => new FreeTurnProtocolGuard().accept(block("msg", "", false)), /未完整/);
  assert.throws(() => new FreeTurnProtocolGuard("goodbye").accept(block("topic")), /不能修改话题/);
  assert.throws(() => new FreeTurnProtocolGuard().finish("模型补充文字"), /action/);
});

test("free protocol downgrades paper completion actions and constrains goodbye", () => {
  const guard = new FreeTurnProtocolGuard();
  guard.accept({ tag: "topic", attrs: { mode: "new", title: "新话题" }, body: "", closed: true });
  assert.equal(guard.accept({ tag: "action", attrs: {}, body: "finish", closed: true }), "wait");
  guard.finish("");
  const goodbye = new FreeTurnProtocolGuard("goodbye");
  assert.equal(goodbye.accept({ tag: "action", attrs: {}, body: "continue", closed: true }), "wait");
  goodbye.finish("");
});
