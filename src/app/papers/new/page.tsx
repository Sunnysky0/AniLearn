"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, FileUp, Loader2, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { MaterialImportTools } from "@/components/MaterialImportTools";
import { fileToJpegDataUrl, fileToPaperText, pdfToImages } from "@/lib/client/media";
import { paperTextFormat } from "@/lib/paper-source";
import { MAX_PAPER_PAGES, SUBJECTS } from "@/lib/types";
import { DEFAULT_PACE, type TeachingPace } from "@/lib/types";
import PacePicker from "@/components/PacePicker";

interface PageItem {
  id: string;
  dataUrl: string;
  name: string;
  mime: string;
  text?: string;
}

const MAX_PAGES = MAX_PAPER_PAGES;
const rid = () => Math.random().toString(36).slice(2, 10);

export default function NewPaperPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("数学");
  const [pace, setPace] = useState<TeachingPace>(DEFAULT_PACE);
  const [learningRequest, setLearningRequest] = useState("");
  const [processing, setProcessing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function importFiles(list: FileList | File[]) {
    if (adding.current || uploading) return;
    adding.current = true;
    setError(null);
    const files = Array.from(list);
    const added: PageItem[] = [];
    try {
      for (const f of files) {
        const remaining = MAX_PAGES - pages.length - added.length;
        if (remaining <= 0) throw new Error(`单份试卷最多 ${MAX_PAGES} 页，请移除已有页面后再导入。`);
        const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          setProcessing(`正在读取 PDF：${f.name}`);
          const pageLimit = remaining === MAX_PAGES ? `单份试卷最多 ${MAX_PAGES} 页` : `试卷还可添加 ${remaining} 页（单份最多 ${MAX_PAGES} 页）`;
          const imgs = await pdfToImages(f, (d, t) => setProcessing(`正在渲染 ${f.name} · 第 ${d}/${t} 页`), remaining, pageLimit);
          added.push(...imgs.map((dataUrl, i) => ({ id: rid(), dataUrl, name: `${f.name} · P${i + 1}`, mime: "image/jpeg" })));
        } else if (f.type.startsWith("image/")) {
          setProcessing(`正在处理图片：${f.name}`);
          const dataUrl = await fileToJpegDataUrl(f, 2000, 0.86);
          added.push({ id: rid(), dataUrl, name: f.name, mime: "image/jpeg" });
        } else if (/\.(md|markdown|tex)$/i.test(f.name)) {
          setProcessing(`正在读取文本：${f.name}`);
          const source = await fileToPaperText(f);
          added.push({ id: rid(), name: f.name, ...source });
        } else {
          throw new Error(`不支持的文件类型：${f.name}`);
        }
      }
      if (pages.length + added.length > MAX_PAGES) throw new Error(`单份试卷最多 ${MAX_PAGES} 页，请移除已有页面后再导入。`);
      setPages((current) => [...current, ...added]);
      if (files[0]) setTitle((current) => current.trim() ? current : files[0].name.replace(/\.[^.]+$/, "").slice(0, 60));
    } finally {
      adding.current = false;
      setProcessing(null);
    }
  }

  function addFiles(list: FileList | File[]) {
    void importFiles(list).catch((error) => setError(error instanceof Error ? error.message : String(error)));
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
    if (!pages.length || adding.current || processing) return;
    setError(null);
    setUploading({ done: 0, total: pages.length });
    try {
      const r = await fetch("/api/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, subject, pace, request: learningRequest }),
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
        <Link href="/papers" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800">
          <ArrowLeft className="h-4 w-4" /> 返回试卷库
        </Link>
        <h1 className="mt-2 text-[32px] font-bold text-neutral-900">上传试卷</h1>
        <p className="mt-1 text-sm text-neutral-500">图片 / PDF / .md / .tex · 每份最多 {MAX_PAGES} 页</p>

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
              role="button"
              tabIndex={0}
              aria-label="选择试卷图片、PDF、Markdown 或 LaTeX 试卷"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              className={`flex cursor-pointer flex-col items-center justify-center  border-2 border-dashed px-6 py-14 text-center transition ${
                dragOver
                  ? "border-neutral-900 bg-neutral-100"
                  : "border-neutral-300 bg-white hover:border-neutral-900 hover:bg-neutral-100/40"
              }`}
            >
              <div className="flex h-16 w-16 items-center justify-center bg-neutral-900 text-white">
                <UploadCloud className="h-8 w-8" />
              </div>
              <div className="mt-4 text-lg font-semibold text-neutral-800">拖拽文件到这里，或点击选择</div>
              <div className="mt-1 text-sm text-neutral-500">支持图片、PDF、Markdown、LaTeX；文本文件按一页处理</div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*,application/pdf,.pdf,.md,.markdown,.tex,text/markdown,text/x-tex,application/x-tex"
                multiple
                disabled={!!processing || !!uploading}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {processing && (
              <div className="mt-4 flex items-center gap-2 bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
                <Loader2 className="h-4 w-4 animate-spin" /> {processing}
              </div>
            )}

            <MaterialImportTools pageCount={pages.length} disabled={!!processing || !!uploading} onFiles={importFiles} />

            {pages.length > 0 && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between text-sm">
                  <span className="font-semibold text-neutral-700">已添加 {pages.length} 页</span>
                  <button onClick={() => setPages([])} disabled={!!uploading || !!processing} className="text-neutral-500 hover:text-neutral-800 disabled:opacity-30">
                    清空
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                  {pages.map((p, i) => (
                    <div key={p.id} className="group relative overflow-hidden bg-white border border-neutral-200">
                      {p.mime.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.dataUrl} alt={p.name} className="aspect-[3/4] w-full object-cover object-top" />
                      ) : (
                        <div className="aspect-[3/4] w-full overflow-hidden bg-neutral-50 p-3 pt-10 text-left text-xs text-neutral-700">
                          <div className="mb-2 font-semibold text-neutral-900">{paperTextFormat(p.mime)}</div>
                          <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">{p.text?.slice(0, 1200)}</pre>
                        </div>
                      )}
                      <span className="absolute left-2 top-2 bg-neutral-900 px-2 py-0.5 text-xs font-bold text-white">
                        {i + 1}
                      </span>
                      <div title={p.name} className="truncate border-t border-neutral-200 px-2 py-1.5 text-xs text-neutral-500">{p.name}</div>
                      <div className="flex items-center justify-between border-t border-neutral-300 bg-white p-2">
                        <div className="flex gap-1">
                          <button
                            onClick={() => move(i, -1)}
                            disabled={i === 0 || !!uploading || !!processing}
                            className="p-1 text-neutral-900 disabled:opacity-30"
                            title="前移"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => move(i, 1)}
                            disabled={i === pages.length - 1 || !!uploading || !!processing}
                            className="p-1 text-neutral-900 disabled:opacity-30"
                            title="后移"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                        <button
                          onClick={() => setPages((ps) => ps.filter((x) => x.id !== p.id))}
                          disabled={!!uploading || !!processing}
                          className="bg-white/90 p-1 text-neutral-800"
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

          <aside className="h-fit space-y-5 border-t-2 border-neutral-900 py-6 lg:sticky lg:top-24">
            <div><label className="mb-2 block text-sm font-semibold">讲解档位</label><PacePicker value={pace} onChange={setPace} /></div>
            <label className="block text-sm font-semibold">学习需求<textarea aria-label="学习需求" value={learningRequest} onChange={(e) => setLearningRequest(e.target.value)} maxLength={2000} className="mt-2 min-h-24 w-full border border-neutral-300 bg-white p-3 text-sm font-normal" /></label>
            <div>
              <label htmlFor="paper-title" className="text-sm font-semibold text-neutral-700">
                试卷名称
              </label>
              <input
                id="paper-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：2024 新高考 I 卷 数学（可留空，AI 自动识别）"
                className="mt-2 w-full border border-neutral-200 px-3.5 py-2.5 text-sm outline-none"
              />
            </div>
            <div>
              <label className="text-sm font-semibold text-neutral-700">学科</label>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {SUBJECTS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSubject(s)}
                    aria-pressed={subject === s}
                    className={` py-2 text-sm transition ${
                      subject === s
                        ? "bg-neutral-900 font-semibold text-white "
                        : "bg-neutral-50 text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {tooMany && (
              <div className="bg-neutral-100 p-3 text-xs text-neutral-800">
                页数较多（{pages.length} 页），建议拆分为多份试卷上传，单份不超过 {MAX_PAGES} 页解析效果最佳。
              </div>
            )}
            {error && <div className="bg-neutral-100 p-3 text-sm text-neutral-800">{error}</div>}
            <button
              onClick={submit}
              disabled={!pages.length || !!uploading || !!processing || tooMany}
              className="flex w-full items-center justify-center gap-2 bg-neutral-900 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
            <div className="space-y-1.5 text-xs leading-relaxed text-neutral-500">
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
