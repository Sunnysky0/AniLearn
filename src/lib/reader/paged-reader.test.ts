import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ReaderPosition, ReaderProps } from "@/lib/book-types";
import * as anchors from "./anchors";
import * as pagination from "./pagination";

// Exercise the actual component's effects and controls with deterministic layout
// measurements. CSS fragmentation and physical selection remain manual acceptance.
function reader() {
  const slots: any[] = []; let cursor = 0; const effects: (() => void)[] = []; const layouts: (() => void)[] = [];
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
    useEffect(callback: () => void, dependencies: any[]) { effect(callback, dependencies, effects); }, useLayoutEffect(callback: () => void, dependencies: any[]) { effect(callback, dependencies, layouts); },
  };
  const previous = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, localStorage: globalThis.localStorage };
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const fontEvents = new Map<string, () => void>(); let resized = () => undefined as void;
  let capacity = 400; let width = 700; let height = 450; let rendered = 100; let tree: any;
  const saved: ReaderPosition = { documentKey: "reading:1:3", unitId: "article", blockId: "b510", offset: 44, viewportOffset: 11 };
  const positions: ReaderPosition[] = []; const bookmarks: ReaderPosition[] = [];
  const props: ReaderProps = { document: { key: saved.documentKey, title: "Long article", unitId: "article", language: "ja", units: [], blocks: Array.from({ length: 1003 }, (_, index) => ({ id: `b${index}`, kind: "paragraph", nodes: [{ type: "text", text: "a".repeat(100) }], anchorText: "a".repeat(100) })) },
    layout: "paged", initialPosition: saved, entryPosition: saved, onPositionChange: value => positions.push(value), onBookmarkCreate: async value => { bookmarks.push(value); } };
  globalThis.requestAnimationFrame = callback => { const id = ++next; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  globalThis.ResizeObserver = class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.window = { getSelection: () => ({ toString: () => "", removeAllRanges() {} }), document: { fonts: { addEventListener: (name: string, callback: () => void) => fontEvents.set(name, callback), removeEventListener: (name: string) => fontEvents.delete(name) } } } as unknown as Window & typeof globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
  const viewport = { scrollHeight: 450, getBoundingClientRect: () => ({ width, height }), addEventListener() {}, removeEventListener() {} };
  const body = { style: { transform: "", columnWidth: "", setProperty() {} }, get scrollWidth() { return Math.ceil(rendered * 100 / capacity) * (width + 48) - 48; }, addEventListener() {}, removeEventListener() {} };
  const geometry = { ...pagination,
    positionPage(_body: unknown, position: ReaderPosition) { const index = Number(position.blockId.slice(1)); return index < rendered ? Math.floor((index * 100 + position.offset) / capacity) : null; },
    pagePosition(_body: unknown, _document: unknown, page: number) { const global = page * capacity; return { ...saved, blockId: `b${Math.floor(global / 100)}`, offset: global % 100, viewportOffset: 0 }; } };
  const compiled = ts.transpileModule(readFileSync("src/components/reader/Reader.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "lucide-react": new Proxy({}, { get: (_target, key) => String(key) }), "@/components/Markdown": { Markdown: "Markdown" }, "@/lib/reader/anchors": anchors,
    "@/lib/reader/canonical": { safeReaderHref: () => undefined }, "@/lib/reader/pagination": geometry, "@/lib/reader/dom-selection": {},
    "./reader.module.css": { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) } };
  const loaded = { exports: {} as { default: (props: ReaderProps) => any } };
  new Function("require", "module", "exports", compiled)((name: string) => dependencies[name], loaded, loaded.exports);
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (predicate(node)) return node;
    for (const child of Array.isArray(node) ? node : node?.props?.children ? [node.props.children] : []) { const found = find(child, predicate); if (found) return found; }
    return null;
  };
  const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node?.props?.children ? text(node.props.children) : "";
  const commit = () => {
    cursor = 0; tree = loaded.exports.default(props);
    find(tree, node => node?.props?.["aria-label"] === "阅读正文").props.ref.current = viewport;
    find(tree, node => node?.props?.className === "pageWindow").props.ref.current = viewport;
    const article = find(tree, node => node?.type === "article"); article.props.ref.current = body;
    const groups = article.props.children[0]; rendered = groups.reduce((sum: number, group: any) => sum + group.props.children.length, 0);
    for (const callback of layouts.splice(0)) callback(); for (const callback of effects.splice(0)) callback();
  };
  const settle = () => { for (let index = 0; index < 20; index++) { commit(); const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(0); } commit(); };
  const control = (label: string) => { const value = find(tree, node => node?.type === "button" && (node.props["aria-label"] === label || text(node) === label)); assert.ok(value, label); return value; };
  const click = (label: string) => { const value = control(label); assert.ok(!value.props.disabled, `${label} enabled`); value.props.onClick(); settle(); };
  settle();
  return { props, positions, bookmarks, click, control, body, settle,
    footer: () => text(find(tree, node => node?.props?.["aria-label"] === "翻页导航")),
    reflow(value: number) { capacity = value; width -= 10; height -= 10; resized(); fontEvents.get("loadingdone")?.(); settle(); },
    key(key: string, editing = false) { let prevented = false; tree.props.onKeyDown({ key, target: { closest: () => editing ? {} : null }, preventDefault() { prevented = true; } }); settle(); return prevented; },
    jump(value: number) { const input = find(tree, node => node?.props?.["aria-label"] === "跳转页码"); input.props.onChange({ target: { value: String(value) } }); commit(); find(tree, node => node?.type === "form" && !!find(node.props.children, child => child?.props?.["aria-label"] === "跳转页码")).props.onSubmit({ preventDefault() {} }); settle(); },
    close() { for (const slot of slots) slot?.cleanup?.(); Object.assign(globalThis, previous); } };
}

test("paged reader restores a distant character, completes long-document layout and never saves reflow", () => {
  const env = reader();
  try {
    assert.ok(env.footer().includes("/ 251")); assert.ok(env.body.style.transform.includes(String(-127 * 748)));
    assert.equal(env.positions.length, 0);
    env.reflow(200); assert.ok(env.footer().includes("/ 502")); assert.equal(env.positions.length, 0);
    env.click("下一页"); assert.equal(env.positions.at(-1)?.blockId, "b512"); assert.equal(env.positions.at(-1)?.offset, 0);
    assert.equal(env.key("ArrowRight", true), false); assert.equal(env.positions.length, 1);
    assert.equal(env.key("PageDown"), true); assert.equal(env.positions.at(-1)?.blockId, "b514");
  } finally { env.close(); }
});

test("temporary inspection preserves the bookmark until explicit continuation", () => {
  const env = reader();
  try {
    env.props.inspectAnchor = anchors.anchorAt(env.props.document, "b900", 12, 20); env.settle(); assert.equal(env.positions.length, 0);
    env.click("下一页"); assert.equal(env.positions.length, 0);
    env.click("回到阅读位置"); assert.equal(env.positions.length, 0);
    env.click("下一页"); assert.equal(env.positions.length, 1);
    env.props.inspectAnchor = anchors.anchorAt(env.props.document, "b900", 22, 30); env.settle();
    env.click("从这里继续"); assert.equal(env.positions.length, 2); assert.equal(env.positions.at(-1)?.blockId, "b900"); assert.equal(env.positions.at(-1)?.offset, 22);
  } finally { env.close(); }
});

test("head, entry-position, page-jump and final-page controls preserve learning independence", () => {
  const env = reader();
  try {
    env.click("从头阅读"); assert.equal(env.positions.at(-1)?.blockId, "b0"); assert.ok(env.control("上一页").props.disabled);
    env.click("回到上次位置"); assert.equal(env.positions.at(-1)?.blockId, "b510"); assert.equal(env.positions.at(-1)?.offset, 44);
    env.jump(251); assert.ok(env.footer().includes("全文结束")); assert.ok(env.control("下一页").props.disabled);
    const count = env.positions.length; env.reflow(600); assert.equal(env.positions.length, count);
    assert.equal(env.props.onUnitChange, undefined); assert.equal(env.props.onQuestion, undefined);
  } finally { env.close(); }
});
