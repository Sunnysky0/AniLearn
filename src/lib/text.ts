// Text helpers shared by client & server.
import { prepareMathMarkdown, scanMarkdownCode, scanMarkdownMath } from "./math-markdown";

/**
 * Split markdown into "reveal tokens" for the typewriter effect.
 * LaTeX expressions, bold spans and links are atomic so partially revealed
 * text never renders broken math.
 */
export function tokenizeForReveal(md: string): string[] {
  const out: string[] = [];
  const formulas = new Map(scanMarkdownMath(md).map((span) => [span.start, span.end]));
  const codes = new Map(scanMarkdownCode(md).map((span) => [span.start, span.end]));
  const markup = /\*\*[^*\n]+?\*\*|!?\[[^\]\n]*\]\([^)\n]*\)/y;
  for (let index = 0; index < md.length;) {
    markup.lastIndex = index;
    const atom = markup.exec(md);
    const escape = md[index] === "\\" && /[\\`*{}[\]()#+\-.!_$>~|]/.test(md[index + 1] ?? "");
    const end = codes.get(index) ?? formulas.get(index) ?? (atom ? index + atom[0].length : escape ? index + 2 : undefined);
    if (end !== undefined) {
      out.push(md.slice(index, end));
      index = end;
    } else {
      const ch = String.fromCodePoint(md.codePointAt(index)!);
      out.push(ch);
      index += ch.length;
    }
  }
  return out;
}

export function splitShortMessages(md: string, maxLength = 80): string[] {
  const chunks: string[] = [];
  let current = "";
  let length = 0;
  for (const token of tokenizeForReveal(md.trim())) {
    const size = Array.from(token).length;
    if (current.trim() && length + size > maxLength) {
      chunks.push(current.trim());
      current = "";
      length = 0;
    }
    current += token;
    length += size;
    if (length >= 35 && /[。！？!?\n]$/.test(token)) {
      chunks.push(current.trim());
      current = "";
      length = 0;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function hasJapaneseText(text: string): boolean {
  return /[\u3040-\u30ff]/u.test(text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, ""));
}

export function speechStyleTag(style = ""): string {
  const cue = style.trim();
  if (/^(?:\[[^\[\]\r\n]+\]\s*)+$/u.test(cue) && !/\[\s*\]/u.test(cue)) return cue;
  const description = cue.replace(/[\[\]\r\n]/g, " ").trim();
  return `[${description || "calm"}]`;
}

export function withSpeechStyle(text: string, style = ""): string {
  const speech = text.trim();
  const leadingCue = speech.match(/^\[([^\[\]\r\n]+)\]/u);
  if (!speech || leadingCue?.[1].trim()) return speech;
  return `${speechStyleTag(style)} ${speech}`;
}

export function isJapaneseSpeech(text: string): boolean {
  const plain = text.replace(/\[[^\[\]\r\n]+\]/gu, (cue) => cue.slice(1, -1).trim() ? "" : cue).trim();
  return /[\u3040-\u30ff]/u.test(plain) && !/[\[\]]|\$|\\[a-zA-Z]|`|\*\*|<\/?\w+|[这们说让为请问吗谢您觉应则]/u.test(plain);
}

/** Convert \( \) and \[ \] delimiters into $ / $$ so remark-math can parse them. */
export function normalizeMath(s: string): string {
  return prepareMathMarkdown(s).content;
}

export function difficultyStars(n: number): string {
  const v = Math.max(1, Math.min(5, Math.round(n || 3)));
  return "★".repeat(v) + "☆".repeat(5 - v);
}

export function strategyLabel(s: string): string {
  return s === "student_first" ? "先练后讲" : "直接精讲";
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${formatTime(iso)}`;
}
