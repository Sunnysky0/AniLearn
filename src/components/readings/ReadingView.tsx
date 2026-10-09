"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, ScanSearch, Save, Play, Trash2 } from "lucide-react";
import type { ReadingDTO, TutorDTO } from "@/lib/types";
export default function ReadingView({ initial, sources, tutors, classrooms }: { initial: ReadingDTO; sources: { idx: number; mime: string }[]; tutors: TutorDTO[]; classrooms: { id: number; currentIdx: number; status: string }[] }) {
  const [reading, setReading] = useState(initial); const [text, setText] = useState(initial.extracted); const [busy, setBusy] = useState(false); const [error, setError] = useState(initial.error ?? ""); const [progress, setProgress] = useState(""); const [tutorId, setTutorId] = useState(tutors[0]?.id ?? 0); const router = useRouter();
  useEffect(() => { if (reading.status !== "analyzing") return; const timer = setInterval(() => { void fetch(`/api/readings/${reading.id}`).then((r) => r.json()).then((data) => { setReading(data.reading); setText(data.reading.extracted); setError(data.reading.error ?? ""); }); }, 3000); return () => clearInterval(timer); }, [reading.id, reading.status]);
  async function analyze() {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/readings/${reading.id}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); if (!res.ok || !res.body) { const data = await res.json(); throw new Error(data.error); }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      for (;;) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); let nl; while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line.trim()) continue; const event = JSON.parse(line); if (event.type === "error") throw new Error(event.error); if (event.type === "progress") setProgress(`已识别 ${event.done}/${event.total} 页`); if (event.type === "done") { setReading(event.reading); setText(event.reading.extracted); } } }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError(""); try { const res = await fetch(`/api/readings/${reading.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, revision: reading.revision }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setReading(data); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function start() { setBusy(true); setError(""); try { const res = await fetch("/api/reading-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readingId: reading.id, tutorId }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); router.push(`/reading-classroom/${data.id}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); } }
  async function remove() { if (!window.confirm("删除文章和相关阅读记录？")) return; const res = await fetch(`/api/readings/${reading.id}`, { method: "DELETE" }); if (res.ok) router.push("/readings"); else { const data = await res.json(); setError(data.error); } }
  return <main className="mx-auto max-w-6xl px-4 py-8"><Link href="/readings" className="text-sm">外刊导读</Link><div className="mt-3 flex items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-[32px] font-bold">{reading.title}</h1><p className="mt-2 text-sm text-neutral-500">{reading.language === "ja" ? "日语" : "英语"} · {sources.length} 页 · {reading.paragraphs.length} 段</p></div><button title="删除文章" aria-label="删除文章" onClick={() => void remove()}><Trash2 className="h-5 w-5" /></button></div>
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_280px]"><section className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">原文校对</h2><button disabled={busy || reading.status === "analyzing"} className="flex items-center gap-2 border px-3 py-2 text-sm" onClick={() => void analyze()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}识别原文</button></div>
      <textarea aria-label="校对原文" lang={reading.language} value={text} onChange={(e) => setText(e.target.value)} className="mt-4 min-h-[440px] w-full border border-neutral-300 bg-white p-4 text-base leading-8" />
      <div className="mt-3 flex flex-wrap items-center gap-3"><button disabled={busy || !text.trim()} className="ink-button px-4 py-2" onClick={() => void confirm()}><Save className="h-4 w-4" />确认原文</button><span className="text-sm">{reading.status === "ready" ? "原文已确认" : progress}</span></div>
    </section><aside className="space-y-5 border-t-2 border-neutral-900 py-5"><h2 className="font-semibold">阅读导师</h2><select aria-label="阅读导师" value={tutorId} onChange={(e) => setTutorId(Number(e.target.value))} className="w-full border bg-white p-2">{tutors.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button disabled={busy || reading.status !== "ready" || text !== reading.extracted} onClick={() => void start()} className="ink-button w-full justify-center px-4 py-3 disabled:opacity-40"><Play className="h-4 w-4" />开始导读</button>
      <h2 className="font-semibold">来源</h2>{sources.map((s) => <a key={s.idx} href={`/api/readings/${reading.id}/sources/${s.idx}`} target="_blank" rel="noreferrer" className="block border-b py-2 text-sm">第 {s.idx + 1} 页 · {s.mime.startsWith("image/") ? "图片" : "文本"}</a>)}
      {classrooms.length > 0 && <h2 className="font-semibold">阅读记录</h2>}{classrooms.map((c) => <Link key={c.id} className="block border-b py-2 text-sm" href={`/reading-classroom/${c.id}`}>{c.status === "completed" ? "本篇已读完" : `继续第 ${c.currentIdx + 1} 段`}</Link>)}
    </aside></div>{error && <p className="mt-4 text-sm" role="alert">{error}</p>}
  </main>;
}
