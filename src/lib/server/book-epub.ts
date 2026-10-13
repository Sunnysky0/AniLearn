import { createHash } from "node:crypto";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import yauzl from "yauzl";
import type { BookChapterDraft, BookImportDraft, BookLanguage, ReaderBlock, ReaderFootnote, ReaderNode } from "@/lib/types";
import { MAX_BOOK_EXPANDED_BYTES } from "@/lib/types";

export const BOOK_PARSER_VERSION = "reader-epub-1";
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type Xml = Record<string, unknown>;
export interface EpubAsset { key: string; mime: string; data: Buffer }
export interface EpubNav { title: string; path: string; fragment: string; parent: number | null; role: "front" | "main" | "back" }
export interface EpubPlan {
  files: Map<string, Buffer>; spine: string[]; nav: EpubNav[]; assets: EpubAsset[];
  footnoteTargets: Set<string>; noteFiles: string[];
  metadata: BookImportDraft["metadata"];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
export const epubAssetKey = (file: string) => `asset-${hash(file)}`;
const record = (value: unknown): Xml => value && typeof value === "object" && !Array.isArray(value) ? value as Xml : {};
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xmlText = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : String(record(value)["#text"] ?? "");
const attr = (node: HtmlNode, name: string) => "attrs" in node ? node.attrs.find(a => a.name === name)?.value ?? "" : "";
const tag = (node: HtmlNode) => "tagName" in node ? node.tagName : "";
const children = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const descendants = (node: HtmlNode): HtmlNode[] => children(node).flatMap(n => [n, ...descendants(n)]);
const plain = (node: HtmlNode): string => "value" in node ? node.value : children(node).map(plain).join("");
const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();
const unsafeTags = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "noscript", "template"]);

export function safeArchivePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-z]:/iu.test(value)) throw new Error("电子书含不安全的文件路径");
  const segments = value.split("/");
  if (segments.includes("..") || segments.includes(".")) throw new Error("电子书含不安全的文件路径");
  return value;
}

// Hrefs may legitimately walk up within the archive, but never outside it.
export function resolveEpubHref(base: string, href: string): { path: string; fragment: string } | null {
  if (!href || /^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith("//")) return null;
  const [rawPath, rawFragment = ""] = href.split("#", 2);
  let decoded: string;
  let fragment: string;
  try { decoded = decodeURIComponent(rawPath.split("?", 1)[0]); fragment = decodeURIComponent(rawFragment); }
  catch { throw new Error("电子书引用路径编码无效"); }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.startsWith("/") || /^[a-z]:/iu.test(decoded)) throw new Error("电子书含不安全的资源引用");
  const file = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(base), decoded)) : base;
  return { path: safeArchivePath(file), fragment };
}

export async function readEpubArchive(data: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new Error("EPUB 压缩包无效")); return; }
      const files = new Map<string, Buffer>();
      let size = 0;
      let count = 0;
      let settled = false;
      const fail = (reason: unknown) => { if (settled) return; settled = true; zip.close(); reject(reason instanceof Error ? reason : new Error(String(reason))); };
      zip.on("error", fail);
      zip.on("end", () => { if (!settled) { settled = true; resolve(files); } });
      zip.on("entry", entry => {
        try {
          const file = safeArchivePath(entry.fileName);
          if (++count > 10000) throw new Error("电子书文件数量超过安全限制");
          if (entry.generalPurposeBitFlag & 1) throw new Error("不支持加密的 EPUB");
          // Reject Unix symlinks instead of following archive-supplied paths.
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error("电子书不能包含符号链接");
          size += entry.uncompressedSize;
          if (size > MAX_BOOK_EXPANDED_BYTES) throw new Error("电子书解压后不能超过 256 MiB");
          if (file.endsWith("/")) { zip.readEntry(); return; }
          if (files.has(file)) throw new Error("电子书包含重复文件路径");
          zip.openReadStream(entry, (readError, stream) => {
            if (readError || !stream) { fail(new Error("电子书文件无法读取")); return; }
            const chunks: Buffer[] = [];
            let actual = 0;
            stream.on("data", (chunk: Buffer) => { actual += chunk.length; if (actual > entry.uncompressedSize || actual > MAX_BOOK_EXPANDED_BYTES) { stream.destroy(); fail(new Error("电子书解压大小无效")); } else chunks.push(chunk); });
            stream.on("error", fail);
            stream.on("end", () => { if (!settled) { files.set(file, Buffer.concat(chunks)); zip.readEntry(); } });
          });
        } catch (reason) { fail(reason); }
      });
      zip.readEntry();
    });
  });
}

function parseXml(data: Buffer | undefined): Xml {
  if (!data) throw new Error("电子书缺少必要的目录文件");
  const text = data.toString("utf8");
  if (/<!ENTITY\s/iu.test(text)) throw new Error("不支持含自定义实体的电子书");
  if (XMLValidator.validate(text) !== true) throw new Error("电子书 XML 目录无效");
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false }).parse(text) as Xml;
}

function navRole(title: string, hint = ""): EpubNav["role"] {
  const value = `${hint} ${title}`;
  if (/cover|title.?page|copyright|contents|preface|foreword|introduction|biograph|封面|扉页|版权|目录|序言|前言/iu.test(value)) return "front";
  if (/appendix|afterword|bibliograph|index|editorial board|acknowledg|后记|附录|参考文献|索引/iu.test(value)) return "back";
  return "main";
}

function readNavigation(files: Map<string, Buffer>, file: string, epub3: boolean): EpubNav[] {
  const nav: EpubNav[] = [];
  if (epub3) {
    const root = parse(files.get(file)?.toString("utf8") ?? "");
    const toc = descendants(root).find(n => tag(n) === "nav" && /\btoc\b/u.test(attr(n, "type") || attr(n, "epub:type"))) ?? descendants(root).find(n => tag(n) === "nav");
    if (!toc) return [];
    const walkList = (list: HtmlNode, parent: number | null) => {
      for (const li of children(list).filter(n => tag(n) === "li")) {
        const link = children(li).find(n => tag(n) === "a" || tag(n) === "span") ?? descendants(li).find(n => tag(n) === "a");
        let current = parent;
        if (link && tag(link) === "a") {
          const target = resolveEpubHref(file, attr(link, "href"));
          if (target) { current = nav.length; nav.push({ ...target, title: normalized(plain(link)) || "未命名章节", parent, role: navRole(plain(link), attr(li, "type") || attr(li, "epub:type")) }); }
        }
        for (const sub of children(li).filter(n => tag(n) === "ol" || tag(n) === "ul")) walkList(sub, current);
      }
    };
    for (const list of children(toc).filter(n => tag(n) === "ol" || tag(n) === "ul")) walkList(list, null);
  } else {
    const ncx = record(parseXml(files.get(file)).ncx);
    const walk = (points: unknown, parent: number | null) => {
      for (const raw of array(points)) {
        const point = record(raw);
        const target = resolveEpubHref(file, String(record(point.content)["@_src"] ?? ""));
        let current = parent;
        if (target) { current = nav.length; const title = xmlText(record(point.navLabel).text) || "未命名章节"; nav.push({ ...target, title, parent, role: navRole(title, String(point["@_class"] ?? "")) }); }
        walk(point.navPoint, current);
      }
    };
    walk(record(ncx.navMap).navPoint, null);
  }
  return nav;
}

interface FootnoteSource { fragment: string; nodes: HtmlNode[] }
function collectFootnotes(root: HtmlNode): { sources: FootnoteSource[]; owned: Set<HtmlNode> } {
  const sources: FootnoteSource[] = [];
  const owned = new Set<HtmlNode>();
  const fragment = (node: HtmlNode) => attr(node, "id") || attr(node, "name");
  const semantic = (node: HtmlNode) => `${attr(node, "type")} ${attr(node, "epub:type")} ${attr(node, "role")}`.split(/\s+/u).map(token => token.replace(/^doc-/u, ""));
  const marker = (node: HtmlNode) => [...semantic(node), ...attr(node, "class").split(/\s+/u)].some(token => /^(footnotes?|endnotes?)$/iu.test(token));
  const blockNames = new Set(["p", "li", "aside", "div", "section"]);
  const findPieces = (container: HtmlNode): { fragment: string; node: HtmlNode }[] => children(container).flatMap(node => {
    const id = fragment(node);
    if (blockNames.has(tag(node)) && id) return [{ fragment: id, node }];
    if (["p", "li"].includes(tag(node))) {
      // Older EPUBs also use an empty named anchor at the start of a note.
      const anchor = descendants(node).find(child => tag(child) === "a" && fragment(child));
      return [{ fragment: anchor ? fragment(anchor) : "", node }];
    }
    return findPieces(node);
  });
  const walk = (node: HtmlNode) => {
    if (unsafeTags.has(tag(node))) return;
    if (!marker(node)) { for (const child of children(node)) walk(child); return; }
    const id = fragment(node);
    const pieces = findPieces(node);
    const collection = semantic(node).some(token => /^(footnotes|endnotes)$/iu.test(token));
    if (id && !collection && (semantic(node).some(token => /^(footnote|endnote)$/iu.test(token)) || !pieces.some(piece => piece.fragment))) {
      sources.push({ fragment: id, nodes: [node] }); owned.add(node); return;
    }
    let current: FootnoteSource | null = null;
    for (const piece of pieces) {
      if (piece.fragment) { current = { fragment: piece.fragment, nodes: [piece.node] }; sources.push(current); owned.add(piece.node); }
      else if (current) { current.nodes.push(piece.node); owned.add(piece.node); }
    }
  };
  walk(root);
  if (new Set(sources.map(source => source.fragment)).size !== sources.length) throw new Error("电子书含重复的脚注标识");
  return { sources, owned };
}

export async function buildEpubPlan(data: Buffer): Promise<EpubPlan> {
  const files = await readEpubArchive(data);
  const container = record(parseXml(files.get("META-INF/container.xml")).container);
  const rootFile = record(array(record(container.rootfiles).rootfile)[0]);
  const opfPath = safeArchivePath(String(rootFile["@_full-path"] ?? ""));
  const pkg = record(parseXml(files.get(opfPath)).package);
  const metadata = record(pkg.metadata);
  const manifest = array(record(pkg.manifest).item).map(record).map(item => ({
    id: String(item["@_id"] ?? ""), href: String(item["@_href"] ?? ""),
    mime: String(item["@_media-type"] ?? ""), properties: String(item["@_properties"] ?? ""),
  })).map(item => ({ ...item, target: resolveEpubHref(opfPath, item.href) }));
  const byId = new Map(manifest.map(item => [item.id, item]));
  if (files.has("META-INF/encryption.xml")) {
    const encryption = parseXml(files.get("META-INF/encryption.xml"));
    const root = record(encryption.encryption);
    const encrypted = array(root.EncryptedData).map(record);
    const algorithms = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);
    const fontMimes: Record<string, RegExp> = {
      "font/ttf": /\.ttf$/iu, "application/x-font-ttf": /\.ttf$/iu, "application/x-font-truetype": /\.ttf$/iu,
      "font/otf": /\.otf$/iu, "application/x-font-opentype": /\.otf$/iu,
      "application/vnd.ms-opentype": /\.(?:ttf|otf)$/iu, "application/font-sfnt": /\.(?:ttf|otf)$/iu,
      "font/woff": /\.woff$/iu, "application/font-woff": /\.woff$/iu, "application/x-font-woff": /\.woff$/iu,
      "font/woff2": /\.woff2$/iu,
    };
    if (!encrypted.length || Object.keys(root).some(key => !["EncryptedData", "#text"].includes(key) && !key.startsWith("@_"))) throw new Error("不支持 DRM 加密的电子书");
    for (const entry of encrypted) {
      const method = record(entry.EncryptionMethod);
      const cipher = record(entry.CipherData);
      const reference = record(cipher.CipherReference);
      const uri = typeof reference["@_URI"] === "string" ? reference["@_URI"] : "";
      // OCF cipher references are rooted at the archive, unlike OPF hrefs.
      const target = resolveEpubHref("encryption.xml", uri);
      const item = target && !target.fragment ? manifest.find(item => item.target?.path === target.path) : undefined;
      if (!algorithms.has(String(method["@_Algorithm"] ?? "")) || !item?.target || !files.has(item.target.path) || !fontMimes[item.mime]?.test(item.target.path) || array(entry.EncryptionMethod).length !== 1 || array(cipher.CipherReference).length !== 1 || cipher.CipherValue !== undefined || reference.Transforms !== undefined) throw new Error("不支持 DRM 加密的电子书");
    }
    // Known font obfuscation is accepted only because imported fonts/CSS are
    // never exposed to or used by the reader. Body/image encryption is rejected.
  }
  const spine = array(record(pkg.spine).itemref).map(record).map(item => {
    const target = byId.get(String(item["@_idref"] ?? ""));
    if (!target?.target || !files.has(target.target.path) || !/^(application\/xhtml\+xml|text\/html)$/u.test(target.mime)) throw new Error("电子书阅读顺序引用了缺失或不支持的正文");
    return target.target.path;
  });
  if (!spine.length || new Set(spine).size !== spine.length) throw new Error("电子书阅读顺序为空或含重复正文");
  const epub3Nav = manifest.find(item => /\bnav\b/u.test(item.properties));
  const ncx = byId.get(String(record(pkg.spine)["@_toc"] ?? "")) ?? manifest.find(item => item.mime === "application/x-dtbncx+xml");
  const navigation = epub3Nav ?? ncx;
  const nav = navigation?.target ? readNavigation(files, navigation.target.path, !!epub3Nav).filter(item => spine.includes(item.path)) : [];
  const footnoteTargets = new Set<string>();
  const noteFiles: string[] = [];
  for (const item of manifest) {
    if (!item.target || !files.has(item.target.path) || !/^(application\/xhtml\+xml|text\/html)$/u.test(item.mime)) continue;
    const { sources } = collectFootnotes(parse(files.get(item.target.path)!.toString("utf8")));
    for (const source of sources) footnoteTargets.add(`${item.target.path}#${source.fragment}`);
    // Notes outside the spine remain available as popups without becoming body chapters.
    if (sources.length && !spine.includes(item.target.path)) noteFiles.push(item.target.path);
  }
  const assets: EpubAsset[] = [];
  for (const item of manifest) {
    if (!item.target || !files.has(item.target.path) || !/^image\/(jpeg|png|gif|webp|svg\+xml)$/u.test(item.mime)) continue;
    const raw = files.get(item.target.path)!;
    const safe = item.mime === "image/svg+xml" ? sanitizeSvg(raw) : raw;
    assets.push({ key: epubAssetKey(item.target.path), mime: item.mime, data: safe });
  }
  const coverId = xmlText(array(metadata.meta).map(record).find(m => m["@_name"] === "cover")?.["@_content"]);
  const cover = manifest.find(item => /\bcover-image\b/u.test(item.properties)) ?? byId.get(coverId);
  const language = xmlText(array(metadata.language)[0]).toLowerCase();
  const lang: BookLanguage = language.startsWith("zh") ? "zh" : language.startsWith("ja") ? "ja" : "en";
  return { files, spine, nav, assets, footnoteTargets, noteFiles: [...new Set(noteFiles)], metadata: {
    title: normalized(xmlText(array(metadata.title)[0])) || "未命名书籍",
    author: array(metadata.creator).map(xmlText).filter(Boolean).join("; "), language: lang,
    ...(cover?.target && assets.some(a => a.key === epubAssetKey(cover.target!.path)) ? { coverAssetId: epubAssetKey(cover.target.path) } : {}),
  } };
}

function sanitizeSvg(data: Buffer): Buffer {
  const root = parse(data.toString("utf8"));
  const svg = descendants(root).find(n => tag(n) === "svg");
  if (!svg) throw new Error("电子书 SVG 图像无效");
  const allowed = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "use", "title", "desc"]);
  const allowedAttrs = /^(viewBox|width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|fill|stroke|stroke-width|opacity|fill-opacity|stroke-opacity|transform|id|offset|stop-color|stop-opacity|font-size|text-anchor|clip-path|href)$/u;
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
  const render = (node: HtmlNode): string => {
    if ("value" in node) return escape(node.value);
    if (!allowed.has(tag(node))) return "";
    const element = node as HtmlElement;
    const attrs = element.attrs.filter(a => allowedAttrs.test(a.name) && !/url\(\s*(?!#)/iu.test(a.value) && (a.name !== "href" || a.value.startsWith("#")));
    return `<${element.tagName}${element.tagName === "svg" ? ' xmlns="http://www.w3.org/2000/svg"' : ""}${attrs.map(a => ` ${a.name}="${escape(a.value)}"`).join("")}>${children(node).map(render).join("")}</${element.tagName}>`;
  };
  return Buffer.from(render(svg), "utf8");
}

export function readerNodeText(nodes: ReaderNode[]): string {
  return nodes.map(node => node.type === "break" ? "\n" : node.text ?? readerNodeText(node.children ?? [])).join("");
}

export function epubFootnoteKey(file: string, fragment: string) { return `note-${hash(`${file}#${fragment}`)}`; }
export function epubImportFiles(plan: EpubPlan) { return [...plan.spine, ...plan.noteFiles]; }

export function parseEpubFile(plan: EpubPlan, file: string, versionId: number): { blocks: ReaderBlock[]; footnotes: Record<string, ReaderFootnote> } {
  const root = parse(plan.files.get(file)!.toString("utf8"));
  const body = descendants(root).find(n => tag(n) === "body") ?? root;
  const blocks: ReaderBlock[] = [];
  const footnotes: Record<string, ReaderFootnote> = {};
  const assets = new Set(plan.assets.map(a => a.key));
  const navFragments = new Set(plan.nav.filter(item => item.path === file).map(item => item.fragment).filter(Boolean));
  const localNotes = collectFootnotes(body);
  let pendingFragment = "";
  let pendingFragments: string[] = [];
  const noteReference = (node: HtmlNode) => {
    if (tag(node) !== "a") return null;
    const target = resolveEpubHref(file, attr(node, "href"));
    return target && plan.footnoteTargets.has(`${target.path}#${target.fragment}`) ? target : null;
  };
  const inline = (node: HtmlNode, includeNotes = false): ReaderNode[] => {
    const name = tag(node);
    if (unsafeTags.has(name) || (!includeNotes && localNotes.owned.has(node))) return [];
    if ("value" in node) return node.value ? [{ type: "text", text: node.value.replace(/\s+/gu, " ") }] : [];
    if (name === "br") return [{ type: "break" }];
    if (name === "img" || name === "image") return [];
    const nested = () => children(node).flatMap(child => inline(child, includeNotes));
    if (name === "ruby") return [{ type: "ruby", children: children(node).filter(n => !["rt", "rp"].includes(tag(n))).flatMap(child => inline(child, includeNotes)), annotation: normalized(children(node).filter(n => tag(n) === "rt").map(plain).join(" ")) }];
    if (name === "math") {
      const annotation = descendants(node).find(n => tag(n) === "annotation" && /tex/iu.test(attr(n, "encoding")));
      return [{ type: "math", text: normalized(annotation ? plain(annotation) : plain(node)), display: attr(node, "display") === "block" }];
    }
    if (["strong", "b", "em", "i", "code", "kbd", "samp"].includes(name)) return [{ type: name === "strong" || name === "b" ? "strong" : name === "em" || name === "i" ? "emphasis" : "code", children: nested() }];
    if (name === "a") {
      const href = attr(node, "href");
      const target = resolveEpubHref(file, href);
      if (target && noteReference(node)) return [{ type: "footnote", children: nested(), target: epubFootnoteKey(target.path, target.fragment) }];
      if (target) return [{ type: "link", children: nested(), target: `${target.path}#${target.fragment}` }];
      // External URLs are retained as inert readable text, never fetched or navigated.
      return nested();
    }
    const nodes = nested();
    return ["p", "div", "section", "li"].includes(name) && nodes.length ? [...nodes, { type: "break" }] : nodes;
  };
  for (const note of localNotes.sources) {
    const id = epubFootnoteKey(file, note.fragment);
    footnotes[id] = { id, nodes: note.nodes.flatMap(node => inline(node, true)) };
  }
  const sourceFragments = (node: HtmlNode): string[] => {
    if (unsafeTags.has(tag(node)) || localNotes.owned.has(node)) return [];
    return [attr(node, "id"), attr(node, "name"), ...children(node).flatMap(sourceFragments)].filter(Boolean);
  };
  const add = (block: Omit<ReaderBlock, "id" | "anchorText">, node: HtmlNode, fragment = "", fragments?: string[]) => {
    const aliases = [...new Set([...pendingFragments, ...(fragments ?? sourceFragments(node))])];
    const primary = fragment || pendingFragment || aliases.find(alias => navFragments.has(alias)) || "";
    const text = block.kind === "list" ? (block.items ?? []).map(readerNodeText).join("\n") : block.kind === "table" ? (block.rows ?? []).map(row => row.map(readerNodeText).join("\t")).join("\n") : readerNodeText(block.nodes);
    if (!normalized(text) && block.kind !== "image" && block.kind !== "rule") { pendingFragments = aliases; pendingFragment = primary; return; }
    blocks.push({ ...block, id: `v${versionId}-b-${hash(file)}-${blocks.length}`, anchorText: text, source: { path: file, ...(primary ? { fragment: primary } : {}), ...(aliases.length ? { fragments: aliases } : {}) } });
    pendingFragment = "";
    pendingFragments = [];
  };
  type InlineToken = { node: ReaderNode } | { fragment: string } | { image: HtmlNode };
  const inlineTokens = (node: HtmlNode, rootBlock = false): InlineToken[] => {
    if (unsafeTags.has(tag(node)) || localNotes.owned.has(node)) return [];
    const fragment = attr(node, "id") || attr(node, "name");
    const boundary: InlineToken[] = fragment ? [{ fragment }] : [];
    if (["img", "image"].includes(tag(node))) return [...boundary, { image: node }];
    if (["ruby", "math", "br"].includes(tag(node)) || "value" in node || noteReference(node)) return [...boundary, ...inline(node).map(n => ({ node: n }))];
    const tokens = children(node).flatMap(child => inlineTokens(child));
    const name = tag(node);
    const wrapType = name === "strong" || name === "b" ? "strong" : name === "em" || name === "i" ? "emphasis" : ["code", "kbd", "samp"].includes(name) ? "code" : null;
    const link = name === "a" ? resolveEpubHref(file, attr(node, "href")) : null;
    return [...boundary, ...tokens.map(token => "node" in token && wrapType ? { node: { type: wrapType, children: [token.node] } as ReaderNode } : "node" in token && link ? { node: { type: "link", target: `${link.path}#${link.fragment}`, children: [token.node] } as ReaderNode } : token), ...(!rootBlock && ["p", "div", "section", "li"].includes(name) && tokens.length ? [{ node: { type: "break" } as ReaderNode }] : [])];
  };
  const addInlineBlocks = (node: HtmlNode, kind: ReaderBlock["kind"], level?: number) => {
    let nodes: ReaderNode[] = [];
    let fragment = "";
    let fragments: string[] = [];
    const flush = () => {
      if (nodes.length) add({ kind, nodes, ...(level ? { level } : {}) }, node, fragment, fragments);
      else { pendingFragments = [...new Set([...pendingFragments, ...fragments])]; if (fragment) pendingFragment = fragment; }
      nodes = []; fragment = ""; fragments = [];
    };
    for (const token of inlineTokens(node, true)) {
      if ("fragment" in token) {
        // Only table-of-contents boundaries split a semantic paragraph. IDs on
        // footnote references and other inline spans are aliases of this block.
        if (navFragments.has(token.fragment)) { flush(); fragment = token.fragment; }
        fragments.push(token.fragment);
      }
      else if ("image" in token) { flush(); walk(token.image); }
      else nodes.push(token.node);
    }
    flush();
  };
  const walk = (node: HtmlNode) => {
    const name = tag(node);
    if (unsafeTags.has(name) || localNotes.owned.has(node)) return;
    if ("value" in node) { if (normalized(node.value)) add({ kind: "paragraph", nodes: inline(node) }, node); return; }
    if (name === "img" || name === "image") {
      const target = resolveEpubHref(file, attr(node, "src") || attr(node, "href") || attr(node, "xlink:href"));
      if (target && assets.has(epubAssetKey(target.path))) add({ kind: "image", nodes: [], assetId: epubAssetKey(target.path), alt: attr(node, "alt") }, node);
      else if (attr(node, "alt")) add({ kind: "paragraph", nodes: [{ type: "text", text: attr(node, "alt") }] }, node);
      return;
    }
    if (name === "hr") { add({ kind: "rule", nodes: [] }, node); return; }
    if (/^h[1-6]$/u.test(name)) { addInlineBlocks(node, "heading", Number(name[1])); return; }
    if (name === "ul" || name === "ol") { const items = children(node).filter(n => tag(n) === "li" && !localNotes.owned.has(n)).map(li => children(li).flatMap(child => inline(child))); add({ kind: "list", nodes: [], items, ordered: name === "ol" }, node); return; }
    if (name === "table") { const rows = descendants(node).filter(n => tag(n) === "tr").map(row => children(row).filter(cell => ["td", "th"].includes(tag(cell))).map(cell => inline(cell))); add({ kind: "table", nodes: [], rows }, node); return; }
    if (name === "blockquote") { addInlineBlocks(node, "quote"); return; }
    if (name === "pre") { add({ kind: "pre", nodes: [{ type: "text", text: plain(node) }] }, node); return; }
    if (name === "p" || name === "dt" || name === "dd") { addInlineBlocks(node, "paragraph"); return; }
    const start = blocks.length;
    for (const child of children(node)) walk(child);
    // A nav anchor may name a section wrapper rather than its first paragraph.
    const fragment = attr(node, "id") || attr(node, "name");
    if (fragment && blocks[start]) blocks[start].source = { ...blocks[start].source, path: file,
      ...(navFragments.has(fragment) ? { fragment } : {}), fragments: [...new Set([fragment, ...(blocks[start].source?.fragments ?? [])])],
    };
    if (fragment && !blocks[start]) { pendingFragments.push(fragment); if (navFragments.has(fragment)) pendingFragment = fragment; }
  };
  for (const child of children(body)) walk(child);
  return { blocks, footnotes };
}

export function buildEpubChapters(plan: EpubPlan, blocks: ReaderBlock[], versionId: number): BookChapterDraft[] {
  const starts: { navIndex: number; index: number }[] = [];
  for (let i = 0; i < plan.nav.length; i++) {
    const item = plan.nav[i];
    const index = blocks.findIndex(block => block.source?.path === item.path && (!item.fragment || block.source.fragment === item.fragment));
    if (index >= 0 && !starts.some(s => s.index === index)) starts.push({ navIndex: i, index });
  }
  starts.sort((a, b) => a.index - b.index);
  if (!starts.length) {
    for (const file of plan.spine) {
      const index = blocks.findIndex(block => block.source?.path === file);
      if (index >= 0) { const title = blocks.slice(index).find(b => b.source?.path === file && b.kind === "heading")?.anchorText || `章节 ${starts.length + 1}`; plan.nav.push({ title, path: file, fragment: "", parent: null, role: "main" }); starts.push({ navIndex: plan.nav.length - 1, index }); }
    }
  }
  if (starts[0]?.index > 0 || !starts.length) { plan.nav.push({ title: "书前内容", path: blocks[0]?.source?.path ?? "", fragment: "", parent: null, role: "front" }); starts.unshift({ navIndex: plan.nav.length - 1, index: 0 }); }
  const ids = new Map(starts.map((start, order) => [start.navIndex, `v${versionId}-chapter-${String(order + 1).padStart(4, "0")}`]));
  return starts.map((start, order) => {
    const item = plan.nav[start.navIndex];
    let parent = item.parent;
    while (parent !== null && !ids.has(parent)) parent = plan.nav[parent]?.parent ?? null;
    const blockIds = blocks.slice(start.index, starts[order + 1]?.index ?? blocks.length).map(b => b.id);
    return { id: ids.get(start.navIndex)!, title: item.title, parentId: parent === null ? null : ids.get(parent) ?? null, role: item.role, order, blockCount: blockIds.length, blockIds };
  }).filter(chapter => chapter.blockIds.length > 0);
}

export function validateBookChapters(chapters: unknown, blocks: ReaderBlock[], versionId: number): BookChapterDraft[] {
  if (!Array.isArray(chapters) || !chapters.length || chapters.length > 10000) throw new Error("目录必须包含至少一个章节");
  const output: BookChapterDraft[] = [];
  const ids = new Set<string>();
  for (const raw of chapters) {
    const value = record(raw);
    if (typeof value.id !== "string" || !value.id.startsWith(`v${versionId}-`) || !/^[a-zA-Z0-9_-]{1,180}$/u.test(value.id) || ids.has(value.id)) throw new Error("章节 ID 无效或重复");
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 300) throw new Error("章节标题无效");
    if (value.parentId !== null && typeof value.parentId !== "string") throw new Error("章节层级无效");
    if (!["front", "main", "back"].includes(String(value.role))) throw new Error("章节类型无效");
    if (!Array.isArray(value.blockIds) || !value.blockIds.length || value.blockIds.some(id => typeof id !== "string")) throw new Error("章节正文范围无效");
    ids.add(value.id);
    output.push({ id: value.id, title: value.title.trim(), parentId: value.parentId as string | null, role: value.role as BookChapterDraft["role"], order: output.length, blockCount: value.blockIds.length, blockIds: value.blockIds as string[] });
  }
  const all = output.flatMap(chapter => chapter.blockIds);
  if (all.length !== blocks.length || all.some((id, index) => id !== blocks[index].id)) throw new Error("目录必须按原文顺序完整覆盖全部正文，不能遗漏或重复");
  for (const chapter of output) {
    if (chapter.parentId && !ids.has(chapter.parentId)) throw new Error("父章节不存在");
    const visited = new Set([chapter.id]);
    let current = chapter.parentId;
    while (current) { if (visited.has(current)) throw new Error("章节层级不能循环"); visited.add(current); current = output.find(item => item.id === current)!.parentId; }
  }
  return output;
}

function readerLinkMapper(allBlocks: ReaderBlock[], chapters: BookChapterDraft[]) {
  const unitByBlock = new Map(chapters.flatMap(chapter => chapter.blockIds.map(id => [id, chapter.id] as const)));
  const targets = new Map<string, string>();
  const normalizedTargets = new Set<string>();
  for (const block of allBlocks) {
    const unit = unitByBlock.get(block.id);
    if (!unit || !block.source?.path) continue;
    const target = `${unit}#${block.id}`;
    normalizedTargets.add(target); normalizedTargets.add(block.id); normalizedTargets.add(`#${block.id}`);
    const file = `${block.source.path}#`;
    if (!targets.has(file)) targets.set(file, target);
    for (const fragment of new Set([block.source.fragment, ...(block.source.fragments ?? [])].filter(Boolean))) if (!targets.has(`${file}${fragment}`)) targets.set(`${file}${fragment}`, target);
  }
  const mapNodes = (nodes: ReaderNode[]): ReaderNode[] => nodes.map(node => ({ ...node,
    ...(node.children ? { children: mapNodes(node.children) } : {}),
    ...(node.type === "link" && node.target ? { target: targets.get(node.target) ?? (normalizedTargets.has(node.target) ? node.target : undefined) } : {}),
  }));
  return { mapNodes, unitByBlock };
}

export function mapEpubReaderLinks(blocks: ReaderBlock[], allBlocks: ReaderBlock[], chapters: BookChapterDraft[]): ReaderBlock[] {
  const { mapNodes } = readerLinkMapper(allBlocks, chapters);
  return blocks.map(block => ({ ...block, nodes: mapNodes(block.nodes),
    ...(block.items ? { items: block.items.map(mapNodes) } : {}),
    ...(block.rows ? { rows: block.rows.map(row => row.map(mapNodes)) } : {}),
  }));
}

export function mapEpubReaderFootnotes(footnotes: Record<string, ReaderFootnote>, allBlocks: ReaderBlock[], chapters: BookChapterDraft[]): Record<string, ReaderFootnote> {
  const { mapNodes, unitByBlock } = readerLinkMapper(allBlocks, chapters);
  const references = new Map<string, { unitId: string; blockId: string }>();
  const find = (nodes: ReaderNode[], block: ReaderBlock) => {
    for (const node of nodes) {
      const unitId = unitByBlock.get(block.id);
      if (node.type === "footnote" && node.target && unitId && !references.has(node.target)) references.set(node.target, { unitId, blockId: block.id });
      if (node.children) find(node.children, block);
    }
  };
  for (const block of allBlocks) {
    find(block.nodes, block);
    for (const item of block.items ?? []) find(item, block);
    for (const row of block.rows ?? []) for (const cell of row) find(cell, block);
  }
  return Object.fromEntries(Object.entries(footnotes).map(([key, note]) => [key, { ...note, ...references.get(key), nodes: mapNodes(note.nodes) }]));
}
