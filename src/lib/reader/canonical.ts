import type { ReaderNode } from "@/lib/book-types";
import { visibleMarkdownText } from "@/lib/reading-selection";
import { readerText } from "./anchors";

export function safeReaderHref(value?: string): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  if (value.startsWith("#")) return value;
  try { const url = new URL(value); return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

function inline(source: string): ReaderNode[] {
  const result: ReaderNode[] = [];
  const pattern = /(`([^`]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)|!?\[([^\]]*)\]\(([^)]*)\)|\$\$?([\s\S]*?)\$\$?|\n)/g;
  let from = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > from) result.push({ type: "text", text: source.slice(from, match.index) });
    if (match[0] === "\n") result.push({ type: "break" });
    else if (match[2]) result.push({ type: "code", text: match[2] });
    else if (match[3] || match[4]) result.push({ type: "strong", children: inline(match[3] || match[4]) });
    else if (match[5] || match[6]) result.push({ type: "emphasis", children: inline(match[5] || match[6]) });
    else if (match[7] !== undefined) result.push({ type: "link", href: safeReaderHref(match[8]), children: inline(match[7]) });
    else result.push({ type: "math", text: match[9] ?? "", display: match[0].startsWith("$$") });
    from = match.index + match[0].length;
  }
  if (from < source.length) result.push({ type: "text", text: source.slice(from) });
  return result;
}

/** Preserve the historic visible-text contract, including its UTF-16 offsets. */
export function readingMarkdownNodes(markdown: string): ReaderNode[] {
  const cleaned = markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[^\n]*\n([\s\S]*?)\n```/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  const nodes = inline(cleaned);
  const visible = visibleMarkdownText(markdown);
  return readerText(nodes) === visible ? nodes : [{ type: "text", text: visible }];
}
