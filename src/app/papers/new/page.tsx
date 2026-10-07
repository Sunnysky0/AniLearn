"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, FileUp, Loader2, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { fileToJpegDataUrl, pdfToImages } from "@/lib/client/media";
import { MAX_PAPER_PAGES, SUBJECTS } from "@/lib/types";

interface PageItem {
  id: string;
  dataUrl: string;
  name: string;
}

const MAX_PAGES = MAX_PAPER_PAGES;
const rid = () => Math.random().toString(36).slice(2, 10);

export default function NewPaperPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("数学");
  const [processing, setProcessing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function addFiles(list: FileList | File[]) {
    setError(null);
    const files = Array.from(list);
    try {
      for (const f of files) {
        const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          setProcessing(`正在读取 PDF：${f.name}`);
          const imgs = await pdfToImages(f, (d, t) => setProcessing(`正在渲染 ${f.name} · 第 ${d}/${t} 页`));
          setPages((p) => [...p, ...imgs.map((d, i) => ({ id: rid(), dataUrl: d, name: `${f.name} · P${i + 1}` }))]);
        } else if (f.type.startsWith("image/")) {
          setProcessing(`正在处理图片：${f.name}`);
          const d = await fileToJpegDataUrl(f, 2000, 0.86);
          setPages((p) => [...p, { id: rid(), dataUrl: d, name: f.name }]);
        } else {
          setError(`不支持的文件类型：${f.name}`);
        }
      }
      if (!title && files[0]) setTitle(files[0].name.replace(/\.[^.]+$/, "").slice(0, 60));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessing(null);
    }
  }

  function move(i: number, d: number) {
    setPages((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function submit() {
    if (!pages.length) return;
    setError(null);
    setUploading({ done: 0, total: pages.length });
    try {
      const r = await fetch("/api/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, subject }),
      });
      const paper = await r.json();
      if (!r.ok) throw new Error(paper.error || "创建试卷失败");
      for (let i = 0; i < pages.length; i++) {
        const pr = await fetch(`/api/papers/${paper.id}/pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl: pages[i].dataUrl }),
        });
        if (!pr.ok) {
          const j = await pr.json().catch(() => null);
          throw new Error(j?.error || `第 ${i + 1} 页上传失败`);
        }
        setUploading({ done: i + 1, total: pages.length });
      }
      router.push(`/papers/${paper.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUploading(null);
    }
  }

  const tooMany = pages.length > MAX_PAGES;

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <Link href="/papers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600">
          <ArrowLeft className="h-4 w-4" /> 返回试卷库
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">上传试卷</h1>
        <p className="mt-1 text-sm text-slate-500">
          支持试卷照片（JPG/PNG）和 PDF。AI 导师会逐题解析，标注关键点与教材知识点，然后开始一对一讲解。
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition ${
                dragOver ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/40"
              }`}
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-lg shadow-blue-500/30">
                <UploadCloud className="h-8 w-8" />
              </div>
              <div className="mt-4 text-lg font-semibold text-slate-800">拖拽文件到这里，或点击选择</div>
              <div className="mt-1 text-sm text-slate-500">可多选；PDF 会自动拆分为页面（最多 {MAX_PAGES} 页）</div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*,application/pdf,.pdf"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {processing && (
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
                <Loader2 className="h-4 w-4 animate-spin" /> {processing}
              </div>
            )}

            {pages.length > 0 && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between text-sm">
                  <span className="font-semibold text-slate-700">已添加 {pages.length} 页</span>
                  <button onClick={() => setPages([])} className="text-slate-400 hover:text-rose-500">
                    清空
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                  {pages.map((p, i) => (
                    <div key={p.id} className="group relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.dataUrl} alt={p.name} className="aspect-[3/4] w-full object-cover object-top" />
                      <span className="absolute left-2 top-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-bold text-white">
                        {i + 1}
                      </span>
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
                        <div className="flex gap-1">
                          <button onClick={() => move(i, -1)} className="rounded bg-white/90 p-1 text-slate-700" title="前移">
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button onClick={() => move(i, 1)} className="rounded bg-white/90 p-1 text-slate-700" title="后移">
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                        <button
                          onClick={() => setPages((ps) => ps.filter((x) => x.id !== p.id))}
                          className="rounded bg-white/90 p-1 text-rose-600"
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="h-fit space-y-5 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70 lg:sticky lg:top-24">
            <div>
              <label className="text-sm font-semibold text-slate-700">试卷名称</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：2024 新高考 I 卷 数学（可留空，AI 自动识别）"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
              />
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700">学科</label>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {SUBJECTS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSubject(s)}
                    className={`rounded-lg py-2 text-sm transition ${
                      subject === s ? "bg-blue-600 font-semibold text-white shadow" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {tooMany && (
              <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-700">
                页数较多（{pages.length} 页），建议拆分为多份试卷上传，单份不超过 {MAX_PAGES} 页解析效果最佳。
              </div>
            )}
            {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-600">{error}</div>}
            <button
              onClick={submit}
              disabled={!pages.length || !!uploading || !!processing || tooMany}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 py-3 font-semibold text-white shadow-lg shadow-blue-500/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> 上传中 {uploading.done}/{uploading.total}
                </>
              ) : (
                <>
                  <Sparkles className="h-5 w-5" /> 上传并开始 AI 解析
                </>
              )}
            </button>
            <div className="space-y-1.5 text-xs leading-relaxed text-slate-400">
              <p className="flex gap-1.5">
                <FileUp className="h-3.5 w-3.5 shrink-0" /> 拍照时尽量保持试卷平整、光线均匀，文字清晰。
              </p>
              <p>· 如果试卷上有你的作答或老师批改痕迹，AI 也会识别并在讲解时参考。</p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
