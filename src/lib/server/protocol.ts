// Incremental parser for the tag-based streaming protocol used by the
// analysis and tutoring prompts (<msg>, <board>, <action>, <problem> ...).
// Tags avoid JSON escaping problems with raw LaTeX and can be parsed while
// the model is still streaming.

export interface TagBlock {
  tag: string;
  attrs: Record<string, string>;
  body: string;
  closed: boolean;
}

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

/** Content of the first <tag>…</tag> (tolerates a missing closing tag). */
export function innerTag(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}\\s*>|$)`, "i").exec(body);
  return m ? m[1].trim() : null;
}

export function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, "").trim();
}

export function createTagParser(tags: string[]) {
  let buf = "";
  let stray = "";
  const names = tags.join("|");
  const openRe = new RegExp(`<(${names})(\\s[^<>]*?)?(/?)>`, "i");

  function drain(final: boolean): TagBlock[] {
    const out: TagBlock[] = [];
    for (;;) {
      const m = openRe.exec(buf);
      if (!m) {
        if (final) {
          stray += buf;
          buf = "";
        } else {
          // Keep a possibly-incomplete opening tag (attributes can be long, e.g. <problem …>)
          const lt = buf.lastIndexOf("<");
          if (lt >= 0 && buf.length - lt < 4000) {
            stray += buf.slice(0, lt);
            buf = buf.slice(lt);
          } else {
            stray += buf;
            buf = "";
          }
        }
        break;
      }
      stray += buf.slice(0, m.index);
      const tag = m[1].toLowerCase();
      const attrs = parseAttrs(m[2] || "");
      const after = buf.slice(m.index + m[0].length);
      if (m[3] === "/") {
        out.push({ tag, attrs, body: "", closed: true });
        buf = after;
        continue;
      }
      // A block ends at its closing tag, or (robustness) at the next top-level opening tag.
      const endRe = new RegExp(`</${tag}\\s*>|<(?:${names})(?=[\\s/>])`, "i");
      const c = endRe.exec(after);
      if (!c) {
        if (final) {
          out.push({ tag, attrs, body: after, closed: false });
          buf = "";
        } else {
          buf = buf.slice(m.index);
        }
        break;
      }
      const isClose = c[0].startsWith("</");
      out.push({ tag, attrs, body: after.slice(0, c.index), closed: isClose });
      buf = isClose ? after.slice(c.index + c[0].length) : after.slice(c.index);
    }
    return out;
  }

  return {
    push(chunk: string) {
      buf += chunk;
      return drain(false);
    },
    end() {
      return drain(true);
    },
    stray() {
      return stray;
    },
  };
}

export function listItems(s: string | null): string[] {
  return (s ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d{1,2}[.、)）])\s+/, "").trim())
    .filter((l) => l && l !== "无" && l !== "（无）");
}
