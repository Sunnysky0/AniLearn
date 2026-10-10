"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Link2, Loader2 } from "lucide-react";
import { extractGoogleDocsUrl, GOOGLE_DOC_EXPORT_MAX_BYTES } from "@/lib/google-docs";
import { MAX_PAPER_PAGES } from "@/lib/types";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const inputClass = "min-w-0 flex-1 border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-700";

interface Props {
  pageCount: number;
  disabled?: boolean;
  onFiles(files: File[]): Promise<void>;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable='true']");
}

function docsLinkFromClipboard(values: string[]): string | null {
  for (const value of values) {
    const link = extractGoogleDocsUrl(value);
    if (link) return link;
  }
  return null;
}

export function MaterialImportTools({ pageCount, disabled = false, onFiles }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const clipboardRef = useRef(false);
  const onFilesRef = useRef(onFiles);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length || disabled || pageCount >= MAX_PAPER_PAGES || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onFilesRef.current(files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加剪贴板内容。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [disabled, pageCount]);

  const importGoogleDoc = useCallback(async (value: string) => {
    const link = extractGoogleDocsUrl(value);
    if (!link) {
      setError("请输入有效的 Google Docs 文档链接。");
      return;
    }
    if (disabled || pageCount >= MAX_PAPER_PAGES || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch("/api/import/google-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Google Docs 导入失败。");
      }
      const blob = await response.blob();
      if (blob.size > GOOGLE_DOC_EXPORT_MAX_BYTES) throw new Error("导出的 PDF 超过 20 MB，请压缩文档后重试。");
      if (blob.type !== "application/pdf" || blob.size < 5) throw new Error("Google Docs 返回的内容不是有效 PDF。");
      const encodedName = response.headers.get("x-file-name");
      let filename = "Google Docs 文档.pdf";
      if (encodedName) {
        try { filename = decodeURIComponent(encodedName); } catch { /* Use the fallback filename. */ }
      }
      await onFilesRef.current([new File([blob], filename, { type: "application/pdf" })]);
      setUrl("");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Google Docs 导入失败。");
    } finally {
      if (request.current === controller) request.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }, [disabled, pageCount]);

  async function readClipboard() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
      setError("浏览器暂不支持读取剪贴板，请使用 Ctrl+V／⌘V 或粘贴 Google Docs 链接。");
      return;
    }
    if (disabled || pageCount >= MAX_PAPER_PAGES || busyRef.current || clipboardRef.current) return;
    clipboardRef.current = true;
    setBusy(true);
    setError("");
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = IMAGE_TYPES.find((candidate) => item.types.includes(candidate));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `剪贴板图片 ${files.length + 1}.${type.split("/")[1]}`, { type }));
      }
      if (files.length) {
        clipboardRef.current = false;
        setBusy(false);
        await addFiles(files);
        return;
      }
      const values: string[] = [];
      for (const item of items) {
        for (const type of ["text/plain", "text/uri-list", "text/html"]) {
          if (!item.types.includes(type)) continue;
          const text = await (await item.getType(type)).text();
          if (type === "text/html") {
            const doc = new DOMParser().parseFromString(text, "text/html");
            values.push(...Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => anchor.href));
          }
          values.push(text);
        }
      }
      const link = docsLinkFromClipboard(values);
      if (link) {
        setUrl(link);
        clipboardRef.current = false;
        setBusy(false);
        await importGoogleDoc(link);
      } else {
        setError("剪贴板中没有图片或 Google Docs 链接。你也可以直接粘贴链接。");
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "NotAllowedError"
        ? "浏览器未授权读取剪贴板，请使用 Ctrl+V／⌘V 或粘贴 Google Docs 链接。"
        : cause instanceof Error ? cause.message : "读取剪贴板失败，请尝试粘贴到上传区域。");
    } finally {
      clipboardRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    function onPaste(event: globalThis.ClipboardEvent) {
      if (isTextEntry(event.target) || disabled || pageCount >= MAX_PAPER_PAGES || busyRef.current || clipboardRef.current) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files).filter((file) => IMAGE_TYPES.includes(file.type));
      if (!files.length) {
        for (const item of Array.from(clipboard.items)) {
          if (item.kind !== "file" || !IMAGE_TYPES.includes(item.type)) continue;
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        void addFiles(files);
        return;
      }
      const values = [clipboard.getData("text/plain"), clipboard.getData("text/uri-list")];
      const html = clipboard.getData("text/html");
      if (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        values.push(...Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => anchor.href));
      }
      const link = docsLinkFromClipboard(values);
      if (!link) return;
      event.preventDefault();
      setUrl(link);
      void importGoogleDoc(link);
    }
    document.addEventListener("paste", onPaste as EventListener, true);
    return () => document.removeEventListener("paste", onPaste as EventListener, true);
  }, [disabled, pageCount, addFiles, importGoogleDoc]);

  return (
    <section aria-label="剪贴板与 Google Docs 导入" className="mt-5 border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-800">剪贴板与 Google Docs</h2>
          <p className="mt-1 text-xs text-neutral-500">可粘贴图片或公开共享的 Google Docs 链接 · 已添加 {pageCount}/{MAX_PAPER_PAGES} 页</p>
        </div>
        <button type="button" onClick={() => void readClipboard()} disabled={disabled || busy || pageCount >= MAX_PAPER_PAGES} className="flex items-center gap-2 border border-neutral-300 px-3 py-2 text-sm hover:border-neutral-800 disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
          {busy ? "正在导入…" : "从剪贴板添加"}
        </button>
      </div>
      <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void importGoogleDoc(url); }}>
        <input aria-label="Google Docs 链接" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴 Google Docs 分享链接" disabled={disabled || busy || pageCount >= MAX_PAPER_PAGES} className={inputClass} />
        <button type="submit" disabled={disabled || busy || pageCount >= MAX_PAPER_PAGES || !url.trim()} className="flex shrink-0 items-center justify-center gap-2 border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}导入链接
        </button>
      </form>
      {busy && <p className="mt-2 text-xs text-neutral-500" role="status">正在读取文档并处理来源页，请稍候…</p>}
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
    </section>
  );
}
