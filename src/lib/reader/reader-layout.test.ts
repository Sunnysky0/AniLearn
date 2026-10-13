import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ReaderPosition, ReaderProps } from "@/lib/book-types";
import * as anchors from "./anchors";
import { currentReaderPosition, readerRange } from "./dom-selection";

test("a canonical offset at a rich-text boundary belongs to the following visible leaf", () => {
  const oldWindow = globalThis.window; const oldNode = globalThis.Node;
  const a = { nodeType: 3, textContent: "first" }; const b = { nodeType: 3, textContent: "second" };
  const leaves = [{ dataset: { readerStart: "0", readerEnd: "5" }, firstChild: a, closest: () => null },
    { dataset: { readerStart: "5", readerEnd: "11" }, firstChild: b, closest: () => null }];
  const block = { dataset: { readerBlock: "b" }, querySelectorAll: () => leaves, checkVisibility: () => true };
  let start: { node: unknown; offset: number } | null = null;
  globalThis.Node = { TEXT_NODE: 3 } as unknown as typeof Node;
  globalThis.window = { document: { createRange: () => ({ setStart: (node: unknown, offset: number) => { start = { node, offset }; }, setEnd() {} }) } } as unknown as Window & typeof globalThis;
  try {
    readerRange({ querySelectorAll: () => [block] } as unknown as HTMLElement, "b", 5);
    assert.deepEqual(start, { node: b, offset: 0 });
  } finally { globalThis.window = oldWindow; globalThis.Node = oldNode; }
});

test("skipped groups with stale in-viewport rectangles never replace the actually visible block", () => {
  const oldWindow = globalThis.window; const oldNode = globalThis.Node;
  const visibilityChecks: CheckVisibilityOptions[] = [];
  const makeBlock = (id: string, rendered: boolean) => {
    const leaf = { dataset: { readerStart: "0", readerEnd: "24", readerAtomic: "" }, firstChild: null, closest: () => null,
      getBoundingClientRect: () => ({ top: 128, bottom: 168, height: 40 }) };
    return { dataset: { readerBlock: id }, querySelectorAll: () => [leaf],
      getBoundingClientRect: () => ({ top: 128, bottom: 200 }),
      checkVisibility: (options: CheckVisibilityOptions) => { visibilityChecks.push(options); return rendered; } };
  };
  const skipped = makeBlock("b74", false); const actual = makeBlock("b160", true);
  const root = { querySelectorAll: () => [skipped, actual], getBoundingClientRect: () => ({ top: 100 }) } as unknown as HTMLElement;
  const document = { key: "article:1", title: "Article", language: "en", unitId: "article", units: [],
    blocks: ["b74", "b160"].map(id => ({ id, kind: "paragraph" as const, nodes: [{ type: "text" as const, text: "visible text" }], anchorText: "visible text" })) };
  globalThis.Node = { TEXT_NODE: 3 } as unknown as typeof Node;
  globalThis.window = { document: { createRange: () => ({ selectNode() {}, getBoundingClientRect: () => ({ top: 128, height: 40 }) }) } } as unknown as Window & typeof globalThis;
  try {
    assert.equal(currentReaderPosition(root, document)?.blockId, "b160");
    assert.equal(readerRange(root, "b74", 0), null);
    assert.ok(visibilityChecks.every(options => options.contentVisibilityAuto === true));
    assert.equal(currentReaderPosition({ ...root, querySelectorAll: () => [skipped] } as unknown as HTMLElement, document), null);
  } finally { globalThis.window = oldWindow; globalThis.Node = oldNode; }
});

test("layout changes retain one character through rapid typography, banner removal, resize and late font layout", () => {
  const slots: any[] = []; let cursor = 0; const effects: (() => void)[] = []; const layout: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((value, index) => value === b[index]);
  const effect = (callback: () => void, dependencies: any[], queue: (() => void)[]) => {
    const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) {
      slots[id]?.cleanup?.(); slots[id] = { dependencies }; queue.push(() => { slots[id].cleanup = callback(); });
    }
  };
  const react = {
    Fragment: "Fragment", useState(initial: any) { const id = cursor++; slots[id] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[id].value, (value: any) => { slots[id].value = typeof value === "function" ? value(slots[id].value) : value; }]; },
    useRef(initial: any) { const id = cursor++; slots[id] ??= { current: initial }; return slots[id]; },
    useCallback(callback: any, dependencies: any[]) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) slots[id] = { callback, dependencies }; return slots[id].callback; },
    useMemo(callback: any, dependencies: any[]) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) slots[id] = { value: callback(), dependencies }; return slots[id].value; },
    useEffect(callback: any, dependencies: any[]) { effect(callback, dependencies, effects); }, useLayoutEffect(callback: any, dependencies: any[]) { effect(callback, dependencies, layout); },
  };
  let nextFrame = 1; const frames = new Map<number, FrameRequestCallback>();
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, window: globalThis.window, localStorage: globalThis.localStorage, ResizeObserver: globalThis.ResizeObserver };
  let resize!: () => void; const fontEvents = new Map<string, () => void>(); const listeners = new Map<string, () => void>();
  let rootTop = 100; let width = 1000; let shift = 0; let captures = 0;
  const position: ReaderPosition = { documentKey: "book:1:version:1", unitId: "c1", blockId: "b0", offset: 64, viewportOffset: 11 };
  const scroll = { scrollTop: 1000, scrollHeight: 4000, getBoundingClientRect: () => ({ top: rootTop, width }), addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) };
  const characterTop = (offset: number) => rootTop + 1011 + shift + (offset - 64) * 2 - scroll.scrollTop;
  globalThis.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  globalThis.window = { document: { fonts: { addEventListener: (name: string, callback: () => void) => fontEvents.set(name, callback), removeEventListener: (name: string) => fontEvents.delete(name) } } } as unknown as Window & typeof globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
  globalThis.ResizeObserver = class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  const compiled = ts.transpileModule(readFileSync("src/components/reader/Reader.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const dependencies: Record<string, unknown> = {
    react, "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "lucide-react": new Proxy({}, { get: (_target, name) => String(name) }), "@/components/Markdown": { Markdown: "Markdown" },
    "@/lib/reader/anchors": anchors, "@/lib/reader/canonical": { safeReaderHref: () => undefined }, "./reader.module.css": { __esModule: true, default: new Proxy({}, { get: (_target, name) => String(name) }) },
    "@/lib/reader/dom-selection": { readerElement: () => ({ getBoundingClientRect: () => ({ top: characterTop(64) }) }),
      readerRange: (_root: unknown, _id: string, offset: number) => ({ getBoundingClientRect: () => ({ top: characterTop(offset), height: 20 }) }),
      currentReaderPosition: () => { captures++; return { ...position, offset: 64 + Math.round((scroll.scrollTop - 1000 - shift) / 2), viewportOffset: 11 }; } },
  };
  const loaded = { exports: {} as { default: (props: any) => any } }; new Function("require", "module", "exports", compiled)((name: string) => dependencies[name], loaded, loaded.exports);
  const props: ReaderProps = { document: { key: position.documentKey, title: "Title", language: "en", unitId: "c1", units: [], blocks: Array.from({ length: 200 }, (_, index) => ({ id: `b${index}`, kind: "paragraph", nodes: [{ type: "text", text: "x".repeat(100) }], anchorText: "x".repeat(100) })) }, initialPosition: position };
  let tree: any;
  const find = (node: any, predicate: (value: any) => boolean): any => {
    if (predicate(node)) return node;
    for (const child of Array.isArray(node) ? node : node?.props?.children ? [node.props.children] : []) { const found = find(child, predicate); if (found) return found; }
    return null;
  };
  const commit = () => {
    cursor = 0; tree = loaded.exports.default(props);
    const root = find(tree, node => node?.props?.["aria-label"] === "阅读正文"); root.props.ref.current = scroll;
    for (const callback of layout.splice(0)) callback(); for (const callback of effects.splice(0)) callback();
  };
  const tick = () => { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(0); };
  const settle = () => { for (let index = 0; index < 16; index++) tick(); };
  const text = (node: any): string => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node?.props?.children ? text(node.props.children) : "";
  const click = (label: string) => { const button = find(tree, node => node?.type === "button" && (node.props?.["aria-label"] === label || text(node) === label)); assert.ok(button, label); button.props.onClick(); };
  try {
    commit(); settle(); commit(); settle();
    click("阅读设置"); commit(); const before = captures;
    click("黑体"); shift += 21; commit();
    let slider = find(tree, node => node?.props?.["aria-label"] === "字号"); slider.props.onChange({ target: { value: "14" } }); shift -= 190; commit();
    slider = find(tree, node => node?.props?.["aria-label"] === "字号"); slider.props.onChange({ target: { value: "30" } }); shift += 420; commit();
    find(tree, node => node?.props?.["aria-label"] === "正文宽度").props.onChange({ target: { value: "520" } }); shift += 210; commit();
    assert.ok(captures <= before + 1, "one text anchor covers the complete typography sequence");
    listeners.get("scroll")?.(); width = 700; shift += 165; resize();
    shift += 43; fontEvents.get("loadingdone")?.(); settle();
    assert.ok(Math.abs(characterTop(64) - rootTop - 11) < .5, "resize and late fonts preserve the same character");
    click("关闭阅读面板"); commit(); settle();
    // A return jump must wait for removal of the inspection banner to commit.
    props.inspectAnchor = anchors.anchorAt(props.document, "b154", 0, 20); commit(); tick(); commit(); settle();
    click("回到阅读位置"); rootTop -= 34; commit(); settle();
    assert.ok(Math.abs(characterTop(64) - rootTop - 11) < .5, "banner removal happens before restoring the permanent text anchor");
    props.inspectAnchor = anchors.anchorAt(props.document, "b154", 12, 28); commit(); tick(); commit(); settle();
    let continued: ReaderPosition | null = null;
    props.onPositionChange = position => { continued = position; }; commit();
    click("从这里继续"); rootTop -= 34; commit(); settle();
    assert.ok(continued); const saved = continued as ReaderPosition;
    assert.ok(Math.abs(characterTop(saved.offset) - rootTop - saved.viewportOffset) < .5, "explicit continuation restores its saved viewport after banner removal");
  } finally { for (const slot of slots) slot?.cleanup?.(); Object.assign(globalThis, previous); }
});
