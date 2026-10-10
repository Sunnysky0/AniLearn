"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, Loader2, Trash2, Upload } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { MaterialImportTools } from "@/components/MaterialImportTools";
import { fileToJpegDataUrl, pdfToImages } from "@/lib/client/media";
import { decodePaperText } from "@/lib/paper-source";
import { MAX_PAPER_PAGES, MAX_PAPER_TEXT_BYTES, type ReadingLanguage } from "@/lib/types";

interface ReadingSourceDraft { name: string; dataUrl: string }
const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";

export default function NewReadingPage() {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<ReadingLanguage>("en");
  const [text, setText] = useState("");
  const [sources, setSources] = useState<ReadingSourceDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState("");
  const [error, setError] = useState("");

  async function importFiles(list: FileList | File[]) {
    if (busy || adding.current) return;
    adding.current = true;
    setBusy(true);
    setError("");
    const files = Array.from(list);
    const added: ReadingSourceDraft[] = [];
    try {
      for (const file of files) {
        const remaining = MAX_PAPER_PAGES - sources.length - (text.trim() ? 1 : 0) - added.length;
        if (remaining <= 0) throw new Error(`每篇文章最多 ${MAX_PAPER_PAGES} 个来源页，请移除已有来源后再导入。`);
        if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
          setProcessing(`正在读取 PDF：${file.name}`);
          const pageLimit = remaining === MAX_PAPER_PAGES ? `每篇文章最多 ${MAX_PAPER_PAGES} 个来源页` : `此文章还可添加 ${remaining} 个来源页（上限 ${MAX_PAPER_PAGES} 页）`;
          const images = await pdfToImages(file, (done, total) => setProcessing(`正在渲染 ${file.name} · 第 ${done}/${total} 页`), remaining, pageLimit);
          images.forEach((dataUrl, index) => added.push({ name: `${file.name} · ${index + 1}`, dataUrl }));
        } else if (file.type.startsWith("image/")) {
          setProcessing(`正在处理图片：${file.name}`);
          added.push({ name: file.name, dataUrl: await fileToJpegDataUrl(file) });
        } else if (/\.(txt|md|markdown)$/i.test(file.name)) {
          setProcessing(`正在读取文本：${file.name}`);
          if (file.size > MAX_PAPER_TEXT_BYTES) throw new Error("文本最多 1.5 MB。");
          const bytes = await file.arrayBuffer();
          decodePaperText(new Uint8Array(bytes));
          const mime = /\.txt$/i.test(file.name) ? "text/plain" : "text/markdown";
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("文本读取失败。"));
            reader.readAsDataURL(new Blob([bytes], { type: mime }));
          });
          added.push({ name: file.name, dataUrl });
        } else {
          throw new Error(`不支持的文件类型：${file.name}`);
        }
      }
      if (sources.length + (text.trim() ? 1 : 0) + added.length > MAX_PAPER_PAGES) {
        throw new Error(`每篇文章最多 ${MAX_PAPER_PAGES} 个来源页，请移除已有来源后再导入。`);
      }
      setSources((current) => [...current, ...added]);
      if (files[0]) setTitle((current) => current.trim() ? current : files[0].name.replace(/\.[^.]+$/, ""));
    } finally {
      adding.current = false;
      setProcessing("");
      setBusy(false);
    }
  }

  function addFiles(list: FileList | File[]) {
    void importFiles(list).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  async function submit() {
    if (busy || adding.current) return;
    setBusy(true);
    setError("");
    try {
      if (sources.length + (text.trim() ? 1 : 0) > MAX_PAPER_PAGES) throw new Error(`每篇文章最多 ${MAX_PAPER_PAGES} 个来源页。`);
      const res = await fetch("/api/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, language, text }) });
      const material = await res.json();
      if (!res.ok) throw new Error(material.error);
      for (const source of sources) {
        const response = await fetch(`/api/readings/${material.id}/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: source.dataUrl }) });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error);
        }
      }
      router.push(`/readings/${material.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  const pageCount = sources.length + (text.trim() ? 1 : 0);

  return <div><AppHeader /><main className="mx-auto max-w-4xl px-4 py-8">
    <Link href="/readings" className="flex items-center gap-2 text-sm"><ArrowLeft className="h-4 w-4" />外刊导读</Link>
    <h1 className="mt-3 text-[32px] font-bold">上传外刊</h1>
    <div className="mt-6 grid gap-5 sm:grid-cols-2">
      <label>文章标题<input className={`${input} mt-2`} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>文章语言<select className={`${input} mt-2`} value={language} onChange={(event) => setLanguage(event.target.value as ReadingLanguage)}><option value="en">英语</option><option value="ja">日语</option></select></label>
    </div>
    <label className="mt-6 block">文章原文<textarea aria-label="文章原文" disabled={busy} className={`${input} mt-2 min-h-72 leading-7 disabled:bg-neutral-50`} value={text} onChange={(event) => setText(event.target.value)} /></label>
    <MaterialImportTools pageCount={pageCount} disabled={busy} onFiles={importFiles} />
    <button disabled={busy} className="mt-5 flex items-center gap-2 border border-neutral-300 px-4 py-2 disabled:opacity-40" onClick={() => picker.current?.click()}><Upload className="h-4 w-4" />添加 PDF、图片或文本</button>
    <input ref={picker} className="hidden" type="file" multiple accept="image/*,.pdf,.txt,.md,.markdown" disabled={busy} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
    {processing && <p className="mt-3 flex items-center gap-2 text-sm text-neutral-600" role="status"><Loader2 className="h-4 w-4 animate-spin" />{processing}</p>}
    <div className="mt-4 divide-y border-y border-neutral-200">
      {sources.map((source, index) => <div key={`${index}-${source.name}`} className="flex items-center gap-3 py-3">
        {source.dataUrl.startsWith("data:image/") && <Image src={source.dataUrl} width={48} height={64} unoptimized alt="" className="h-16 w-12 shrink-0 border border-neutral-200 object-cover" />}
        <span className="min-w-0 flex-1 break-words text-sm">{index + 1}. {source.name}</span>
        <button disabled={busy} title="移除来源" aria-label="移除来源" onClick={() => setSources((old) => old.filter((_, sourceIndex) => sourceIndex !== index))} className="shrink-0 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
      </div>)}
    </div>
    {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
    <button disabled={busy || !sources.length && !text.trim()} className="ink-button mt-6 px-5 py-3 disabled:opacity-40" onClick={() => void submit()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}上传文章</button>
  </main></div>;
}
