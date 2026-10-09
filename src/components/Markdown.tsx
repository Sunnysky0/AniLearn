"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Root as MarkdownRoot, RootContent } from "mdast";
import type { Element, Root as HtmlRoot } from "hast";
import { prepareMathMarkdown, type MarkdownMathSpan } from "@/lib/math-markdown";

function remarkMathLayout({ content, spans }: { content: string; spans: MarkdownMathSpan[] }) {
  const formulas = new Map(spans.map((span) => [span.start, span]));
  return (tree: MarkdownRoot) => {
    function visit(node: MarkdownRoot | RootContent) {
      if (node.type === "inlineMath" || node.type === "math") {
        const formula = formulas.get(node.position?.start.offset ?? -1);
        if (!formula) {
          const raw = content.slice(node.position?.start.offset, node.position?.end.offset);
          Object.assign(node, node.type === "math"
            ? { type: "paragraph", children: [{ type: "text", value: raw }], data: undefined }
            : { type: "text", value: raw, data: undefined });
          return;
        }
        if (node.type === "inlineMath") {
          node.data = { ...node.data, hName: "code", hProperties: {
            className: ["language-math", formula.display ? "math-display" : "math-inline"],
          } };
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}

function rehypeMathScroll() {
  return (tree: HtmlRoot) => {
    function visit(parent: HtmlRoot | Element) {
      parent.children = parent.children.map((node) => {
        if (node.type !== "element") return node;
        const classes = node.properties.className;
        if (Array.isArray(classes) && classes.includes("katex-display")) return node;
        if (Array.isArray(classes) && classes.includes("katex")) {
          return { type: "element", tagName: "span", properties: { className: ["math-inline"] },
            children: [{ type: "element", tagName: "span", properties: { className: ["math-scroll"] }, children: [node] }] };
        }
        visit(node);
        return node;
      });
    }
    visit(tree);
  };
}

function MarkdownImpl({ content, className }: { content: string; className?: string }) {
  const prepared = prepareMathMarkdown(content);
  return (
    <div className={`math-markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, [remarkMathLayout, prepared]]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }], rehypeMathScroll]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {prepared.content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
