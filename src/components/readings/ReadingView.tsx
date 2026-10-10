"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Play, ScanSearch, Save, Trash2 } from "lucide-react";
import type { ReadingAnalysisStatus, ReadingDTO, TutorDTO } from "@/lib/types";

interface ReadingSource { idx: number; mime: string }
interface PageDraft { text: string; savedText: string; recognized: boolean; revision: number }
const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";

export default function ReadingView({ initial, sources, tutors, classrooms }: { initial: ReadingDTO; sources: ReadingSource[]; tutors: TutorDTO[]; classrooms: { id: number; currentIdx: number; status: string }[] }) {
  const router = useRouter();
  const [reading, setReading] = useState(initial);
  const pagedWorkflow = (reading.expectedPageCount ?? 0) > 0;
  const [text, setText] = useState(initial.extracted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial.error ?? "");
  const [tutorId, setTutorId] = useState(tutors[0]?.id ?? 0);
  const [analysis, setAnalysis] = useState<ReadingAnalysisStatus | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [pageDraft, setPageDraft] = useState<PageDraft>({ text: "", savedText: "", recognized: false, revision: initial.revision });
  const [loadedPageIdx, setLoadedPageIdx] = useState<number | null>(null);
  const pageDirty = pageDraft.text !== pageDraft.savedText;
  const totalPages = initial.expectedPageCount || sources.length;
  const currentSource = sources[pageIdx];
  const pageLoading = pagedWorkflow && loadedPageIdx !== pageIdx;

  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/readings/${reading.id}/analysis-status`, { cache: "no-store" });
    const data: ReadingAnalysisStatus = await response.json();
    if (!response.ok) throw new Error((data as unknown as { error?: string }).error || "读取识别进度失败");
    setAnalysis(data);
    setReading((current) => ({ ...current, status: data.status === "analyzing" && !data.running ? "failed" : data.status, revision: data.revision ?? current.revision, error: data.error }));
    if (data.error) setError(data.error);
    return data;
  }, [reading.id]);

  useEffect(() => {
    if (!pagedWorkflow) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const data = await refreshStatus();
        if (active && data.running) timer = setTimeout(() => void poll(), 3000);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [pagedWorkflow, reading.id, reading.status, refreshStatus]);

  useEffect(() => {
    if (!pagedWorkflow || !currentSource) return;
    let active = true;
    fetch(`/api/readings/${reading.id}/pages/${currentSource.idx}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取来源页失败");
        if (active) {
          setPageDraft({ text: data.text, savedText: data.text, recognized: data.recognized, revision: data.revision });
          setLoadedPageIdx(pageIdx);
        }
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [currentSource, pageIdx, pagedWorkflow, reading.id, reading.status]);

  const startAnalysis = useCallback(async (restart: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/readings/${reading.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ background: true, restart }),
      });
      const data = await response.json();
      if (response.status === 409 && /正在识别/.test(data.error ?? "")) {
        setReading((current) => ({ ...current, status: "analyzing" }));
      } else if (!response.ok) {
        throw new Error(data.error || "无法开始识别");
      } else {
        setReading((current) => ({ ...current, expectedPageCount: data.expectedPageCount, status: "analyzing", error: null }));
        setAnalysis((current) => ({ status: "analyzing", completedPages: restart ? 0 : current?.completedPages ?? 0, totalPages, currentPage: restart ? 1 : current?.currentPage ?? 1, sourcesComplete: true, running: true, resumable: false, error: null }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [reading.id, totalPages]);

  async function savePage() {
    if (!currentSource || !pageDirty) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/readings/${reading.id}/pages/${currentSource.idx}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pageDraft.text, revision: pageDraft.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存校对失败");
      setPageDraft((current) => ({ ...current, savedText: current.text, recognized: true, revision: data.revision }));
      setReading((current) => ({ ...current, status: data.status, revision: data.revision, error: null }));
      setAnalysis((current) => current ? { ...current, completedPages: Math.min(totalPages, current.completedPages + (pageDraft.recognized ? 0 : 1)) } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPages() {
    if (pageDirty) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/readings/${reading.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: reading.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "确认文章失败");
      setReading((current) => ({ ...current, status: "ready", revision: data.revision, error: null }));
      setAnalysis((current) => current ? { ...current, status: "ready", completedPages: totalPages, currentPage: null, resumable: false, error: null } : current);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmLegacyText() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/readings/${reading.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, revision: reading.revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setReading(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startClassroom() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reading-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readingId: reading.id, tutorId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/reading-classroom/${data.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("删除文章和相关阅读记录？")) return;
    const response = await fetch(`/api/readings/${reading.id}`, { method: "DELETE" });
    if (response.ok) router.push("/readings");
    else { const data = await response.json(); setError(data.error); }
  }

  const pageComplete = analysis?.completedPages ?? (reading.status === "review" || reading.status === "ready" ? totalPages : 0);
  const canConfirm = pagedWorkflow && reading.status === "review" && pageComplete === totalPages && !pageDirty;
  const isRunning = analysis?.running || reading.status === "analyzing";
  const pageGroupCount = Math.max(1, Math.ceil(totalPages / 50));

  return <main className="mx-auto max-w-6xl px-4 py-8">
    <Link href="/readings" className="text-sm">外刊导读</Link>
    <div className="mt-3 flex items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-[32px] font-bold">{reading.title}</h1><p className="mt-2 text-sm text-neutral-500">{reading.language === "ja" ? "日语" : "英语"} · {sources.length} 页</p></div><button title="删除文章" aria-label="删除文章" onClick={() => void remove()}><Trash2 className="h-5 w-5" /></button></div>
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_280px]">
      <section className="min-w-0">
        {pagedWorkflow ? <>
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">按来源页校对原文</h2>{reading.status === "ready" ? <button disabled={busy || isRunning} className="flex items-center gap-2 border px-3 py-2 text-sm disabled:opacity-40" onClick={() => { if (window.confirm("重新识别会替换当前各页识别稿，是否继续？")) void startAnalysis(true); }}><ScanSearch className="h-4 w-4" />重新识别全文</button> : analysis?.resumable ? <button disabled={busy} className="flex items-center gap-2 border px-3 py-2 text-sm disabled:opacity-40" onClick={() => void startAnalysis(false)}><ScanSearch className="h-4 w-4" />续接识别</button> : null}</div>
          <div className="mt-4 border border-neutral-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{isRunning ? "正在后台识别原文" : reading.status === "failed" ? "识别尚未完成" : reading.status === "review" ? "识别完成，请校对后确认" : reading.status === "ready" ? "文章原文已确认" : "等待识别"}</p><p className="mt-1 text-sm text-neutral-500">已识别 {pageComplete}/{totalPages} 页{isRunning && analysis?.currentPage ? ` · 正在处理第 ${analysis.currentPage} 页` : ""}</p></div><span role="status" className="text-xs text-neutral-500">{isRunning ? "关闭网页后识别会继续" : "识别结果逐页保存"}</span></div>
            {analysis?.resumable && <button disabled={busy} className="mt-3 text-sm underline disabled:opacity-40" onClick={() => void startAnalysis(false)}>从未完成页继续</button>}
          </div>
          {currentSource && <>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-neutral-200 py-3"><div className="flex items-center gap-2"><button aria-label="上一来源页" disabled={pageIdx === 0 || pageDirty || busy} onClick={() => setPageIdx(pageIdx - 1)}><ChevronLeft className="h-4 w-4" /></button><label className="flex items-center gap-2 text-sm">来源页<select aria-label="校对来源页" className="border bg-white p-2" disabled={pageDirty || busy} value={pageIdx} onChange={(event) => setPageIdx(Number(event.target.value))}>{sources.map((source, index) => <option key={source.idx} value={index}>第 {index + 1} 页{analysis?.completedPages && index < analysis.completedPages ? " · 已识别" : ""}</option>)}</select></label><button aria-label="下一来源页" disabled={pageIdx >= sources.length - 1 || pageDirty || busy} onClick={() => setPageIdx(pageIdx + 1)}><ChevronRight className="h-4 w-4" /></button><span className="text-xs text-neutral-500">第 {Math.floor(pageIdx / 50) + 1}/{pageGroupCount} 组</span></div><a href={`/api/readings/${reading.id}/sources/${currentSource.idx}`} target="_blank" rel="noreferrer" className="text-sm underline">查看原始来源</a></div>
            <label className="mt-3 block text-sm">第 {pageIdx + 1} 页识别原文<textarea aria-label="当前页校对原文" lang={reading.language} value={pageDraft.text} disabled={pageLoading || isRunning} onChange={(event) => setPageDraft((current) => ({ ...current, text: event.target.value }))} className="mt-2 min-h-[440px] w-full border border-neutral-300 bg-white p-4 text-base leading-8 disabled:bg-neutral-50" /></label>
            <div className="mt-3 flex flex-wrap items-center gap-3"><button disabled={busy || pageLoading || !pageDirty || isRunning} className="ink-button px-4 py-2 disabled:opacity-40" onClick={() => void savePage()}><Save className="h-4 w-4" />保存本页</button>{pageLoading ? <span className="text-sm text-neutral-500">正在读取本页…</span> : pageDraft.recognized && !pageDraft.text.trim() ? <span className="text-sm text-neutral-500">此页识别为空白页，可确认</span> : pageDirty ? <span className="text-sm text-neutral-500">本页有未保存修改</span> : null}</div>
          </>}
          <button disabled={busy || !canConfirm} className="ink-button mt-5 px-4 py-3 disabled:opacity-40" onClick={() => void confirmPages()}><Save className="h-4 w-4" />确认全部原文</button>
        </> : <>
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">原文校对</h2><button disabled={busy || reading.status === "analyzing"} className="flex items-center gap-2 border px-3 py-2 text-sm" onClick={() => void startAnalysis(false)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}识别原文</button></div>
          <textarea aria-label="校对原文" lang={reading.language} value={text} onChange={(event) => setText(event.target.value)} className="mt-4 min-h-[440px] w-full border border-neutral-300 bg-white p-4 text-base leading-8" />
          <div className="mt-3 flex flex-wrap items-center gap-3"><button disabled={busy || !text.trim()} className="ink-button px-4 py-2" onClick={() => void confirmLegacyText()}><Save className="h-4 w-4" />确认原文</button><span className="text-sm">{reading.status === "ready" ? "原文已确认" : "可继续校对识别原文"}</span></div>
        </>}
      </section>
      <aside className="space-y-5 border-t-2 border-neutral-900 py-5"><h2 className="font-semibold">阅读导师</h2><select aria-label="阅读导师" value={tutorId} onChange={(event) => setTutorId(Number(event.target.value))} className="w-full border bg-white p-2">{tutors.map((tutor) => <option key={tutor.id} value={tutor.id}>{tutor.name}</option>)}</select><button disabled={busy || reading.status !== "ready" || (pagedWorkflow ? pageDirty : text !== reading.extracted)} onClick={() => void startClassroom()} className="ink-button w-full justify-center px-4 py-3 disabled:opacity-40"><Play className="h-4 w-4" />开始导读</button>
        <h2 className="font-semibold">来源</h2>{sources.slice(Math.max(0, pageIdx - 2), pageIdx + 3).map((source) => <a key={source.idx} href={`/api/readings/${reading.id}/sources/${source.idx}`} target="_blank" rel="noreferrer" className="block border-b py-2 text-sm">第 {source.idx + 1} 页 · {source.mime.startsWith("image/") ? "图片" : "文本"}</a>)}
        {classrooms.length > 0 && <h2 className="font-semibold">阅读记录</h2>}{classrooms.map((classroom) => <Link key={classroom.id} className="block border-b py-2 text-sm" href={`/reading-classroom/${classroom.id}`}>{classroom.status === "completed" ? "本篇已读完" : `继续第 ${classroom.currentIdx + 1} 段`}</Link>)}
      </aside>
    </div>
    {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
  </main>;
}
