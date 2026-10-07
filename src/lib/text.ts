// Text helpers shared by client & server.

/**
 * Split markdown into "reveal tokens" for the typewriter effect.
 * LaTeX expressions, bold spans and links are atomic so partially revealed
 * text never renders broken math.
 */
export function tokenizeForReveal(md: string): string[] {
  const out: string[] = [];
  const re =
    /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\*\*[^*\n]+?\*\*|!?\[[^\]\n]*\]\([^)\n]*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) {
      for (const ch of Array.from(md.slice(last, m.index))) out.push(ch);
    }
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < md.length) {
    for (const ch of Array.from(md.slice(last))) out.push(ch);
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

export function isJapaneseSpeech(text: string): boolean {
  const plain = text.replace(/\[[^\]]*\]/g, "").trim();
  return /[\u3040-\u30ff]/u.test(plain) && !/\$|\\[a-zA-Z]|`|\*\*|<\/?\w+|[这们说让为请问吗谢您觉应则]/u.test(plain);
}

/** Convert \( \) and \[ \] delimiters into $ / $$ so remark-math can parse them. */
export function normalizeMath(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `\n$$${inner}$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
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
