import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { BookImportDraft, ReaderNode } from "@/lib/types";
import { buildEpubChapters, buildEpubPlan, epubFootnoteKey, epubImportFiles, mapEpubReaderFootnotes, mapEpubReaderLinks, parseEpubFile, readerNodeText, readEpubArchive, resolveEpubHref, safeArchivePath, validateBookChapters } from "./book-epub";
import { remapBookImportDraft } from "./book-draft";
import { getMobiCapability } from "./book-mobi";

type HtmlNode = DefaultTreeAdapterMap["node"];
const htmlChildren = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const htmlDescendants = (node: HtmlNode): HtmlNode[] => htmlChildren(node).flatMap(child => [child, ...htmlDescendants(child)]);
const htmlPlain = (node: HtmlNode): string => "value" in node ? node.value : htmlChildren(node).map(htmlPlain).join("");
const htmlAttr = (node: HtmlNode, key: string) => "attrs" in node ? node.attrs.find(attr => attr.name === key)?.value ?? "" : "";
const canonical = (text: string) => text.replace(/\s+/gu, "");
const readerNodes = (nodes: ReaderNode[]): ReaderNode[] => nodes.flatMap(node => [node, ...readerNodes(node.children ?? [])]);

let plato: ReturnType<typeof loadPlato> | undefined;
async function loadPlato() {
  const source = await readFile("books/Selected Dialogues of Plato.epub");
  assert.equal(createHash("sha256").update(source).digest("hex"), "fe57ba5bc471550ac502b2256bf4291a011279428523c6f309fbdd8fea8500bb");
  const plan = await buildEpubPlan(source);
  const parts = plan.spine.map(file => parseEpubFile(plan, file, 41));
  const blocks = parts.flatMap(part => part.blocks);
  const chapters = validateBookChapters(buildEpubChapters(plan, blocks, 41), blocks, 41);
  const rawNotes = Object.assign({}, ...parts.map(part => part.footnotes)) as BookImportDraft["footnotes"];
  const footnotes = mapEpubReaderFootnotes(rawNotes, blocks, chapters);
  const bodies = new Map(plan.spine.map(file => [file, htmlDescendants(parse(plan.files.get(file)!.toString("utf8"))).find(node => "tagName" in node && node.tagName === "body")!]));
  return { plan, parts, blocks, chapters, rawNotes, footnotes, bodies };
}
function bundledPlato() { return plato ??= loadPlato(); }

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP fixtures avoid invoking external converters or filesystem tools.
function zip(files: Record<string, string | Buffer>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const fileName = Buffer.from(name);
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, data);
    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt32LE(crc32(data), 16);
    item.writeUInt32LE(data.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(fileName.length, 28); item.writeUInt32LE(offset, 42);
    central.push(item, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function epub(body: string, nav = '<li><a href="body.xhtml#one">第一章</a></li><li><a href="body.xhtml#two">第二章</a></li>', extra: Record<string, string> = {}) {
  return zip({
    "mimetype": "application/epub+zip",
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": `<package version="3.0"><metadata><title>测试书</title><creator>作者</creator><language>zh-CN</language></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="image" href="image.svg" media-type="image/svg+xml"/><item id="font" href="unsafe.ttf" media-type="font/ttf"/>${Object.keys(extra).filter(file => file.endsWith(".xhtml")).map((file, index) => `<item id="extra${index}" href="${file.replace(/^OPS\//u, "")}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine><itemref idref="body"/></spine></package>`,
    "OPS/nav.xhtml": `<html><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`,
    "OPS/body.xhtml": `<html><body>${body}</body></html>`,
    "OPS/image.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><rect width="20" height="20"/><image href="https://evil.test/a"/></svg>',
    "OPS/unsafe.ttf": "unused-font",
    ...extra,
  });
}

test("bundled Plato preserves all spine content inside five logical dialogues", async () => {
  const { plan, parts, blocks, chapters, footnotes, bodies } = await bundledPlato();
  assert.equal(plan.spine.length, 23);
  assert.equal(plan.metadata.author, "Plato");
  assert.deepEqual(chapters.filter(chapter => chapter.role === "main").map(chapter => chapter.title), ["Ion", "Protagoras", "Phaedrus", "Symposium", "Apology"]);
  const expected = [
    { title: "Ion", files: ["p01", "c01"], chars: 28289, notes: 29 },
    { title: "Protagoras", files: ["p02", "c02"], chars: 119319, notes: 63 },
    { title: "Phaedrus", files: ["p03", "c03"], chars: 119648, notes: 59 },
    { title: "Symposium", files: ["p04", "c04", "c05", "c06"], chars: 111409, notes: 58 },
    { title: "Apology", files: ["p05", "c07", "c08", "c09"], chars: 62022, notes: 43 },
  ];
  for (const entry of expected) {
    const chapter = chapters.find(chapter => chapter.title === entry.title)!;
    const chapterBlocks = blocks.filter(block => chapter.blockIds.includes(block.id));
    const chapterNotes = Object.values(footnotes).filter(note => note.unitId === chapter.id);
    const files = [...new Set(chapterBlocks.map(block => { assert.ok(block.source?.path); return block.source.path; }))];
    assert.deepEqual(files.map(file => file.match(/_([pc]\d+)_r1\.htm$/u)![1]), entry.files);
    const sourceChars = files.reduce((length, file) => length + canonical(htmlPlain(bodies.get(file)!)).length, 0);
    const preservedChars = chapterBlocks.reduce((length, block) => length + canonical(block.anchorText).length, 0) + chapterNotes.reduce((length, note) => length + canonical(readerNodeText(note.nodes)).length, 0);
    assert.equal(chapterNotes.length, entry.notes);
    assert.equal(sourceChars, entry.chars, "independent source text measurement stays fixed");
    assert.equal(preservedChars, sourceChars, `${entry.title} preserves body and notes exactly once`);
  }
  const sourceChars = [...bodies.values()].reduce((length, body) => length + canonical(htmlPlain(body)).length, 0);
  const bodyChars = blocks.reduce((length, block) => length + canonical(block.anchorText).length, 0);
  const noteChars = Object.values(footnotes).reduce((length, note) => length + canonical(readerNodeText(note.nodes)).length, 0);
  assert.equal(sourceChars, 466598);
  assert.equal(bodyChars + noteChars, sourceChars);
  assert.deepEqual(chapters.flatMap(chapter => chapter.blockIds), blocks.map(block => block.id));
  for (const file of plan.spine) assert.deepEqual(parseEpubFile(plan, file, 41), parts[plan.spine.indexOf(file)], "checkpoint resume preserves stable block IDs");
  assert.ok(plan.assets.every(asset => asset.mime.startsWith("image/") && !asset.data.toString().includes("@font-face")));
});

test("all 254 real Plato footnotes preserve source text and resolve local and cross-file popups", async () => {
  const { plan, blocks, chapters, rawNotes, footnotes, bodies } = await bundledPlato();
  assert.equal(plan.footnoteTargets.size, 254);
  assert.equal(Object.keys(footnotes).length, 254);
  let sourceCount = 0;
  for (const [file, body] of bodies) {
    const noteParagraphs = htmlDescendants(body).filter(node => htmlAttr(node, "class").split(/\s+/u).includes("footnote")).flatMap(container => htmlDescendants(container).filter(node => "tagName" in node && node.tagName === "p" && htmlAttr(node, "id")));
    for (const sourceNote of noteParagraphs) {
      const key = epubFootnoteKey(file, htmlAttr(sourceNote, "id"));
      assert.ok(rawNotes[key]);
      assert.equal(canonical(readerNodeText(rawNotes[key].nodes)), canonical(htmlPlain(sourceNote)), key);
      assert.ok(footnotes[key].unitId && footnotes[key].blockId);
      sourceCount++;
    }
  }
  assert.equal(sourceCount, 254);
  const allReferences = blocks.flatMap(block => readerNodes([...block.nodes, ...(block.items ?? []).flat(), ...(block.rows ?? []).flat(2)]).filter(node => node.type === "footnote").map(node => ({ block, node })));
  assert.equal(new Set(allReferences.map(reference => reference.node.target)).size, 254);
  for (const reference of allReferences) assert.ok(footnotes[reference.node.target!]);
  for (const entry of [
    { definition: "c01", fragment: "c01-ftn1", reference: "c01", chapter: "Ion", text: "In ancient Greece, poetry was performed before an audience" },
    { definition: "c09", fragment: "c07-ftn210", reference: "c07", chapter: "Apology", text: "The jury before whom Socrates was tried was composed of five hundred Athenian citizens" },
  ]) {
    const file = plan.spine.find(file => file.includes(`_${entry.definition}_`))!;
    const key = epubFootnoteKey(file, entry.fragment);
    const reference = allReferences.find(reference => reference.node.target === key)!;
    assert.ok(reference.block.source?.path?.includes(`_${entry.reference}_`));
    assert.ok(reference.block.source?.fragments?.includes(`${entry.fragment}a`));
    const sourceBody = bodies.get(reference.block.source!.path!)!;
    const sourceReference = htmlDescendants(sourceBody).find(node => htmlAttr(node, "id") === `${entry.fragment}a`)!;
    let paragraph = sourceReference;
    while (!("tagName" in paragraph && paragraph.tagName === "p") && "parentNode" in paragraph && paragraph.parentNode) paragraph = paragraph.parentNode;
    assert.ok("tagName" in paragraph && paragraph.tagName === "p");
    assert.equal(canonical(reference.block.anchorText), canonical(htmlPlain(paragraph)), "footnote stays within its full original prose paragraph");
    assert.equal(readerNodeText(reference.node.children ?? []), "1");
    assert.ok(readerNodeText(footnotes[key].nodes).includes(entry.text));
    const chapter = chapters.find(chapter => chapter.title === entry.chapter)!;
    assert.equal(footnotes[key].unitId, chapter.id);
    assert.equal(footnotes[key].blockId, reference.block.id);
    assert.equal(readerNodes(footnotes[key].nodes).find(node => node.type === "link")!.target, `${chapter.id}#${reference.block.id}`);
    assert.ok(!blocks.map(block => canonical(block.anchorText)).join("").includes(canonical(readerNodeText(footnotes[key].nodes))), "note text is kept once in popup content");
  }
});

test("every real Plato footnote stays inline in its original paragraph with a working alias backlink", async () => {
  const { blocks, footnotes, bodies } = await bundledPlato();
  let references = 0;
  for (const block of blocks) {
    const notes = readerNodes(block.nodes).filter(node => node.type === "footnote");
    for (const note of notes) {
      const backlink = readerNodes(footnotes[note.target!].nodes).find(node => node.type === "link")!;
      assert.equal(backlink.target, `${footnotes[note.target!].unitId}#${block.id}`);
      assert.ok(block.anchorText.length > readerNodeText(note.children ?? []).length, "footnote number must not become a standalone paragraph");
      const aliases = new Set(block.source?.fragments ?? []);
      const matching = htmlDescendants(bodies.get(block.source!.path!)!).find(node => "tagName" in node && node.tagName === "p" && htmlDescendants(node).some(child => aliases.has(htmlAttr(child, "id")) && htmlAttr(child, "href").includes("ftn")));
      assert.ok(matching, "inline note alias belongs to a source paragraph");
      assert.equal(canonical(block.anchorText), canonical(htmlPlain(matching)), "entire original paragraph is preserved as one logical block");
      references++;
    }
  }
  assert.equal(references, 254);
});

test("ordinary inline IDs are block aliases while nav anchors alone split paragraphs", async () => {
  const plan = await buildEpubPlan(epub('<p id="paragraph"><a id="one"></a>甲<span id="ordinary">乙</span><a name="named"></a>丙<a href="#n1" id="ref"><sup>1</sup></a>丁<a id="two"></a>戊<span id="later">己</span></p><p><a href="#ordinary">回到乙</a><a href="#named">回到丙</a><a href="#later">去己</a></p><div class="footnote"><p id="n1"><a href="#ref">1</a>注释</p></div>'));
  const { blocks, footnotes } = parseEpubFile(plan, plan.spine[0], 12);
  const chapters = buildEpubChapters(plan, blocks, 12);
  assert.deepEqual(blocks.map(block => block.anchorText), ["甲乙丙1丁", "戊己", "回到乙回到丙去己"]);
  assert.equal(blocks[0].source?.fragment, "one");
  assert.equal(blocks[1].source?.fragment, "two");
  assert.deepEqual(new Set(blocks[0].source?.fragments), new Set(["paragraph", "one", "ordinary", "named", "ref"]));
  assert.deepEqual(new Set(blocks[1].source?.fragments), new Set(["two", "later"]));
  const mapped = mapEpubReaderLinks(blocks, blocks, chapters);
  assert.deepEqual(readerNodes(mapped[2].nodes).filter(node => node.type === "link").map(node => node.target), [`${chapters[0].id}#${blocks[0].id}`, `${chapters[0].id}#${blocks[0].id}`, `${chapters[1].id}#${blocks[1].id}`]);
  const note = mapEpubReaderFootnotes(footnotes, blocks, chapters)[epubFootnoteKey("OPS/body.xhtml", "n1")];
  assert.equal(readerNodes(note.nodes).find(node => node.type === "link")!.target, `${chapters[0].id}#${blocks[0].id}`);
});

test("legacy note containers keep continuations and superscript links only target verified notes", async () => {
  const plan = await buildEpubPlan(epub('<h1 id="one">正文</h1><p>内容<a href="#n1" id="n1ref"><sup>1</sup></a><a href="#ordinary"><sup>2</sup></a></p><p id="ordinary">普通位置</p><div class="footnote"><p id="n1"><a href="#n1ref">1</a>第一条注释</p><p>续段</p><p id="n2">第二条注释</p></div><h1 id="two">后文</h1>'));
  const { blocks, footnotes } = parseEpubFile(plan, plan.spine[0], 6);
  const nodes = blocks.flatMap(block => readerNodes(block.nodes));
  assert.equal(nodes.filter(node => node.type === "footnote").length, 1);
  assert.equal(nodes.find(node => node.type === "link" && readerNodeText(node.children ?? []) === "2")?.target, "OPS/body.xhtml#ordinary");
  assert.equal(Object.keys(footnotes).length, 2);
  assert.equal(canonical(readerNodeText(footnotes[epubFootnoteKey("OPS/body.xhtml", "n1")].nodes)), "1第一条注释续段");
  assert.ok(!blocks.some(block => block.anchorText.includes("注释") || block.anchorText.includes("续段")));
});

test("referenced sidecar notes outside the spine are imported without body chapters", async () => {
  const plan = await buildEpubPlan(epub('<h1 id="one">正文</h1><p><a href="notes.xhtml#side"><sup>1</sup></a>正文</p><h1 id="two">后文</h1>', undefined, { "OPS/notes.xhtml": '<html><body><h1>附注</h1><aside epub:type="footnote" id="side">独立文件脚注</aside></body></html>' }));
  assert.deepEqual(plan.spine, ["OPS/body.xhtml"]);
  assert.deepEqual(epubImportFiles(plan), ["OPS/body.xhtml", "OPS/notes.xhtml"]);
  const chunks = epubImportFiles(plan).map(file => ({ file, parsed: parseEpubFile(plan, file, 8) }));
  const bodyBlocks = chunks.filter(chunk => plan.spine.includes(chunk.file)).flatMap(chunk => chunk.parsed.blocks);
  const notes = Object.assign({}, ...chunks.map(chunk => chunk.parsed.footnotes));
  const reference = bodyBlocks.flatMap(block => readerNodes(block.nodes)).find(node => node.type === "footnote")!;
  assert.equal(reference.target, epubFootnoteKey("OPS/notes.xhtml", "side"));
  assert.equal(readerNodeText(notes[reference.target!].nodes), "独立文件脚注");
  assert.ok(!bodyBlocks.some(block => block.anchorText.includes("附注") || block.anchorText.includes("独立文件")));
});

test("published draft clones preserve note identities and remap source and normalized backlinks", async () => {
  const { plan, blocks, chapters, rawNotes, footnotes } = await bundledPlato();
  const base: BookImportDraft = { blocks, chapters, footnotes: rawNotes, processedFiles: plan.spine, totalFiles: plan.spine.length, metadata: plan.metadata };
  for (const draft of [base, { ...base, blocks: mapEpubReaderLinks(blocks, blocks, chapters), footnotes }]) {
    const original = JSON.stringify(draft);
    const clone = remapBookImportDraft(draft, 42);
    assert.equal(JSON.stringify(draft), original, "published draft remains immutable");
    assert.deepEqual(Object.keys(clone.footnotes), Object.keys(draft.footnotes));
    assert.deepEqual(clone.blocks.map(block => block.source), draft.blocks.map(block => block.source));
    assert.ok(clone.blocks.every(block => block.id.startsWith("v42-")));
    assert.ok(clone.chapters.every(chapter => chapter.id.startsWith("v42-")));
    const mapped = mapEpubReaderFootnotes(clone.footnotes, clone.blocks, clone.chapters);
    for (const note of Object.values(mapped)) {
      assert.ok(note.unitId?.startsWith("v42-") && note.blockId?.startsWith("v42-"));
      for (const node of readerNodes(note.nodes).filter(node => node.type === "link")) assert.ok(node.target?.startsWith("v42-") && !node.target.includes("v41-"));
    }
    const references = clone.blocks.flatMap(block => readerNodes(block.nodes)).filter(node => node.type === "footnote");
    for (const reference of references) assert.ok(mapped[reference.target!]);
    const crossFile = epubFootnoteKey(plan.spine.find(file => file.includes("_c09_"))!, "c07-ftn210");
    assert.ok(readerNodes(mapped[crossFile].nodes).some(node => node.type === "link" && node.target?.startsWith("v42-chapter-0011#v42-b-")));
  }
});

test("directory clones remove upload idempotency metadata without mutating the original upload", async () => {
  const { plan, blocks, chapters, rawNotes } = await bundledPlato();
  const uploaded = { ...plan.metadata, requestId: "original-upload-request", inputHash: "original-upload-hash", requestedTitle: "个人书名", kind: "literary" };
  const draft: BookImportDraft = { blocks, chapters, footnotes: rawNotes, processedFiles: plan.spine, totalFiles: plan.spine.length, metadata: uploaded };
  const clone = remapBookImportDraft(draft, 42);
  assert.deepEqual(clone.metadata, { ...plan.metadata, requestedTitle: "个人书名", kind: "literary" });
  assert.equal("requestId" in clone.metadata, false);
  assert.equal("inputHash" in clone.metadata, false);
  assert.equal(uploaded.requestId, "original-upload-request");
  assert.equal(uploaded.inputHash, "original-upload-hash");
  const next = remapBookImportDraft(clone, 43);
  assert.deepEqual(next.metadata, clone.metadata);
  // Legacy clones also lose these fields when copied forward; their old source
  // metadata stays untouched so the original upload remains replayable.
  const legacyClone: BookImportDraft = { ...clone, metadata: { ...uploaded } };
  const repaired = remapBookImportDraft(legacyClone, 44);
  assert.equal("requestId" in repaired.metadata, false);
  assert.equal("inputHash" in repaired.metadata, false);
  assert.deepEqual(draft.metadata, uploaded);
});

function encryptionXml(entries: { algorithm: string; uri: string }[]) {
  return `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">${entries.map(entry => `<enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptionMethod Algorithm="${entry.algorithm}"/><enc:CipherData><enc:CipherReference URI="${entry.uri}"/></enc:CipherData></enc:EncryptedData>`).join("")}</encryption>`;
}

test("IDPF and Adobe font obfuscation are accepted without exposing source fonts", async () => {
  for (const algorithm of ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]) {
    const plan = await buildEpubPlan(epub('<h1 id="one">正常正文</h1><p>内容</p><h1 id="two">后文</h1>', undefined, { "META-INF/encryption.xml": encryptionXml([{ algorithm, uri: "OPS/unsafe.ttf" }]) }));
    assert.equal(plan.spine.length, 1);
    assert.ok(!plan.assets.some(asset => asset.mime.includes("font") || asset.key.includes("unsafe")));
    assert.ok(parseEpubFile(plan, plan.spine[0], 5).blocks.some(block => block.anchorText === "正常正文"));
  }
});

test("body, image, mixed and unknown encryption fail even beside allowed font obfuscation", async () => {
  const valid = { algorithm: "http://ns.adobe.com/pdf/enc#RC", uri: "OPS/unsafe.ttf" };
  for (const invalid of [
    { ...valid, uri: "OPS/body.xhtml" },
    { ...valid, uri: "OPS/image.svg" },
    { ...valid, uri: "OPS/missing.ttf" },
    { ...valid, uri: "https://example.test/font.ttf" },
    { ...valid, algorithm: "http://www.w3.org/2001/04/xmlenc#aes256-cbc" },
    { ...valid, algorithm: "http://unknown.test/embedding-obfuscation" },
  ]) {
    await assert.rejects(buildEpubPlan(epub('<h1 id="one">正文</h1><h1 id="two">后文</h1>', undefined, { "META-INF/encryption.xml": encryptionXml([invalid]) })), /DRM/u);
    await assert.rejects(buildEpubPlan(epub('<h1 id="one">正文</h1><h1 id="two">后文</h1>', undefined, { "META-INF/encryption.xml": encryptionXml([valid, invalid]) })), /DRM/u);
  }
  const opf = '<package><metadata><title>字体类型伪装</title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="font" href="unsafe.ttf" media-type="image/png"/></manifest><spine><itemref idref="body"/></spine></package>';
  await assert.rejects(buildEpubPlan(epub('<h1 id="one">正文</h1>', undefined, { "OPS/book.opf": opf, "META-INF/encryption.xml": encryptionXml([valid]) })), /DRM/u);
});

test("EPUB3 nav anchors split within an XHTML paragraph and preserve text order", async () => {
  const plan = await buildEpubPlan(epub('<p><a id="one"></a><strong>甲一。</strong>甲二。<a id="two"></a><em>乙一。</em>乙二。</p>'));
  const parsed = parseEpubFile(plan, plan.spine[0], 7);
  const chapters = buildEpubChapters(plan, parsed.blocks, 7);
  assert.equal(chapters.length, 2);
  assert.deepEqual(parsed.blocks.map(block => block.anchorText), ["甲一。甲二。", "乙一。乙二。"]);
  assert.deepEqual(parsed.blocks.map(block => block.source?.fragment), ["one", "two"]);
  assert.deepEqual(chapters.map(chapter => chapter.blockIds), [[parsed.blocks[0].id], [parsed.blocks[1].id]]);
});

test("safe structured AST preserves ruby, table, list, notes and math without active source markup", async () => {
  const plan = await buildEpubPlan(epub('<h1 id="one">题目</h1><p>前文<strong>重点</strong><ruby>漢字<rt>かんじ</rt></ruby><a epub:type="noteref" href="#note1">1</a><img src="image.svg"/>后文<a href="https://evil.test/">外链</a></p><table><tr><td>A</td><td>B</td></tr></table><ul><li>一</li><li>二</li></ul><p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></p><aside epub:type="footnote" id="note1">脚注正文</aside><script>evil script</script><style>.evil{}</style><h2 id="two">第二题</h2>'));
  const { blocks, footnotes } = parseEpubFile(plan, plan.spine[0], 9);
  assert.ok(blocks.some(block => block.kind === "table" && block.anchorText === "A\tB"));
  assert.ok(blocks.some(block => block.kind === "list" && block.anchorText === "一\n二"));
  assert.ok(blocks.some(block => block.nodes.some(node => node.type === "ruby" && node.annotation === "かんじ")));
  assert.ok(blocks.some(block => block.nodes.some(node => node.type === "math" && node.text === "x^2")));
  assert.equal(Object.values(footnotes)[0].nodes[0].text, "脚注正文");
  assert.ok(!JSON.stringify(blocks).includes("evil script"));
  assert.ok(!JSON.stringify(blocks).includes("https://evil"));
  assert.ok(!plan.assets[0].data.toString().includes("script"));
  assert.ok(!plan.assets[0].data.toString().includes("onload"));
  assert.equal(plan.assets.length, 1);
  const image = blocks.findIndex(block => block.kind === "image");
  assert.ok(blocks[image - 1].anchorText.includes("前文"));
  assert.ok(blocks[image + 1].anchorText.startsWith("后文"));
});

test("internal links map to version-specific unit and block targets", async () => {
  const plan = await buildEpubPlan(epub('<h1 id="one">首章</h1><p><a href="#two">去第二章</a></p><h1 id="two">次章</h1><p>内容</p>'));
  const { blocks } = parseEpubFile(plan, plan.spine[0], 10);
  const chapters = buildEpubChapters(plan, blocks, 10);
  const mapped = mapEpubReaderLinks(blocks, blocks, chapters);
  assert.equal(mapped[1].nodes[0].target, `${chapters[1].id}#${blocks[2].id}`);
  assert.deepEqual(mapped.map(block => block.anchorText), blocks.map(block => block.anchorText));
});

test("directory correction rejects omissions, repeats, reordering and hierarchy cycles", async () => {
  const plan = await buildEpubPlan(epub('<h1 id="one">甲</h1><p>甲文</p><h1 id="two">乙</h1><p>乙文</p>'));
  const { blocks } = parseEpubFile(plan, plan.spine[0], 3);
  const chapters = buildEpubChapters(plan, blocks, 3);
  assert.throws(() => validateBookChapters([{ ...chapters[0], blockIds: chapters[0].blockIds.slice(1) }, chapters[1]], blocks, 3), /完整覆盖/u);
  assert.throws(() => validateBookChapters([{ ...chapters[0], blockIds: [...chapters[0].blockIds, chapters[0].blockIds[0]] }, chapters[1]], blocks, 3), /完整覆盖/u);
  assert.throws(() => validateBookChapters([...chapters].reverse(), blocks, 3), /原文顺序/u);
  assert.throws(() => validateBookChapters([{ ...chapters[0], parentId: chapters[1].id }, { ...chapters[1], parentId: chapters[0].id }], blocks, 3), /循环/u);
  assert.throws(() => validateBookChapters(chapters, blocks, 4), /ID/u);
  const merged = [{ ...chapters[0], title: "合并", blockIds: chapters.flatMap(chapter => chapter.blockIds) }];
  assert.equal(validateBookChapters(merged, blocks, 3).length, 1);
  const split = blocks.map((block, index) => ({ id: `v3-split-${index}`, title: String(index), parentId: null, role: "main", blockIds: [block.id] }));
  assert.equal(validateBookChapters(split, blocks, 3).length, blocks.length);
});

test("archive and href path checks prevent traversal and external resources", async () => {
  for (const value of ["../outside", "/absolute", "C:/windows", "a\\b", "a/../b"]) assert.throws(() => safeArchivePath(value));
  assert.equal(resolveEpubHref("OPS/body.xhtml", "https://example.test/image.jpg"), null);
  assert.deepEqual(resolveEpubHref("OPS/body.xhtml", "../images/a.png#fragment"), { path: "images/a.png", fragment: "fragment" });
  assert.throws(() => resolveEpubHref("OPS/body.xhtml", "../../outside"));
  assert.throws(() => resolveEpubHref("OPS/body.xhtml", "%2e%2e/%2e%2e/outside"));
  await assert.rejects(readEpubArchive(zip({ "../outside": "bad" })));
  await assert.rejects(readEpubArchive(Buffer.from("not a zip")), /压缩包/u);
});

test("archive declared expansion limit is enforced before decompressing", async () => {
  const data = zip({ "large": "x" });
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  data.writeUInt32LE(257 * 1024 * 1024, central + 24);
  await assert.rejects(readEpubArchive(data), /256 MiB|mismatch/u);
});

test("MOBI reports missing explicit converter configuration", async () => {
  const prior = process.env.CALIBRE_EBOOK_CONVERT;
  try { delete process.env.CALIBRE_EBOOK_CONVERT; const value = await getMobiCapability(); assert.equal(value.available, false); assert.match(value.error!, /CALIBRE_EBOOK_CONVERT/u); }
  finally { if (prior === undefined) delete process.env.CALIBRE_EBOOK_CONVERT; else process.env.CALIBRE_EBOOK_CONVERT = prior; }
});
