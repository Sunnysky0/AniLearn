"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BookOpen, ChevronLeft, Loader2, Upload } from "lucide-react";
import { MAX_BOOK_UPLOAD_BYTES, type BookKind } from "@/lib/types";

export default function BookUpload() {
  const router = useRouter(); const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null); const [kind, setKind] = useState<BookKind>("thought");
  const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [mobi, setMobi] = useState<{ available: boolean; error: string | null } | null>(null);
  const uploadRequest = useRef<{ file: File; kind: BookKind; title: string; id: string } | null>(null);
  useEffect(() => { let active = true; void fetch("/api/books").then(r => r.json()).then(data => { if (active) setMobi(data.mobi); }).catch(() => { if (active) setMobi({ available: false, error: "暂时无法检查 MOBI 转换工具。" }); }); return () => { active = false; }; }, []);
  function choose(value?: File) {
    setError(""); if (!value) return;
    if (!/\.(epub|mobi)$/i.test(value.name)) { setError("请选择 EPUB 或 MOBI 电子书。"); return; }
    if (value.size > MAX_BOOK_UPLOAD_BYTES) { setError("单本电子书最多 50 MiB。"); return; }
    setFile(value);
  }
  async function upload() {
    if (!file || busy) return; setBusy(true); setError("");
    try {
      const requestedTitle = title.trim();
      if (uploadRequest.current?.file !== file || uploadRequest.current.kind !== kind || uploadRequest.current.title !== requestedTitle) {
        uploadRequest.current = { file, kind, title: requestedTitle, id: crypto.randomUUID() };
      }
      const body = new FormData(); body.set("file", file); body.set("kind", kind); body.set("requestId", uploadRequest.current.id); if (requestedTitle) body.set("title", requestedTitle);
      const response = await fetch("/api/books", { method: "POST", body }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "导入失败，请重试。");
      router.push(`/books/${data.book.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
    <Link href="/books" className="inline-flex items-center gap-1 text-sm text-neutral-500"><ChevronLeft className="h-4 w-4" />典籍书架</Link>
    <h1 className="mt-6 text-[32px] font-bold">导入一本书</h1><p className="mt-3 text-sm leading-7 text-neutral-600">保留电子书原文，按目录整理章节。导入后可校对标题、拆章或合章。</p>
    <input ref={fileRef} aria-label="选择电子书" type="file" accept=".epub,.mobi" className="sr-only" onChange={e => choose(e.target.files?.[0])} />
    <button disabled={busy} type="button" onClick={() => fileRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) choose(e.dataTransfer.files[0]); }} className="mt-8 flex min-h-48 w-full flex-col items-center justify-center gap-4 border border-dashed border-neutral-400 bg-white px-5 py-8">
      <BookOpen className="h-8 w-8" /><span className="break-all text-base">{file?.name || "选择或拖入 EPUB / MOBI"}</span><span className="text-xs text-neutral-500">{file ? `${(file.size / 1024 / 1024).toFixed(1)} MiB · 点击重新选择` : "单本最多 50 MiB"}</span>
    </button>
    {mobi && !mobi.available && <p className="mt-3 text-sm text-neutral-600">{mobi.error || "MOBI 转换工具尚未配置。EPUB 可直接导入。"}</p>}
    <div className="mt-8 space-y-6 border-t border-neutral-300 pt-6">
      <label className="block text-sm">书名（留空读取电子书信息）<input className="mt-2 w-full border border-neutral-300 bg-white px-3 py-2" value={title} onChange={e => setTitle(e.target.value)} maxLength={300} /></label>
      <fieldset><legend className="mb-3 text-sm">导读类型</legend><div className="grid gap-3 sm:grid-cols-3">{([{ id: "thought", name: "思想论说", detail: "概念、论证、推演" }, { id: "literary", name: "文学作品", detail: "叙事、语言、情感" }, { id: "classical", name: "文言典籍", detail: "字词、句读、义理" }] as const).map(item => <label key={item.id} className={`flex gap-3 border p-4 ${kind === item.id ? "border-neutral-900 bg-white" : "border-neutral-300"}`}><input type="radio" name="kind" value={item.id} checked={kind === item.id} onChange={() => setKind(item.id)} /><span><span className="block text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs text-neutral-500">{item.detail}</span></span></label>)}</div></fieldset>
    </div>
    {error && <p role="alert" className="mt-5 text-sm text-red-700">{error}</p>}
    <button disabled={!file || busy || (/\.mobi$/i.test(file?.name ?? "") && !mobi?.available)} onClick={() => void upload()} className="ink-button mt-8 px-6 py-3 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy ? "正在上传…" : "导入并整理目录"}</button>
  </main>;
}
