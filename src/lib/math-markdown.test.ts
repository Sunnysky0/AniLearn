import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMathMarkdown, scanMarkdownMath } from "./math-markdown";
import { normalizeMath, splitShortMessages, tokenizeForReveal } from "./text";

test("escaped dollars do not open or close formulas during reveal or splitting", () => {
  const formula = String.raw`$x+\text{\$5}$`;
  const source = String.raw`价格\$5，公式` + formula + "，然后继续说明。";
  const tokens = tokenizeForReveal(source);
  assert.equal(tokens.join(""), source);
  assert.ok(tokens.includes(formula));
  assert.ok(tokens.includes(String.raw`\$`));
  const chunks = splitShortMessages(source, 8);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.includes(formula));
  assert.deepEqual(scanMarkdownMath(source).map((span) => span.value), [String.raw`x+\text{\$5}`]);
});

test("formulas, bold spans, links and complete code remain atomic", () => {
  const atoms = [String.raw`$\vec{a}$`, String.raw`$$\frac{1}{x}$$`, String.raw`\(x+1\)`,
    String.raw`\[x^2\]`, "**重点 $a+b$**", "[链接 $x$](https://example.com)",
    "`" + String.raw`\(代码\)` + "`", "```tex\n" + String.raw`\[代码\]` + "\n```"];
  const source = "说明😀\n\n" + atoms.join("\n\n");
  const tokens = tokenizeForReveal(source);
  assert.equal(tokens.join(""), source);
  for (const atom of atoms) assert.ok(tokens.includes(atom), atom);
  assert.equal(splitShortMessages(source, 12).join("").replace(/\s/g, ""), source.replace(/\s/g, ""));
});

test("normalization preserves code, escaped delimiters, and incomplete formulas", () => {
  for (const source of ["`" + String.raw`\(x\)` + "`", "``" + String.raw`\[x\]` + "``",
    "```tex\n" + String.raw`\[x\]` + "\n```", "~~~tex\n" + String.raw`\(x\)` + "\n~~~",
    "    " + String.raw`\[x\]`, String.raw`\\(x\\)`, String.raw`\(x`, String.raw`\[x`, "$x", "$$\nx"]) {
    assert.equal(normalizeMath(source), source);
  }
  assert.equal(normalizeMath(String.raw`- \[x+1\]`), "- $$x+1$$");
  assert.equal(normalizeMath(String.raw`> \(x+1\)`), "> $x+1$");
  for (const code of [">     " + String.raw`\[x\]`, "- item\n\n      " + String.raw`\[x\]`,
    "- ```tex\n  " + String.raw`\[x\]` + "\n  ```"]) assert.equal(normalizeMath(code), code);
  assert.equal(normalizeMath("- item\n\n    " + String.raw`\[x\]`), "- item\n\n    $$x$$");
});

test("normalization retains formula bodies and tracks inline/display mode separately", () => {
  const source = String.raw`\(x+\text{\$5}\) 与 $$x+1$$ 与 \[\frac{1}{x}\]`;
  const prepared = prepareMathMarkdown(source);
  assert.deepEqual(prepared.spans.map((span) => [span.value, span.display]), [
    [String.raw`x+\text{\$5}`, false], ["x+1", true], [String.raw`\frac{1}{x}`, true],
  ]);
  assert.equal(prepared.content, String.raw`$$x+\text{\$5}$$ 与 $$x+1$$ 与 $$\frac{1}{x}$$`);
});
