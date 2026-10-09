import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";

export interface MarkdownMathSpan {
  start: number;
  end: number;
  value: string;
  display: boolean;
}

interface CodeSpan {
  start: number;
  end: number;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

function markerLength(source: string, index: number): number {
  let end = index + 1;
  while (source[end] === source[index]) end++;
  return end - index;
}

export function scanMarkdownCode(source: string): CodeSpan[] {
  if (!/[`~]|^(?: {4}|\t|>)/m.test(source)) return [];
  const spans: CodeSpan[] = [];
  function visit(node: Root | RootContent) {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) spans.push({ start, end });
    } else if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(source));
  return spans;
}

function mathAt(source: string, start: number): MarkdownMathSpan | null {
  const compatible = source[start] === "\\" && /[([]/.test(source[start + 1] ?? "");
  if ((source[start] !== "$" && !compatible) || isEscaped(source, start)) return null;
  const size = compatible ? 2 : markerLength(source, start);
  const display = compatible ? source[start + 1] === "[" : size >= 2;
  const closing = compatible ? (display ? "\\]" : "\\)") : "$".repeat(size);
  let next = start + size;

  while (next < source.length) {
    if (source.startsWith(closing, next) && !isEscaped(source, next)) {
      const length = compatible ? 2 : markerLength(source, next);
      if (compatible || length === size) {
        const value = source.slice(start + size, next);
        if (value.trim()) return { start, end: next + length, value, display };
        return null;
      }
      next += length;
    } else {
      next++;
    }
  }
  return null;
}

/** Shared source boundaries for rendering, reveal, and short-message splitting. */
export function scanMarkdownMath(source: string): MarkdownMathSpan[] {
  const spans: MarkdownMathSpan[] = [];
  const codes = new Map(scanMarkdownCode(source).map((span) => [span.start, span]));
  for (let index = 0; index < source.length;) {
    const code = codes.get(index);
    const math = code ? null : mathAt(source, index);
    if (math) spans.push(math);
    if (code) index = code.end;
    else if (math) index = math.end;
    else if (source[index] === "$" && !isEscaped(source, index)) index += markerLength(source, index);
    else index++;
  }
  return spans;
}

export function prepareMathMarkdown(source: string): { content: string; spans: MarkdownMathSpan[] } {
  let content = "";
  let last = 0;
  const spans: MarkdownMathSpan[] = [];
  for (const span of scanMarkdownMath(source)) {
    content += source.slice(last, span.start);
    const start = content.length;
    // A longer fence keeps remark-math from closing an inline formula at an escaped dollar.
    const longestDollar = Array.from(span.value.matchAll(/\$+/g))
      .reduce((longest, match) => Math.max(longest, match[0].length), 0);
    const fence = "$".repeat(Math.max(span.display ? 2 : 1, longestDollar + 1));
    const padding = span.value.startsWith("$") || span.value.endsWith("$") ? " " : "";
    content += `${fence}${padding}${span.value}${padding}${fence}`;
    spans.push({ ...span, start, end: content.length });
    last = span.end;
  }
  return { content: content + source.slice(last), spans };
}

