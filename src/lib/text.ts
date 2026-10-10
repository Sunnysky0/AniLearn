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
  const source = md.trim();
  if (!source) return [];

  const tokens = tokenizeForReveal(source);
  const tokenSizes = tokens.map((token) => Array.from(token).length);
  const boundaries: { tokenEnd: number; length: number; priority: number }[] = [];
  let length = 0;
  let previousNonSpace = "";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    length += tokenSizes[index];
    const previous = previousNonSpace;
    if (!/^[ \t\r]$/u.test(token)) previousNonSpace = token;
    // Only plain punctuation may form boundaries; never inspect protected atoms.
    if (token.length !== 1) continue;
    const paragraph = token === "\n" && previous === "\n";
    const sentence = /[。！？!?]/u.test(token) ||
      (token === "." && /^(?:\s|[”’」』）》】"'])/u.test(tokens[index + 1] ?? " "));
    const semicolon = /[；;]/u.test(token);
    const comma = /[，,、]/u.test(token);
    const priority = paragraph || sentence ? 0 : semicolon ? 1 : comma ? 2 : -1;
    if (priority >= 0) boundaries.push({ tokenEnd: index + 1, length, priority });
  }

  const chunks: string[] = [];
  let start = 0;
  let startLength = 0;
  while (start < tokens.length) {
    const remainingLength = length - startLength;
    if (remainingLength <= maxLength) {
      const rest = tokens.slice(start).join("");
      if (rest.trim()) chunks.push(rest);
      break;
    }

    const candidates = boundaries.filter((boundary) => boundary.tokenEnd > start);
    if (!candidates.length) {
      // A sentence without a safe punctuation boundary stays intact.
      const rest = tokens.slice(start).join("");
      if (rest.trim()) chunks.push(rest);
      break;
    }

    const withinBudget = candidates.filter((boundary) => boundary.length - startLength <= maxLength);
    const boundary = withinBudget.length
      ? withinBudget.reduce((best, candidate) =>
          candidate.priority < best.priority ||
          (candidate.priority === best.priority && candidate.length > best.length) ? candidate : best)
      : candidates.reduce((nearest, candidate) => candidate.length < nearest.length ? candidate : nearest);

    let tokenEnd = boundary.tokenEnd;
    let nextLength = boundary.length;
    while (tokenEnd < tokens.length && /^[。！？!?…”’」』）》】"')\]]$/u.test(tokens[tokenEnd])) {
      nextLength += tokenSizes[tokenEnd];
      tokenEnd++;
    }
    while (tokenEnd < tokens.length && /^\s+$/u.test(tokens[tokenEnd])) {
      nextLength += tokenSizes[tokenEnd];
      tokenEnd++;
    }
    const chunk = tokens.slice(start, tokenEnd).join("");
    if (chunk.trim()) chunks.push(chunk);
    start = tokenEnd;
    startLength = nextLength;
  }
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
