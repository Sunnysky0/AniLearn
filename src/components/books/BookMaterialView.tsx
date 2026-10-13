"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Play, RotateCcw, Save, Scissors } from "lucide-react";
import type { BookChapterDraft, BookKind, BookMaterialDTO, ReaderDocument, TutorDTO } from "@/lib/types";

const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";
export default function BookMaterialView({ initial, tutors, classrooms, versions }: {
  initial: BookMaterialDTO; tutors: TutorDTO[];
  classrooms: { id: number; tutorId: number; versionId: number; status: string; updatedAt: string }[];
  versions: { id: number; status: string; createdAt: string }[];
}) {
  const router = useRouter(); const [material, setMaterial] = useState(initial);
  const [chapters, setChapters] = useState(initial.version.chapters); const [kind, setKind] = useState<BookKind>(initial.book.kind);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [tutorId, setTutorId] = useState(tutors[0]?.id ?? 0);
  const [splitIndex, setSplitIndex] = useState<number | null>(null); const [preview, setPreview] = useState<ReaderDocument | null>(null);
  const [splitAt, setSplitAt] = useState(""); const [splitTitle, setSplitTitle] = useState(""); const [previewBusy, setPreviewBusy] = useState(false);
  const activeRef = useRef(true);
  const editing = material.version.status === "review";
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  useEffect(() => {
    if (!["uploaded", "importing"].includes(material.version.status)) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/books/${material.book.id}/analysis-status?versionId=${material.version.id}`, { cache: "no-store" }); const status = await response.json();
        if (!response.ok) throw new Error(status.error || "读取导入进度失败。");
        if (!active) return;
        if (status.status === "review" || status.status === "ready") {
          const detail = await fetch(`/api/books/${material.book.id}?versionId=${material.version.id}`, { cache: "no-store" }); const value = await detail.json();
          if (!detail.ok) throw new Error(value.error || "读取目录失败。");
          if (active) { setMaterial(value); setChapters(value.version.chapters); }
        } else {
          setMaterial(current => ({ ...current, version: { ...current.version, ...status } }));
          if (status.running) timer = setTimeout(() => void poll(), 1500);
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [material.book.id, material.version.id, material.version.status]);
  async function request(path: string, method: string, body: unknown) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const value = await response.json();
    if (!response.ok) throw new Error(value.error || "操作失败，请重试。"); return value;
  }
  async function resume() {
    setBusy(true); setError(""); try {
      await request(`/api/books/${material.book.id}/import`, "POST", { resume: true, versionId: material.version.id });
      setMaterial(current => ({ ...current, version: { ...current.version, status: "importing", running: true, error: null } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function save(publish: boolean) {
    setBusy(true); setError(""); try {
      const saved = await request(`/api/books/${material.book.id}/versions/${material.version.id}`, "PATCH", { revision: material.version.revision, chapters, kind });
      setMaterial(current => ({ ...current, version: saved.version })); setChapters(saved.version.chapters);
      if (publish) {
        const published = await request(`/api/books/${material.book.id}/versions/${saved.version.id}/confirm`, "POST", { revision: saved.version.revision, kind });
        setMaterial(published); setChapters(published.version.chapters); router.refresh();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError(""); try {
      const session = await request("/api/book-sessions", "POST", { bookId: material.book.id, versionId: material.version.status === "ready" ? material.version.id : material.book.currentVersionId, tutorId });
      router.push(`/book-classroom/${session.id ?? session.session?.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  async function openSplit(index: number) {
    setSplitIndex(index); setPreview(null); setPreviewBusy(true); setSplitAt(""); setSplitTitle(`${chapters[index].title}（续）`); setError("");
    try {
      // Persist the corrected directory before reading its source boundary. New
      // splits and merges then have the same block inventory as this preview.
      const saved = await request(`/api/books/${material.book.id}/versions/${material.version.id}`, "PATCH", { revision: material.version.revision, chapters, kind });
      if (!activeRef.current) return;
      setMaterial(current => ({ ...current, version: saved.version })); setChapters(saved.version.chapters);
      const response = await fetch(`/api/books/${material.book.id}/versions/${saved.version.id}/chapters/${encodeURIComponent(saved.version.chapters[index].id)}`); const document = await response.json();
      if (!response.ok) throw new Error(document.error || "无法读取拆章预览。");
      if (activeRef.current) { setPreview(document); setSplitAt(document.blocks[1]?.id ?? ""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPreviewBusy(false); }
  }
  function split() {
    if (splitIndex === null || !splitAt || !splitTitle.trim()) return;
    const original = chapters[splitIndex]; const boundary = original.blockIds.indexOf(splitAt); if (boundary <= 0) return;
    const next = [...chapters]; next.splice(splitIndex, 1, { ...original, blockIds: original.blockIds.slice(0, boundary) }, { ...original, id: `v${material.version.id}-${crypto.randomUUID()}`, title: splitTitle.trim(), blockIds: original.blockIds.slice(boundary) });
    setChapters(next.map((chapter, order) => ({ ...chapter, order }))); setSplitIndex(null);
  }
  function merge(index: number) {
    if (index >= chapters.length - 1) return;
    const first = chapters[index]; const second = chapters[index + 1];
    const next = [...chapters]; next.splice(index, 2, { ...first, blockIds: [...first.blockIds, ...second.blockIds] });
    setChapters(next.map((chapter, order) => ({ ...chapter, parentId: chapter.parentId === second.id ? first.id : chapter.parentId, order })));
  }
  function update(index: number, patch: Partial<BookChapterDraft>) { setChapters(all => all.map((chapter, i) => i === index ? { ...chapter, ...patch } : chapter)); }
  return <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
    <Link href="/books" className="inline-flex items-center gap-1 text-sm text-neutral-500"><ChevronLeft className="h-4 w-4" />典籍书架</Link>
    <div className="mt-6 grid gap-8 border-b-2 border-neutral-900 pb-7 lg:grid-cols-[1fr_300px]">
      <div><p className="mb-3 text-xs text-neutral-500">{material.book.builtinKey ? "内置典籍 · " : ""}{material.book.language === "en" ? "英文" : material.book.language === "ja" ? "日文" : "中文"}</p><h1 className="break-words font-serif text-[32px] font-bold">{material.book.title}</h1><p className="mt-4 text-sm text-neutral-600">{material.book.author}</p><p className="mt-4 text-sm leading-7 text-neutral-500">阅读时可随时提问和批注。读完本章后，由你决定何时开始导读。</p></div>
      <div className="self-end space-y-3">{material.book.currentVersionId && <><label className="block text-sm">陪读导师<select className={`${input} mt-2`} value={tutorId} onChange={e => setTutorId(Number(e.target.value))}>{tutors.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button disabled={busy || !tutorId} className="ink-button w-full justify-center px-4 py-3 disabled:opacity-40" onClick={() => void start()}><Play className="h-4 w-4" />开始新的阅读课堂</button></>}{editing && <p className="text-sm text-neutral-500">先确认目录，再开始阅读。</p>}</div>
    </div>
    {error && <p role="alert" className="mt-5 border-l-2 border-red-700 pl-3 text-sm text-red-700">{error}</p>}
    {versions.filter(version => version.status === "ready").length > 1 && <nav aria-label="典籍内容版本" className="mt-5 flex flex-wrap items-center gap-3 text-sm"><span className="text-neutral-500">内容版本</span>{versions.filter(version => version.status === "ready").map(version => <Link key={version.id} href={`/books/${material.book.id}?versionId=${version.id}`} aria-current={version.id === material.version.id ? "page" : undefined} className={`border px-3 py-1.5 ${version.id === material.version.id ? "border-neutral-900 bg-white" : "border-neutral-300"}`}>{version.id === material.book.currentVersionId ? "当前版本" : `历史版本 ${version.id}`}<span className="ml-2 text-xs text-neutral-500">{new Date(version.createdAt).toLocaleDateString("zh-CN")}</span></Link>)}</nav>}
    {material.version.status !== "ready" && !editing && <div role="status" className="mt-7 border border-neutral-300 bg-white p-5"><p className="font-medium">{material.version.running ? "正在整理电子书" : "导入尚未完成"}</p><p className="mt-2 text-sm text-neutral-500">已整理 {material.version.completedFiles} / {material.version.totalFiles || "…"} 个正文文件</p>{material.version.error && <p className="mt-2 text-sm text-red-700">{material.version.error}</p>}{!material.version.running && <button disabled={busy} className="mt-4 inline-flex items-center gap-2 border px-3 py-2 text-sm" onClick={() => void resume()}><RotateCcw className="h-4 w-4" />续接导入</button>}</div>}
    <section className="mt-8"><div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-xl font-semibold">{editing ? "校对章节目录" : "目录"}</h2>{material.version.status === "ready" && <button disabled={busy} className="border px-3 py-2 text-sm" onClick={() => void save(false)}>调整目录</button>}{editing && <label className="flex items-center gap-3 text-sm">导读类型<select className="border bg-white px-3 py-2" value={kind} onChange={e => setKind(e.target.value as BookKind)}><option value="thought">思想论说</option><option value="literary">文学作品</option><option value="classical">文言典籍</option></select></label>}</div>
      {editing && <p className="mt-3 text-sm leading-7 text-neutral-500">标题和层级可以调整；拆章从选定原文块开始，合章连接相邻正文。保存不会改写原文。</p>}
      <ol className="mt-5 divide-y divide-neutral-300 border-t border-neutral-300">{chapters.map((chapter, index) => <li key={chapter.id} className="py-4">
        {editing ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-[1fr_130px]"><label className="text-xs text-neutral-500">章节标题<input aria-label={`章节 ${index + 1} 标题`} className={`${input} mt-1`} value={chapter.title} onChange={e => update(index, { title: e.target.value })} /></label><label className="text-xs text-neutral-500">内容类型<select aria-label={`章节 ${index + 1} 类型`} className={`${input} mt-1`} value={chapter.role} onChange={e => update(index, { role: e.target.value as BookChapterDraft["role"] })}><option value="main">正文</option><option value="front">前言</option><option value="back">附录</option></select></label></div><div className="flex flex-wrap items-center gap-3"><label className="flex min-w-0 items-center gap-2 text-xs text-neutral-500">上级<select aria-label={`章节 ${index + 1} 上级`} className="max-w-64 border bg-white px-2 py-1.5 text-sm" value={chapter.parentId ?? ""} onChange={e => update(index, { parentId: e.target.value || null })}><option value="">无上级</option>{chapters.slice(0, index).map(parent => <option value={parent.id} key={parent.id}>{parent.title}</option>)}</select></label><span className="text-xs text-neutral-500">{chapter.blockIds.length} 个正文块</span><button disabled={chapter.blockIds.length < 2} onClick={() => void openSplit(index)} className="ml-auto flex items-center gap-1 text-xs underline disabled:opacity-30"><Scissors className="h-3.5 w-3.5" />拆章</button><button disabled={index === chapters.length - 1} onClick={() => merge(index)} className="text-xs underline disabled:opacity-30">与下一章合并</button></div></div> : <div className="flex items-center gap-3" style={{ paddingLeft: chapter.parentId ? 20 : 0 }}><span className="w-7 shrink-0 text-xs text-neutral-400">{index + 1}</span><span className="flex-1 break-words font-serif text-lg">{chapter.title}</span><span className="text-xs text-neutral-500">{chapter.role === "front" ? "前言" : chapter.role === "back" ? "附录" : "正文"}</span><ChevronRight className="h-4 w-4" /></div>}
      </li>)}</ol>
      {editing && <div className="mt-6 flex flex-wrap gap-3"><button disabled={busy} onClick={() => void save(false)} className="inline-flex items-center gap-2 border px-4 py-2 text-sm"><Save className="h-4 w-4" />保存目录草稿</button><button disabled={busy || !chapters.length} onClick={() => void save(true)} className="ink-button px-4 py-2 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}确认目录，开始阅读</button></div>}
    </section>
    {classrooms.length > 0 && <section className="mt-12 border-t-2 border-neutral-900 pt-6"><h2 className="text-xl font-semibold">继续阅读</h2><div className="mt-4 divide-y divide-neutral-200">{classrooms.map(session => <Link key={session.id} className="flex items-center justify-between gap-3 py-4 text-sm" href={`/book-classroom/${session.id}`}><span>{tutors.find(t => t.id === session.tutorId)?.name ?? "导师"} · {session.versionId === material.book.currentVersionId ? "当前版本" : "历史版本"}</span><span className="inline-flex items-center gap-2 text-neutral-500">{session.status === "completed" ? "回看课堂" : "继续阅读"}<ChevronRight className="h-4 w-4" /></span></Link>)}</div></section>}
    {splitIndex !== null && <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"><section role="dialog" aria-modal="true" aria-label="拆分章节" className="w-full max-w-2xl space-y-4 bg-white p-5"><h2 className="text-xl font-semibold">拆分章节</h2>{previewBusy ? <p role="status">正在读取原文…</p> : <><label className="block text-sm">新章标题<input value={splitTitle} onChange={e => setSplitTitle(e.target.value)} className={`${input} mt-2`} /></label><label className="block text-sm">新章从这里开始<select aria-label="拆章原文位置" value={splitAt} onChange={e => setSplitAt(e.target.value)} className={`${input} mt-2`}>{preview?.blocks.slice(1).map((block, index) => <option value={block.id} key={block.id}>{index + 2} · {(block.anchorText || block.alt || "插图").slice(0, 90)}</option>)}</select></label><p className="max-h-40 overflow-y-auto border-l-2 border-neutral-300 pl-3 text-sm leading-7">{preview?.blocks.find(block => block.id === splitAt)?.anchorText}</p></>}<div className="flex justify-end gap-3"><button className="border px-4 py-2 text-sm" onClick={() => setSplitIndex(null)}>取消</button><button className="ink-button px-4 py-2 disabled:opacity-40" disabled={previewBusy || !splitAt || !splitTitle.trim()} onClick={split}>拆成两章</button></div></section></div>}
  </main>;
}
