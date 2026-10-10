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
  assert.ok(chunks.some((chunk) => chunk.includes(formula)));
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

test("complete short messages stay together even when they contain several sentences", () => {
  const source = "这一步先把条件整理为等式，再根据等式性质同时移项，注意每项符号都要保持一致。接着代入检验。";
  assert.ok(source.length < 80);
  assert.deepEqual(splitShortMessages(source), [source]);
});

test("long Chinese messages split at a semantic boundary instead of inside a word", () => {
  const source = String.raw`本题最典型的易错点有两个：一是在求中点轨迹方程时，忽视由 $t^2 + 4\ge 4$ 导出的范围 $0 < x\le 1$；二是在换元求面积最值时，漏掉新元定义域 $u\ge\sqrt{3}$。`;
  const chunks = splitShortMessages(source);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith("；"));
  assert.ok(chunks[1].startsWith("二是在换元"));
  assert.ok(!chunks.some((chunk) => /新元定$|^义域/u.test(chunk)));
  assert.equal(chunks.join(""), source);
});

test("sentence endings take priority over semicolons and formulas stay atomic", () => {
  const source = "甲".repeat(42) + "。" + "乙".repeat(20) + "；" + "丙".repeat(20) + "。";
  const chunks = splitShortMessages(source);
  assert.equal(chunks[0], "甲".repeat(42) + "。");

  const formula = String.raw`$\frac{a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p}{r+s+t+u+v+w}$`;
  const withFormula = `推导结果为${formula}；代入条件检验。`;
  const formulaChunks = splitShortMessages(withFormula, 24);
  assert.ok(formulaChunks[0].includes(formula));
  assert.ok(formulaChunks[0].endsWith("；"));
  assert.equal(formulaChunks.join(""), withFormula);
});

test("long text without a safe punctuation boundary stays intact", () => {
  const source = "这是一段没有自然停顿位置的说明".repeat(10);
  assert.deepEqual(splitShortMessages(source), [source]);
});

test("splitting ignores punctuation inside protected markup and retains closing quotes", () => {
  for (const atom of ["**重点，说明。**", "`代码，说明。`", "\n```text\n代码。\n\n```\n", "[链接，说明。](https://example.com)"]) {
    const source = "前文".repeat(15) + atom + "后文".repeat(15);
    assert.deepEqual(splitShortMessages(source, 20), [source]);
  }
  const quoted = "他说：“" + "甲".repeat(40) + "。”" + "乙".repeat(45) + "。";
  const chunks = splitShortMessages(quoted, 50);
  assert.ok(chunks[0].endsWith("。”"));
  assert.equal(chunks.join(""), quoted);
  const repeatedPunctuation = "甲".repeat(79) + "！！" + "乙".repeat(20);
  assert.deepEqual(splitShortMessages(repeatedPunctuation), ["甲".repeat(79) + "！！", "乙".repeat(20)]);
});

test("soft budget extends to the next natural boundary and preserves whitespace", () => {
  const source = "甲".repeat(90) + "； " + "乙".repeat(20) + "。";
  assert.deepEqual(splitShortMessages(source), ["甲".repeat(90) + "； ", "乙".repeat(20) + "。"]);
  const paragraphs = "甲".repeat(50) + "\n\n" + "乙".repeat(40);
  assert.equal(splitShortMessages(paragraphs).join(""), paragraphs);
  assert.ok(splitShortMessages(paragraphs)[0].endsWith("\n\n"));
  const spacedParagraphs = "甲".repeat(50) + "\r\n \r\n" + "乙".repeat(40);
  assert.deepEqual(splitShortMessages(spacedParagraphs), ["甲".repeat(50) + "\r\n \r\n", "乙".repeat(40)]);
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
