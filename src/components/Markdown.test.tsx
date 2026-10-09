import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} className="md" />);
const displayCount = (html: string) => (html.match(/class="katex-display"/g) ?? []).length;

test("KaTeX renderer, CSS and parser resolve the same installed version", () => {
  const require = createRequire(import.meta.url);
  const css = require.resolve("katex/dist/katex.min.css");
  assert.equal(require("katex/package.json").version, "0.16.47");
  for (const plugin of ["rehype-katex", "micromark-extension-math"]) {
    const pluginRequire = createRequire(require.resolve(plugin));
    assert.equal(pluginRequire.resolve("katex/dist/katex.min.css"), css);
  }
});

test("single-line and multiline double dollars, and brackets render in display mode", () => {
  const html = render(String.raw`$x$ 与 $$\sum_{k=1}^n k$$ 与 \[x^2\]` + "\n\n$$\nx+1\n$$");
  assert.equal(displayCount(html), 3);
  assert.equal((html.match(/class="math-scroll"/g) ?? []).length, 1);
  assert.ok(!html.includes("katex-error"));
});

test("display formulas preserve lists, blockquotes, tables, bold and links", () => {
  const html = render("- $$x+1$$\n- **$$x+2$$**\n\n> " + String.raw`\[x+3\]` +
    "\n\n| 公式 |\n| --- |\n| $$x+4$$ |\n\n[$$x+5$$](https://example.com)");
  assert.equal(displayCount(html), 5);
  for (const tag of ["<ul>", "<blockquote>", "<table>", "<strong>", "<a "]) assert.ok(html.includes(tag));
  assert.ok(!html.includes("katex-error"));
});

test("escaped dollars in inline math render without changing to display mode", () => {
  for (const source of [String.raw`$x+\text{\$5}$`, String.raw`\(x+\text{\$5}\)`, String.raw`$\$$`]) {
    const html = render(source);
    assert.equal(displayCount(html), 0);
    assert.ok(html.includes('class="math-scroll"'));
    assert.ok(html.includes(source === String.raw`$\$$` ? 'encoding="application/x-tex">\\$</annotation>' : "$5"));
    assert.ok(!html.includes("katex-error"));
  }
});

test("code examples and unclosed formulas remain literal; invalid math fails locally", () => {
  const code = render("`" + String.raw`\(x\)` + "`\n\n```tex\n" + String.raw`\[x\]` + "\n```");
  assert.ok(code.includes(String.raw`\(x\)`));
  assert.ok(code.includes(String.raw`\[x\]`));
  assert.ok(!code.includes('class="katex"'));
  for (const source of ["$x", "$$\nx", String.raw`\(x`, String.raw`\[x`]) {
    assert.ok(!render(source).includes('class="katex"'));
  }
  const invalid = render(String.raw`$x^2$，$\frac{1}{$，$\unknown{x}$。`);
  assert.ok(invalid.includes("katex-error"));
  assert.ok(invalid.includes('class="katex"'));
});

test("standard exam math renders without parse errors", () => {
  const formulas = [String.raw`\vec{a}+\overrightarrow{AB}`, String.raw`\hat{x}+\bar{x}+\dot{x}+\ddot{x}`,
    String.raw`x_1^2+\frac{1}{1+\frac{1}{x}}+\sqrt[3]{x}`, String.raw`\int_0^1 x^2\,dx+\sum_{k=1}^n k`,
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, String.raw`\begin{cases}x+y=1\\x-y=0\end{cases}`,
    String.raw`\begin{aligned}f(x)&=x^2\\f'(x)&=2x\end{aligned}`];
  for (const formula of formulas) {
    const html = render("$$" + formula + "$$");
    assert.equal(displayCount(html), 1);
    assert.ok(!html.includes("katex-error"), formula);
  }
});
