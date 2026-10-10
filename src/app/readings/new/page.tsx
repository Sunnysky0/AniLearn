"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Trash2, Upload } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { MaterialImportTools } from "@/components/MaterialImportTools";
import { fileToJpegBlob, pdfToImageBlobs } from "@/lib/client/media";
import { decodePaperText } from "@/lib/paper-source";
import { MAX_PAPER_TEXT_BYTES, type ReadingLanguage } from "@/lib/types";

interface ReadingSourceDraft { name: string; blob: Blob; previewUrl: string | null }
const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";
const PREVIEW_PAGE_SIZE = 12;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("来源页读取失败。"));
    reader.readAsDataURL(blob);
  });
}

export default function NewReadingPage() {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const objectUrls = useRef(new Set<string>());
  const importRequest = useRef<AbortController | null>(null);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<ReadingLanguage>("en");
  const [text, setText] = useState("");
  const [sources, setSources] = useState<ReadingSourceDraft[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [readingId, setReadingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState("");
  const [error, setError] = useState("");

  useEffect(() => () => {
    importRequest.current?.abort();
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, []);

  function preview(blob: Blob) {
    if (!blob.type.startsWith("image/")) return null;
    const url = URL.createObjectURL(blob);
    objectUrls.current.add(url);
    return url;
  }

  async function importFiles(list: FileList | File[]) {
    if (busy || adding.current || readingId) return;
    adding.current = true;
    const controller = new AbortController();
    importRequest.current = controller;
    setBusy(true);
    setError("");
    const added: ReadingSourceDraft[] = [];
    let committed = false;
    try {
      for (const file of Array.from(list)) {
        controller.signal.throwIfAborted();
        if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
          setProcessing(`正在读取 PDF：${file.name}`);
          const blobs = await pdfToImageBlobs(file, (done, total) => setProcessing(`正在渲染 ${file.name} · 第 ${done}/${total} 页`), controller.signal);
          controller.signal.throwIfAborted();
          blobs.forEach((blob, index) => added.push({ name: `${file.name} · ${index + 1}`, blob, previewUrl: preview(blob) }));
        } else if (file.type.startsWith("image/")) {
          setProcessing(`正在处理图片：${file.name}`);
          const blob = await fileToJpegBlob(file);
          controller.signal.throwIfAborted();
          added.push({ name: file.name, blob, previewUrl: preview(blob) });
        } else if (/\.(txt|md|markdown)$/i.test(file.name)) {
          setProcessing(`正在读取文本：${file.name}`);
          if (file.size > MAX_PAPER_TEXT_BYTES) throw new Error("单个文本来源最多 1.5 MB。");
          const bytes = await file.arrayBuffer();
          decodePaperText(new Uint8Array(bytes));
          const mime = /\.txt$/i.test(file.name) ? "text/plain" : "text/markdown";
          const blob = new Blob([bytes], { type: mime });
          added.push({ name: file.name, blob, previewUrl: null });
        } else {
          throw new Error(`不支持的文件类型：${file.name}`);
        }
      }
      controller.signal.throwIfAborted();
      setSources((current) => [...current, ...added]);
      setPreviewPage(Math.floor((sources.length + (text.trim() ? 1 : 0)) / PREVIEW_PAGE_SIZE));
      if (list[0]) setTitle((current) => current.trim() ? current : list[0].name.replace(/\.[^.]+$/, ""));
      committed = true;
    } finally {
      if (!committed) for (const item of added) if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        objectUrls.current.delete(item.previewUrl);
      }
      adding.current = false;
      if (importRequest.current === controller) importRequest.current = null;
      setProcessing("");
      setBusy(false);
    }
  }

  function addFiles(list: FileList | File[]) {
    void importFiles(list).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  async function submit() {
    if (busy || adding.current) return;
    const pasted = text.trim();
    if (pasted && new TextEncoder().encode(pasted).byteLength > MAX_PAPER_TEXT_BYTES) {
      setError("粘贴的文章原文作为单页来源最多 1.5 MB；也可以拆成多个文本文件导入。");
      return;
    }
    const total = sources.length + (pasted ? 1 : 0);
    if (!total) return;
    setBusy(true);
    setError("");
    try {
      let id = readingId;
      if (!id) {
        const response = await fetch("/api/readings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, language, expectedPageCount: total }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        id = data.id;
        setReadingId(id);
      }

      const queue: { blob: Blob; name: string }[] = [];
      if (pasted) queue.push({ blob: new Blob([pasted], { type: "text/plain" }), name: "粘贴的文章原文" });
      queue.push(...sources.map(({ blob, name }) => ({ blob, name })));
      const uploadedResponse = await fetch(`/api/readings/${id}/sources`, { cache: "no-store" });
      const uploadedPages = await uploadedResponse.json();
      if (!uploadedResponse.ok) throw new Error(uploadedPages.error || "读取已上传来源失败。");
      const uploaded = new Set<number>((uploadedPages as { idx: number }[]).map((page) => page.idx));
      for (let index = 0; index < queue.length; index++) {
        if (uploaded.has(index)) continue;
        setProcessing(`正在上传来源 ${index + 1}/${queue.length}：${queue[index].name}`);
        const response = await fetch(`/api/readings/${id}/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idx: index, dataUrl: await blobToDataUrl(queue[index].blob) }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `第 ${index + 1} 个来源上传失败。`);
      }
      router.push(`/readings/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProcessing("");
      setBusy(false);
    }
  }

  const pasted = text.trim();
  const pageCount = sources.length + (pasted ? 1 : 0);
  const entries: { name: string; previewUrl: string | null; index: number | null }[] = [
    ...(pasted ? [{ name: "粘贴的文章原文", previewUrl: null, index: null }] : []),
    ...sources.map((source, index) => ({ name: source.name, previewUrl: source.previewUrl, index })),
  ];
  const previewPageCount = Math.max(1, Math.ceil(entries.length / PREVIEW_PAGE_SIZE));
  const visiblePage = Math.min(previewPage, previewPageCount - 1);
  const visibleEntries = entries.slice(visiblePage * PREVIEW_PAGE_SIZE, (visiblePage + 1) * PREVIEW_PAGE_SIZE);

  return <div><AppHeader /><main className="mx-auto max-w-4xl px-4 py-8">
    <Link href="/readings" className="flex items-center gap-2 text-sm"><ArrowLeft className="h-4 w-4" />外刊导读</Link>
    <h1 className="mt-3 text-[32px] font-bold">上传外刊</h1>
    <div className="mt-6 grid gap-5 sm:grid-cols-2">
      <label>文章标题<input className={`${input} mt-2`} value={title} disabled={!!readingId} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>文章语言<select className={`${input} mt-2`} value={language} disabled={!!readingId} onChange={(event) => setLanguage(event.target.value as ReadingLanguage)}><option value="en">英语</option><option value="ja">日语</option></select></label>
    </div>
    <label className="mt-6 block">文章原文<textarea aria-label="文章原文" disabled={busy || !!readingId} className={`${input} mt-2 min-h-72 leading-7 disabled:bg-neutral-50`} value={text} onChange={(event) => setText(event.target.value)} /></label>
    <MaterialImportTools pageCount={pageCount} maxPages={Infinity} disabled={busy || !!readingId} onFiles={importFiles} />
    <button disabled={busy || !!readingId} className="mt-5 flex items-center gap-2 border border-neutral-300 px-4 py-2 disabled:opacity-40" onClick={() => picker.current?.click()}><Upload className="h-4 w-4" />添加 PDF、图片或文本</button>
    <input ref={picker} className="hidden" type="file" multiple accept="image/*,.pdf,.txt,.md,.markdown" disabled={busy || !!readingId} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-y border-neutral-200 py-3">
      <p className="text-sm text-neutral-600">共 {pageCount} 个来源页{readingId ? " · 上传失败可重试续传" : " · 不限页数"}</p>
      {entries.length > PREVIEW_PAGE_SIZE && <div className="flex items-center gap-2 text-sm"><button aria-label="上一组来源" disabled={visiblePage === 0} onClick={() => setPreviewPage(visiblePage - 1)}><ChevronLeft className="h-4 w-4" /></button><span>{visiblePage + 1} / {previewPageCount}</span><button aria-label="下一组来源" disabled={visiblePage >= previewPageCount - 1} onClick={() => setPreviewPage(visiblePage + 1)}><ChevronRight className="h-4 w-4" /></button></div>}
    </div>
    <div className="divide-y divide-neutral-200">
      {visibleEntries.map((entry, visibleIndex) => {
        const globalIndex = visiblePage * PREVIEW_PAGE_SIZE + visibleIndex;
        return <div key={`${globalIndex}-${entry.name}`} className="flex items-center gap-3 py-3">
          {entry.previewUrl && <Image src={entry.previewUrl} width={48} height={64} unoptimized alt="" className="h-16 w-12 shrink-0 border border-neutral-200 object-cover" />}
          <span className="min-w-0 flex-1 break-words text-sm">{globalIndex + 1}. {entry.name}</span>
          {entry.index !== null && <button disabled={busy || !!readingId} title="移除来源" aria-label="移除来源" onClick={() => { const source = sources[entry.index!]; if (source.previewUrl) { URL.revokeObjectURL(source.previewUrl); objectUrls.current.delete(source.previewUrl); } setSources((current) => current.filter((_, sourceIndex) => sourceIndex !== entry.index)); }} className="shrink-0 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>}
        </div>;
      })}
    </div>
    {processing && <p className="mt-3 flex items-center gap-2 text-sm text-neutral-600" role="status"><Loader2 className="h-4 w-4 animate-spin" />{processing}</p>}
    {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
    <button disabled={busy || !pageCount} className="ink-button mt-6 px-5 py-3 disabled:opacity-40" onClick={() => void submit()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{readingId ? "续传未完成来源" : "上传文章并自动识别"}</button>
  </main></div>;
}
