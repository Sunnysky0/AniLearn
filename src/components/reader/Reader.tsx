"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { BookOpen, Search, Settings2, X, ChevronLeft, ChevronRight, MessageSquare, Highlighter, RotateCcw } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { ReaderAnchor, ReaderBlock, ReaderDocument, ReaderNode, ReaderPosition, ReaderProps } from "@/lib/book-types";
import { anchorAt, anchorQuote, blockText, readerText, validateReaderAnchor, validateReaderPosition } from "@/lib/reader/anchors";
import { safeReaderHref } from "@/lib/reader/canonical";
import { currentReaderPosition, readerElement, readerRange, readerSelection } from "@/lib/reader/dom-selection";
import styles from "./reader.module.css";

type Preferences = { size: number; spacing: number; lineHeight: number; width: number; font: "serif" | "sans"; theme: "paper" | "warm" | "night" };
const DEFAULTS: Preferences = { size: 19, spacing: 0, lineHeight: 1.9, width: 760, font: "serif", theme: "paper" };
const BATCH = 100;
type Overlay = { nodes: ReaderNode[]; title: string; unitId?: string; blockId?: string; x: number; y: number };

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem("anilearn:reader-preferences") ?? "null");
    if (!value || typeof value !== "object") return DEFAULTS;
    return { size: Math.max(14, Math.min(30, Number(value.size) || DEFAULTS.size)),
      spacing: Math.max(0, Math.min(0.2, Number(value.spacing) || 0)), lineHeight: Math.max(1.4, Math.min(2.6, Number(value.lineHeight) || DEFAULTS.lineHeight)),
      width: Math.max(520, Math.min(1080, Number(value.width) || DEFAULTS.width)),
      font: value.font === "sans" ? "sans" : "serif",
      theme: ["paper", "warm", "night"].includes(value.theme) ? value.theme : "paper" };
  } catch { return DEFAULTS; }
}

export default function Reader(props: ReaderProps) {
  const { document: source } = props;
  const root = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  useLayoutEffect(() => { callbacks.current = props; }, [props]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULTS);
  const [panel, setPanel] = useState<"search" | "settings" | "contents" | null>(null);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(BATCH);
  const [selection, setSelection] = useState<{ anchor: ReaderAnchor; x: number; y: number } | null>(null);
  const [annotation, setAnnotation] = useState<ReaderAnchor | null>(null);
  const [annotationContent, setAnnotationContent] = useState("");
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [error, setError] = useState("");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [inspection, setInspection] = useState<ReaderAnchor | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const inspectingRef = useRef(false);
  const inspectionOrigin = useRef<ReaderPosition | null>(null);
  const pendingTarget = useRef<{ unitId: string; blockId: string } | null>(null);
  const bookmark = useRef<ReaderPosition | null>(null);
  const visualPosition = useRef<ReaderPosition | null>(null);
  const restore = useRef<ReaderPosition | null>(null);
  const layoutAnchor = useRef<ReaderPosition | null>(null);
  const formattingAnchor = useRef<ReaderPosition | null>(null);
  const layoutFrame = useRef(0);
  const layoutEpoch = useRef(0);
  const suppressUntil = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceIdentity = `${source.key}\n${source.unitId}`;
  const identityRef = useRef("");

  const applyPosition = useCallback((position: ReaderPosition) => {
    const scroll = root.current;
    if (!scroll || position.documentKey !== callbacks.current.document.key || position.unitId !== callbacks.current.document.unitId) return null;
    const block = readerElement(scroll, position.blockId);
    if (!block) return null;
    suppressUntil.current = performance.now() + 400;
    const range = readerRange(scroll, position.blockId, position.offset);
    const rect = range?.getBoundingClientRect();
    const top = rect?.height ? rect.top : block.getBoundingClientRect().top;
    const delta = top - scroll.getBoundingClientRect().top - position.viewportOffset;
    scroll.scrollTop += delta;
    visualPosition.current = position;
    return delta;
  }, []);

  const stabilizePosition = useCallback((position: ReaderPosition) => {
    cancelAnimationFrame(layoutFrame.current);
    const epoch = ++layoutEpoch.current;
    layoutAnchor.current = position;
    let frames = 0; let stable = 0; let previousHeight = -1;
    const correct = () => {
      if (epoch !== layoutEpoch.current) return;
      const scroll = root.current;
      if (!scroll || position.documentKey !== callbacks.current.document.key || position.unitId !== callbacks.current.document.unitId) { layoutAnchor.current = null; return; }
      const delta = applyPosition(position);
      // A lazy chunk or font can change geometry after the first layout. Keep
      // the original character fixed until several consecutive frames agree.
      const height = scroll.scrollHeight;
      stable = delta !== null && Math.abs(delta) < .5 && Math.abs(height - previousHeight) < .5 ? stable + 1 : 0;
      previousHeight = height;
      if (++frames < 12 && stable < 3) layoutFrame.current = requestAnimationFrame(correct);
      else { layoutAnchor.current = null; visualPosition.current = position; }
    };
    correct();
  }, [applyPosition]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPreferences(readPreferences()));
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    if (identityRef.current === sourceIdentity) return;
    identityRef.current = sourceIdentity;
    setSelection(null); setOverlay(null); setPanel(null); setQuery("");
    const position = validateReaderPosition(source, callbacks.current.initialPosition);
    cancelAnimationFrame(layoutFrame.current); layoutEpoch.current++;
    layoutAnchor.current = null; formattingAnchor.current = null;
    bookmark.current = position;
    restore.current = position;
    const target = pendingTarget.current;
    if (target?.unitId === source.unitId) {
      const block = source.blocks.find((block) => block.id === target.blockId || block.source?.fragment === target.blockId || block.source?.fragments?.includes(target.blockId));
      if (block) {
        restore.current = { documentKey: source.key, unitId: source.unitId, blockId: block.id, offset: 0, viewportOffset: 100 };
        setInspection(anchorAt(source, block.id, 0, Math.min(160, blockText(block).length)));
      }
      pendingTarget.current = null;
    }
    const idx = source.blocks.findIndex((block) => block.id === restore.current?.blockId);
    setLoaded(Math.min(source.blocks.length, Math.max(BATCH, idx + BATCH)));
    if (!position && root.current) root.current.scrollTop = 0;
  }, [source, sourceIdentity]);

  useLayoutEffect(() => {
    const target = restore.current ?? layoutAnchor.current;
    if (target) { restore.current = null; stabilizePosition(target); }
  }, [loaded, sourceIdentity, preferences, inspecting, stabilizePosition]);
  useEffect(() => () => { cancelAnimationFrame(layoutFrame.current); layoutEpoch.current++; }, []);

  const beginInspection = useCallback(() => {
    if (!inspectingRef.current) {
      if (root.current) bookmark.current = layoutAnchor.current ?? currentReaderPosition(root.current, callbacks.current.document) ?? bookmark.current;
      inspectionOrigin.current = bookmark.current;
    }
    inspectingRef.current = true; setInspecting(true); callbacks.current.onInspectionChange?.(true);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
  }, []);

  const inspect = useCallback((anchor: ReaderAnchor) => {
    const valid = validateReaderAnchor(callbacks.current.document, anchor);
    if (!valid) return;
    beginInspection(); setInspection(valid); setSelection(null);
    const current = callbacks.current.document;
    const segment = valid.segments[0];
    const idx = current.blocks.findIndex((block) => block.id === segment.blockId);
    restore.current = { documentKey: current.key, unitId: current.unitId, blockId: segment.blockId, offset: segment.start, viewportOffset: 100 };
    setLoaded((value) => Math.min(current.blocks.length, Math.max(value, idx + BATCH)));
    requestAnimationFrame(() => { if (restore.current) { const target = restore.current; restore.current = null; stabilizePosition(target); } });
  }, [stabilizePosition, beginInspection]);

  useEffect(() => {
    const anchor = props.inspectAnchor;
    if (!anchor || anchor.documentKey !== source.key) return;
    const frame = requestAnimationFrame(() => {
      if (anchor.unitId !== source.unitId) {
        beginInspection(); pendingTarget.current = { unitId: anchor.unitId, blockId: anchor.segments[0]?.blockId ?? "" };
        callbacks.current.onUnitChange?.(anchor.unitId, true);
      } else inspect(anchor);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.inspectAnchor, inspect, sourceIdentity, source.key, source.unitId, beginInspection]);

  useEffect(() => {
    const scroll = root.current; const bottom = sentinel.current;
    if (!scroll || !bottom || loaded >= source.blocks.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLoaded((value) => Math.min(source.blocks.length, value + BATCH));
    }, { root: scroll, rootMargin: "1600px" });
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [loaded, source.blocks.length]);

  useEffect(() => {
    const scroll = root.current;
    if (!scroll) return;
    const onScroll = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      if (!layoutAnchor.current && performance.now() >= suppressUntil.current) visualPosition.current = currentReaderPosition(scroll, callbacks.current.document);
      scrollTimer.current = setTimeout(() => {
        if (layoutAnchor.current || performance.now() < suppressUntil.current) return;
        const position = currentReaderPosition(scroll, callbacks.current.document);
        visualPosition.current = position;
        if (inspectingRef.current) return;
        if (position) { bookmark.current = position; callbacks.current.onPositionChange?.(position); }
      }, 220);
    };
    const manualScroll = () => {
      cancelAnimationFrame(layoutFrame.current); layoutEpoch.current++;
      layoutAnchor.current = null; formattingAnchor.current = null; suppressUntil.current = 0;
    };
    const scrollKey = (event: KeyboardEvent) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScroll(); };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scroll.addEventListener("wheel", manualScroll, { passive: true }); scroll.addEventListener("touchstart", manualScroll, { passive: true }); scroll.addEventListener("keydown", scrollKey);
    return () => { scroll.removeEventListener("scroll", onScroll); scroll.removeEventListener("wheel", manualScroll); scroll.removeEventListener("touchstart", manualScroll); scroll.removeEventListener("keydown", scrollKey); if (scrollTimer.current) clearTimeout(scrollTimer.current); };
  }, []);

  useEffect(() => {
    const scroll = root.current;
    if (!scroll) return;
    let width = scroll.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = scroll.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) < 1) return;
      width = nextWidth;
      const position = layoutAnchor.current ?? formattingAnchor.current ?? visualPosition.current ?? bookmark.current;
      if (!position || position.unitId !== callbacks.current.document.unitId) return;
      stabilizePosition(position);
    });
    observer.observe(scroll);
    const fontsReady = () => { const position = layoutAnchor.current ?? formattingAnchor.current ?? visualPosition.current; if (position) stabilizePosition(position); };
    window.document.fonts?.addEventListener("loadingdone", fontsReady);
    return () => { observer.disconnect(); window.document.fonts?.removeEventListener("loadingdone", fontsReady); };
  }, [stabilizePosition]);

  useEffect(() => { if (panel !== "settings") formattingAnchor.current = null; }, [panel]);

  function updatePreferences(patch: Partial<Preferences>) {
    if (root.current) {
      formattingAnchor.current ??= layoutAnchor.current ?? (performance.now() < suppressUntil.current ? visualPosition.current : currentReaderPosition(root.current, source));
      restore.current = formattingAnchor.current;
    }
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      try { localStorage.setItem("anilearn:reader-preferences", JSON.stringify(next)); } catch { /* Preferences still apply in memory. */ }
      return next;
    });
  }

  function returnToReading() {
    setInspection(null); setOverlay(null); setSelection(null);
    const position = inspectionOrigin.current ?? bookmark.current;
    if (position?.unitId !== source.unitId) {
      if (position) callbacks.current.onUnitChange?.(position.unitId, false);
    } else if (position) restore.current = position;
    inspectingRef.current = false; setInspecting(false); callbacks.current.onInspectionChange?.(false);
    inspectionOrigin.current = null;
  }

  function continueHere() {
    const position = layoutAnchor.current ?? (root.current && currentReaderPosition(root.current, source));
    inspectingRef.current = false; setInspecting(false); setInspection(null); callbacks.current.onInspectionChange?.(false);
    inspectionOrigin.current = null;
    if (position) { restore.current = position; bookmark.current = position; callbacks.current.onPositionChange?.(position); }
  }

  function captureSelection() {
    if (!article.current) return;
    const anchor = readerSelection(article.current, source);
    if (!anchor) return;
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    setSelection({ anchor, x: Math.max(8, Math.min(window.innerWidth - 340, rect?.left ?? 8)),
      y: Math.max(8, Math.min(window.innerHeight - 100, (rect?.top ?? 90) - 70)) });
    setOverlay(null); setError("");
  }

  function closeSelection() { setSelection(null); window.getSelection()?.removeAllRanges(); }

  const searchResults = useMemo(() => {
    const word = query.trim();
    if (!word) return [];
    const expression = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const results: { anchor?: ReaderAnchor; noteId?: string; excerpt: string; number: number }[] = [];
    for (const [index, block] of source.blocks.entries()) {
      const text = blockText(block);
      for (const match of text.matchAll(expression)) {
        const anchor = anchorAt(source, block.id, match.index, match.index + match[0].length);
        if (anchor) results.push({ anchor, excerpt: text.slice(Math.max(0, match.index - 36), match.index + match[0].length + 64), number: index + 1 });
        if (results.length >= 200) return results;
      }
    }
    const referenced = new Set<string>();
    const collect = (nodes: ReaderNode[]) => {
      for (const node of nodes) {
        if (node.type === "footnote") referenced.add((node.target ?? node.href ?? "").replace(/^#/, ""));
        if (node.children) collect(node.children);
      }
    };
    for (const block of source.blocks) {
      collect(block.nodes); block.items?.forEach(collect); block.rows?.forEach(row => row.forEach(collect));
    }
    for (const noteId of referenced) {
      const note = source.footnotes?.[noteId]; if (!note) continue;
      const text = readerText(note.nodes);
      for (const match of text.matchAll(expression)) {
        results.push({ noteId, excerpt: text.slice(Math.max(0, match.index - 36), match.index + match[0].length + 64), number: 0 });
        if (results.length >= 200) return results;
      }
    }
    return results;
  }, [query, source]);

  function footnote(node: ReaderNode, event: MouseEvent<HTMLElement>) {
    const target = (node.target ?? node.href ?? "").replace(/^#/, "");
    const note = source.footnotes?.[target];
    if (note) {
      const rect = event.currentTarget.getBoundingClientRect();
      setOverlay({ title: "注释", nodes: note.nodes, unitId: note.unitId, blockId: note.blockId,
        x: Math.max(8, Math.min(window.innerWidth - 360, rect.left)), y: Math.min(window.innerHeight - 280, rect.bottom + 8) });
      setSelection(null); return;
    }
    const separator = target.indexOf("#");
    const targetUnit = separator >= 0 ? target.slice(0, separator) : "";
    const targetBlock = separator >= 0 ? target.slice(separator + 1) : target;
    if (targetUnit && targetUnit !== source.unitId && source.units.some((unit) => unit.id === targetUnit)) {
      beginInspection(); pendingTarget.current = { unitId: targetUnit, blockId: targetBlock };
      props.onUnitChange?.(targetUnit, true); return;
    }
    const block = source.blocks.find((block) => block.id === targetBlock || block.source?.fragment === targetBlock || block.source?.fragments?.includes(targetBlock));
    if (block) { const anchor = anchorAt(source, block.id, 0, Math.min(160, blockText(block).length)); if (anchor) inspect(anchor); }
    else if (node.target && source.units.some((unit) => unit.id === node.target)) { beginInspection(); props.onUnitChange?.(node.target, true); }
  }

  function renderNodes(nodes: ReaderNode[], offset: { value: number }, key: string, mapped = true): ReactNode {
    return nodes.map((node, index) => {
      const id = `${key}-${index}`;
      const content = node.children?.length ? renderNodes(node.children, offset, id, mapped) : (() => {
        const text = node.type === "break" ? "\n" : node.text ?? "";
        const start = offset.value; offset.value += text.length;
        if (node.type === "math") return <span key={id} data-reader-start={mapped ? start : undefined} data-reader-end={mapped ? offset.value : undefined} data-reader-atomic={mapped ? "" : undefined} className={styles.math}><Markdown content={`${node.display ? "$$" : "$"}${text}${node.display ? "$$" : "$"}`} /></span>;
        return <span key={id} data-reader-start={mapped ? start : undefined} data-reader-end={mapped ? offset.value : undefined} className={node.type === "break" ? styles.lineBreak : undefined}>{text}</span>;
      })();
      if (node.type === "strong") return <strong key={id}>{content}</strong>;
      if (node.type === "emphasis") return <em key={id}>{content}</em>;
      if (node.type === "code") return <code key={id}>{content}</code>;
      if (node.type === "ruby") return <ruby key={id}>{content}<rt data-reader-ignore="">{node.annotation}</rt></ruby>;
      if (node.type === "footnote") return <button key={id} className={styles.footnoteReference} aria-label={`查看注释 ${node.text ?? ""}`} onClick={(event) => footnote(node, event)}>{content}</button>;
      if (node.type === "link") {
        const href = safeReaderHref(node.href);
        return href?.startsWith("#") || node.target ? <a key={id} href={href ?? "#"} onClick={(event) => { event.preventDefault(); footnote(node, event); }}>{content}</a>
          : href ? <a key={id} href={href} target="_blank" rel="noopener noreferrer">{content}</a> : <Fragment key={id}>{content}</Fragment>;
      }
      return <Fragment key={id}>{content}</Fragment>;
    });
  }

  function renderBlock(block: ReaderBlock, index: number) {
    const offset = { value: 0 };
    const relevant = (props.annotations ?? []).filter((annotation) => annotation.anchor.documentKey === source.key && annotation.anchor.unitId === source.unitId && annotation.anchor.segments.some((segment) => segment.blockId === block.id));
    const highlighted = inspection?.segments.some((segment) => segment.blockId === block.id);
    const content = block.kind === "list" || block.kind === "table" ? null : renderNodes(block.nodes, offset, block.id);
    let semantic: ReactNode;
    if (block.kind === "heading") {
      const level = Math.max(1, Math.min(6, block.level ?? 2));
      semantic = level === 1 ? <h1>{content}</h1> : level === 2 ? <h2>{content}</h2> : level === 3 ? <h3>{content}</h3> : level === 4 ? <h4>{content}</h4> : level === 5 ? <h5>{content}</h5> : <h6>{content}</h6>;
    } else if (block.kind === "quote") semantic = <blockquote>{content}</blockquote>;
    else if (block.kind === "pre") semantic = <pre>{content}</pre>;
    else if (block.kind === "rule") semantic = <hr />;
    else if (block.kind === "list" && block.items) {
      const items = block.items.map((nodes, item) => <li key={item}>{item > 0 && <span className={styles.separator} data-reader-start={offset.value} data-reader-end={++offset.value}>{"\n"}</span>}{renderNodes(nodes, offset, `${block.id}-item-${item}`)}</li>);
      semantic = block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    } else if (block.kind === "table" && block.rows) semantic = <div className={styles.tableScroll}><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{(rowIndex > 0 && cellIndex === 0 || cellIndex > 0) && <span className={styles.separator} data-reader-start={offset.value} data-reader-end={++offset.value}>{cellIndex ? "\t" : "\n"}</span>}{renderNodes(cell, offset, `${block.id}-cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>;
    else if (block.kind === "image") {
      const resource = source.resources?.find((item) => item.id === block.assetId);
      const allowed = resource?.url.startsWith("/api/books/") || resource?.url.startsWith("/api/book-sessions/");
      // Imported images are always same-origin asset endpoints; remote source URLs are never fetched.
      semantic = <figure>{resource && allowed ? (
        // Intrinsic EPUB dimensions may be absent; a native image preserves its actual aspect ratio.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={resource.url} alt={block.alt ?? "书中插图"} width={block.width ?? resource.width} height={block.height ?? resource.height} loading="lazy" onLoad={() => { const position = visualPosition.current; if (position && performance.now() < suppressUntil.current + 1000) requestAnimationFrame(() => applyPosition(position)); }} />
      ) : <p>{block.alt || "插图暂不可用"}</p>}{content && <figcaption>{content}</figcaption>}</figure>;
    } else semantic = <p>{content}</p>;
    return <div key={block.id} data-reader-block={block.id} data-reading-paragraph={index} id={`reader-block-${index}`} className={`${styles.block} ${highlighted ? styles.inspectedBlock : ""} ${relevant.length ? styles.annotatedBlock : ""}`}>
      <div data-reading-paragraph-text data-paragraph-id={block.id}>{semantic}</div>
      {!!relevant.length && <div data-reader-ignore="" className={styles.inlineNotes}>{relevant.map((note) => <details key={note.id}><summary><Highlighter size={13} />原文批注</summary><blockquote>{anchorQuote(note.anchor)}</blockquote><Markdown content={note.content} className="md" /></details>)}</div>}
    </div>;
  }

  async function saveAnnotation() {
    if (!annotation || !annotationContent.trim() || !props.onAnnotation || annotationSaving) return;
    setAnnotationSaving(true); setError("");
    try { await props.onAnnotation(annotation, annotationContent); setAnnotation(null); setAnnotationContent(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "批注保存失败，请重试。"); }
    finally { setAnnotationSaving(false); }
  }

  const css = { "--reader-size": `${preferences.size}px`, "--reader-spacing": `${preferences.spacing}em`,
    "--reader-line-height": preferences.lineHeight, "--reader-width": `${preferences.width}px`,
    "--reader-font": preferences.font === "sans" ? '"Noto Sans SC Variable",Arial,sans-serif' : '"Noto Serif SC Variable",Georgia,"Times New Roman",serif' } as CSSProperties;
  const unitIndex = source.units.findIndex((unit) => unit.id === source.unitId);

  return <div className={`${styles.reader} ${styles[preferences.theme]}`} style={css} data-reader-document={source.key}>
    <div className={styles.toolbar}>
      <button aria-label="章节目录" aria-expanded={panel === "contents"} onClick={() => setPanel(panel === "contents" ? null : "contents")}><BookOpen size={17} /><span className={styles.unitTitle}>{source.units[unitIndex]?.title ?? source.title}</span></button>
      <div className={styles.toolbarTools}><button aria-label="搜索本章全文" aria-expanded={panel === "search"} onClick={() => setPanel(panel === "search" ? null : "search")}><Search size={17} /><span>搜索</span></button><button aria-label="阅读设置" aria-expanded={panel === "settings"} onClick={() => setPanel(panel === "settings" ? null : "settings")}><Settings2 size={17} /><span>排版</span></button></div>
    </div>
    {panel && <section className={styles.panel} aria-label={panel === "settings" ? "阅读设置" : panel === "search" ? "本章全文搜索" : "章节目录"}>
      <button className={styles.panelClose} aria-label="关闭阅读面板" onClick={() => setPanel(null)}><X size={17} /></button>
      {panel === "settings" && <div className={styles.settings}>
        <fieldset><legend>正文字体</legend><button aria-pressed={preferences.font === "serif"} onClick={() => updatePreferences({ font: "serif" })}>宋体</button><button aria-pressed={preferences.font === "sans"} onClick={() => updatePreferences({ font: "sans" })}>黑体</button></fieldset>
        <label>字号 <output>{preferences.size}px</output><input aria-label="字号" type="range" min={14} max={30} step={1} value={preferences.size} onChange={(event) => updatePreferences({ size: Number(event.target.value) })} /></label>
        <label>字距 <output>{preferences.spacing.toFixed(2)}em</output><input aria-label="字距" type="range" min={0} max={0.2} step={0.01} value={preferences.spacing} onChange={(event) => updatePreferences({ spacing: Number(event.target.value) })} /></label>
        <label>行距 <output>{preferences.lineHeight.toFixed(1)}</output><input aria-label="行距" type="range" min={1.4} max={2.6} step={0.1} value={preferences.lineHeight} onChange={(event) => updatePreferences({ lineHeight: Number(event.target.value) })} /></label>
        <label>正文宽度 <output>{preferences.width}px</output><input aria-label="正文宽度" type="range" min={520} max={1080} step={40} value={preferences.width} onChange={(event) => updatePreferences({ width: Number(event.target.value) })} /></label>
        <fieldset><legend>阅读主题</legend>{([{ id: "paper", label: "纸白" }, { id: "warm", label: "暖纸" }, { id: "night", label: "夜间" }] as const).map((theme) => <button key={theme.id} aria-pressed={preferences.theme === theme.id} onClick={() => updatePreferences({ theme: theme.id })}>{theme.label}</button>)}</fieldset>
      </div>}
      {panel === "contents" && <nav className={styles.contents}>{source.units.map((unit) => <button key={unit.id} aria-current={unit.id === source.unitId ? "location" : undefined} className={unit.parentId ? styles.nestedUnit : undefined} onClick={() => { if (unit.id !== source.unitId) { inspectingRef.current = false; setInspecting(false); props.onInspectionChange?.(false); props.onUnitChange?.(unit.id, false); } setPanel(null); }}>{unit.title}<small>{unit.role === "front" ? "卷前" : unit.role === "back" ? "卷后" : "正文"}</small></button>)}</nav>}
      {panel === "search" && <><label className={styles.searchBox}><Search size={17} /><input aria-label="搜索本章" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找这一章的词句" /></label><p className={styles.searchCount}>{query.trim() ? `${searchResults.length >= 200 ? "至少 " : ""}${searchResults.length} 处结果 · 搜索完整章节及其脚注` : "输入词句，搜索完整章节及其脚注"}</p><div className={styles.searchResults}>{searchResults.map((result, index) => <button key={index} onClick={() => { if (result.noteId) { const note = source.footnotes?.[result.noteId]; if (note) setOverlay({ title: "注释", nodes: note.nodes, unitId: note.unitId, blockId: note.blockId, x: Math.max(8, Math.min(window.innerWidth - 360, root.current?.getBoundingClientRect().left ?? 8)), y: 100 }); } else if (result.anchor) inspect(result.anchor); setPanel(null); }}><small>{result.noteId ? "本章脚注" : `第 ${result.number} 段`}</small><span>{result.excerpt}</span></button>)}</div></>}
    </section>}
    {inspecting && <div className={styles.inspectionBanner} role="status"><span>临时查看 · 阅读书签保留</span><button onClick={returnToReading}><RotateCcw size={14} />回到阅读位置</button><button onClick={continueHere}>从这里继续</button></div>}
    <div ref={root} className={styles.scroll} tabIndex={0} aria-label="阅读正文" onKeyDown={(event) => { if (event.key === "Escape") { closeSelection(); setOverlay(null); setPanel(null); } }}>
      <article ref={article} data-reading-article lang={source.language} className={styles.article} onMouseUp={captureSelection} onKeyUp={captureSelection} onTouchEnd={() => requestAnimationFrame(captureSelection)}>
        {/* Append in bounded batches. Loaded text keeps real layout geometry so
            selection, bookmarks and restored character ranges remain exact. */}
        {Array.from({ length: Math.ceil(Math.min(loaded, source.blocks.length) / 50) }, (_, group) => <section key={group} data-reader-chunk={group}>{source.blocks.slice(group * 50, Math.min(loaded, group * 50 + 50)).map((block, index) => renderBlock(block, group * 50 + index))}</section>)}
        {source.blocks.length === 0 && <p className={styles.empty}>这一章没有可阅读的正文。</p>}
        <div ref={sentinel} aria-hidden="true" className={styles.loadBoundary}>{loaded < source.blocks.length ? "正在续接正文…" : ""}</div>
        {loaded >= source.blocks.length && <footer className={styles.chapterEnd}><span>本章结束</span>{props.onUnitChange && <div><button disabled={unitIndex <= 0} onClick={() => props.onUnitChange?.(source.units[unitIndex - 1].id, false)}><ChevronLeft size={15} />上一章</button><button disabled={unitIndex < 0 || unitIndex >= source.units.length - 1} onClick={() => props.onUnitChange?.(source.units[unitIndex + 1].id, false)}>下一章<ChevronRight size={15} /></button></div>}</footer>}
      </article>
    </div>
    {selection && <div className={styles.selectionBar} role="toolbar" aria-label="原文选区操作" style={{ left: selection.x, top: selection.y }} onMouseDown={(event) => event.preventDefault()}>
      {props.onSelectionTask && ([{ task: "vocabulary", label: "解释词语" }, { task: "grammar", label: "分析语法" }, { task: "meaning", label: "说明句意" }] as const).map((item) => <button key={item.task} onClick={() => { props.onSelectionTask?.(item.task, selection.anchor); closeSelection(); }}>{item.label}</button>)}
      {props.onQuestion && <button onClick={() => { props.onQuestion?.(selection.anchor); closeSelection(); }}><MessageSquare size={14} />自由提问</button>}
      {props.onAnnotation && <button onClick={() => { setAnnotation(selection.anchor); setAnnotationContent(""); closeSelection(); }}><Highlighter size={14} />添加批注</button>}
      <button aria-label="关闭选区工具栏" onClick={closeSelection}><X size={15} /></button>
    </div>}
    {overlay && <aside className={styles.footnoteOverlay} role="dialog" aria-label="脚注" style={{ left: overlay.x, top: Math.max(8, overlay.y) }}><div><strong>{overlay.title}</strong><button aria-label="关闭脚注" onClick={() => setOverlay(null)}><X size={16} /></button></div><div className={styles.footnoteBody}>{renderNodes(overlay.nodes, { value: 0 }, "footnote", false)}</div>{overlay.blockId && <button onClick={() => { if (overlay.unitId && overlay.unitId !== source.unitId) { beginInspection(); pendingTarget.current = { unitId: overlay.unitId, blockId: overlay.blockId! }; props.onUnitChange?.(overlay.unitId, true); } else { const block = source.blocks.find((item) => item.id === overlay.blockId); if (block) { const anchor = anchorAt(source, block.id, 0, Math.min(160, blockText(block).length)); if (anchor) inspect(anchor); } } setOverlay(null); }}>查看注释原处</button>}</aside>}
    {annotation && <div className={styles.modalBackdrop}><section role="dialog" aria-modal="true" aria-label="添加原文批注" className={styles.annotationDialog}><div><h2>添加原文批注</h2><button aria-label="关闭批注" disabled={annotationSaving} onClick={() => setAnnotation(null)}><X size={18} /></button></div><blockquote>{anchorQuote(annotation)}</blockquote><textarea aria-label="批注内容" autoFocus value={annotationContent} onChange={(event) => setAnnotationContent(event.target.value)} placeholder="写下对这段原文的想法…" />{error && <p role="alert">{error}</p>}<footer><button disabled={annotationSaving} onClick={() => setAnnotation(null)}>取消</button><button disabled={annotationSaving || !annotationContent.trim()} onClick={() => void saveAnnotation()}>{annotationSaving ? "保存中…" : "保存批注"}</button></footer></section></div>}
  </div>;
}
