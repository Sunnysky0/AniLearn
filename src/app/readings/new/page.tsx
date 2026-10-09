"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, Trash2, Loader2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { fileToJpegDataUrl, pdfToImages } from "@/lib/client/media";
import { decodePaperText } from "@/lib/paper-source";
import { MAX_PAPER_PAGES, MAX_PAPER_TEXT_BYTES, type ReadingLanguage } from "@/lib/types";
const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";
export default function NewReadingPage() {
  const router = useRouter(); const picker = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(""); const [language, setLanguage] = useState<ReadingLanguage>("en"); const [text, setText] = useState("");
  const [sources, setSources] = useState<{ name: string; dataUrl: string }[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function add(files: FileList) {
    setBusy(true); setError("");
    try {
      const added: typeof sources = [];
      for (const f of Array.from(files)) {
        if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
          const images = await pdfToImages(f); images.forEach((dataUrl, i) => added.push({ name: `${f.name} · ${i + 1}`, dataUrl }));
        } else if (f.type.startsWith("image/")) added.push({ name: f.name, dataUrl: await fileToJpegDataUrl(f) });
        else if (/\.(txt|md|markdown)$/i.test(f.name)) {
          if (f.size > MAX_PAPER_TEXT_BYTES) throw new Error("文本最多 1.5 MB");
          const bytes = await f.arrayBuffer(); decodePaperText(new Uint8Array(bytes)); const mime = /\.txt$/i.test(f.name) ? "text/plain" : "text/markdown";
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("文本读取失败")); reader.readAsDataURL(new Blob([bytes], { type: mime })); });
          added.push({ name: f.name, dataUrl });
        } else throw new Error(`不支持 ${f.name}`);
      }
      if (sources.length + added.length + (text.trim() ? 1 : 0) > MAX_PAPER_PAGES) throw new Error(`每篇文章最多 ${MAX_PAPER_PAGES} 页`);
      setSources((old) => [...old, ...added]); if (!title && files[0]) setTitle(files[0].name.replace(/\.[^.]+$/, ""));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function submit() {
    setBusy(true); setError("");
    try {
      if (sources.length + (text.trim() ? 1 : 0) > MAX_PAPER_PAGES) throw new Error("来源页过多");
      const res = await fetch("/api/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, language, text }) });
      const material = await res.json(); if (!res.ok) throw new Error(material.error);
      for (const source of sources) { const response = await fetch(`/api/readings/${material.id}/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: source.dataUrl }) }); if (!response.ok) { const data = await response.json(); throw new Error(data.error); } }
      router.push(`/readings/${material.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return <div><AppHeader /><main className="mx-auto max-w-4xl px-4 py-8"><Link href="/readings" className="flex items-center gap-2 text-sm"><ArrowLeft className="h-4 w-4" />外刊导读</Link><h1 className="mt-3 text-[32px] font-bold">上传外刊</h1>
    <div className="mt-6 grid gap-5 sm:grid-cols-2"><label>文章标题<input className={`${input} mt-2`} value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>文章语言<select className={`${input} mt-2`} value={language} onChange={(e) => setLanguage(e.target.value as ReadingLanguage)}><option value="en">英语</option><option value="ja">日语</option></select></label></div>
    <label className="mt-6 block">文章原文<textarea aria-label="文章原文" className={`${input} mt-2 min-h-72 leading-7`} value={text} onChange={(e) => setText(e.target.value)} /></label>
    <button disabled={busy} className="mt-5 flex items-center gap-2 border border-neutral-300 px-4 py-2" onClick={() => picker.current?.click()}><Upload className="h-4 w-4" />添加 PDF、图片或文本</button><input ref={picker} className="hidden" type="file" multiple accept="image/*,.pdf,.txt,.md,.markdown" onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = ""; }} />
    <div className="mt-4 divide-y border-y border-neutral-200">{sources.map((source, i) => <div key={`${i}-${source.name}`} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0 break-words text-sm">{source.name}</span><button disabled={busy} title="移除来源" aria-label="移除来源" onClick={() => setSources((old) => old.filter((_, idx) => idx !== i))}><Trash2 className="h-4 w-4" /></button></div>)}</div>
    {error && <p className="mt-4 text-sm" role="alert">{error}</p>}<button disabled={busy || !sources.length && !text.trim()} className="ink-button mt-6 px-5 py-3 disabled:opacity-40" onClick={() => void submit()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}上传文章</button>
  </main></div>;
}
