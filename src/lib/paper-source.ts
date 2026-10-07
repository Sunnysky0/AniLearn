import { MAX_PAPER_TEXT_BYTES } from "@/lib/types";

export function paperTextFormat(mime: string): "Markdown" | "LaTeX" | null {
  if (mime === "text/markdown") return "Markdown";
  if (mime === "text/x-tex" || mime === "application/x-tex") return "LaTeX";
  return null;
}

export function decodePaperText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_PAPER_TEXT_BYTES) throw new Error("文本文件过大，单个文件最多 1.5 MB。");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("无法读取文本编码，请将文件保存为 UTF-8 后上传。");
  }
  if (!text.trim()) throw new Error("文本文件为空，请检查试卷内容。");
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error("文件含有非文本内容，请上传有效的 Markdown 或 LaTeX 文件。");
  return text;
}
