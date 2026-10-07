"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  BookMarked,
  ChevronDown,
  GraduationCap,
  KeyRound,
  Lightbulb,
  Loader2,
  Play,
  RefreshCw,
  ScanSearch,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { PAPER_STATUS } from "@/components/PaperCard";
import { difficultyStars, formatDate, strategyLabel } from "@/lib/text";
import type { AnalysisEvent, PaperDTO, ProblemDTO, TutorDTO } from "@/lib/types";

interface SessionLite {
  id: number;
  currentIdx: number;
  status: string;
  updatedAt: string;
  tutorName: string;
  tutorAvatar: string;
}

interface Props {
  paper: PaperDTO;
  problems: ProblemDTO[];
  tutors: TutorDTO[];
  sessions: SessionLite[];
  llmReady: boolean;
}

export default function PaperView(props: Props) {
  const router = useRouter();
  const [paper, setPaper] = useState(props.paper);
  const [problems, setProblems] = useState(props.problems);
  const [running, setRunning] = useState(false);
  const [chars, setChars] = useState(0);
  const [error, setError] = useState<string | null>(props.paper.error);
  const [picker, setPicker] = useState(false);
  const [tutorId, setTutorId] = useState(props.tutors[0]?.id ?? 0);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<number | null>(null);
  const started = useRef(false);

  async function refresh() {
    const r = await fetch(`/api/papers/${paper.id}`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json()) as { paper: PaperDTO; problems: ProblemDTO[] };
      setPaper(j.paper);
      setProblems(j.problems);
      return j.paper;
    }
    return null;
  }

  async function analyze(restart = false) {
    setRunning(true);
    setError(null);
    setChars(0);
    setProblems([]);
    setPaper((p) => ({ ...p, status: "analyzing" }));
    try {
      const res = await fetch(`/api/papers/${paper.id}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ restart }),
      });
      if (res.status === 409) return; // already running elsewhere – polling takes over
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `解析请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AnalysisEvent;
          if (ev.type === "paper" || ev.type === "done") setPaper(ev.paper);
          else if (ev.type === "status") setPaper((p) => ({ ...p, status: ev.status }));
          else if (ev.type === "problem") setProblems((ps) => [...ps, ev.problem]);
          else if (ev.type === "progress") setChars(ev.chars);
          else if (ev.type === "error") setError(ev.error);
        }
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (props.paper.status === "uploaded" && props.llmReady && !started.current) {
      started.current = true;
      void analyze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll when the analysis runs in the background (e.g. page was reloaded).
  useEffect(() => {
    if (paper.status !== "analyzing" || running) return;
    const t = setInterval(() => {
      void refresh().then((p) => {
        if (p?.error) setError(p.error);
      });
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.status, running]);

  async function startClass() {
    if (!tutorId) return;
    setCreating(true);
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperId: paper.id, tutorId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "创建课堂失败");
      router.push(`/classroom/${j.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
      setPicker(false);
    }
  }

  async function remove() {
    if (!confirm("确定删除这份试卷吗？相关的课堂记录也会被删除。")) return;
    const res = await fetch(`/api/papers/${paper.id}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json().catch(() => null);
      setError(result?.error || "删除试卷失败，请重试。");
      return;
    }
    router.push("/papers");
    router.refresh();
  }

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const st = PAPER_STATUS[paper.status] ?? PAPER_STATUS.uploaded;
  const analyzing = paper.status === "analyzing";
  const pages = Array.from({ length: paper.pageCount }, (_, i) => i);
  const needsKey = !!error && /API Key/i.test(error);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Link href="/papers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600">
        <ArrowLeft className="h-4 w-4" /> 试卷库
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">{paper.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span className="rounded-md bg-blue-50 px-2 py-0.5 text-blue-600">{paper.subject}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
            <span>{paper.pageCount} 页</span>
            <span>·</span>
            <span>{problems.length} 道题</span>
            <span>·</span>
            <span>{formatDate(paper.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={remove}
            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-slate-500 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" /> 删除
          </button>
          <button
            onClick={() => void analyze(paper.status === "ready")}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
            {paper.status === "uploaded" ? "开始解析" : paper.status === "ready" ? "重新解析" : "继续解析"}
          </button>
          {paper.status === "failed" && (
            <button onClick={() => void analyze(true)} disabled={running} title="从头重新解析"
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
              <ScanSearch className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => setPicker(true)}
            disabled={!problems.length || running || paper.status !== "ready" || !!paper.error}
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-blue-500/30 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GraduationCap className="h-4 w-4" /> 开始一对一学习
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div className="min-w-[200px] flex-1 break-all">{error}</div>
          {needsKey && (
            <Link href="/settings" className="rounded-full bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white">
              前往设置
            </Link>
          )}
        </div>
      )}
      {!props.llmReady && paper.status === "uploaded" && !error && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <KeyRound className="h-5 w-5" /> 尚未配置 AI 模型 API Key，配置后即可开始解析。
          <Link href="/settings" className="ml-auto rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white">
            前往设置
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[250px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:h-[calc(100vh-7rem)] lg:overflow-y-auto thin-scroll">
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
            {pages.map((i) => (
              <button
                key={i}
                onClick={() => setPreview(i)}
                className="relative overflow-hidden rounded-xl bg-white text-left shadow-sm ring-1 ring-slate-200 transition hover:ring-blue-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/papers/${paper.id}/pages/${i}`} alt={`第 ${i + 1} 页`} className="w-full object-cover" />
                <span className="absolute left-2 top-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-xs text-white">
                  第 {i + 1} 页
                </span>
                {(running || analyzing) && (
                  <div className="pointer-events-none absolute inset-0 bg-blue-500/5">
                    <div className="scan absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-sky-400 to-transparent shadow-[0_0_14px_rgba(56,189,248,.9)]" />
                  </div>
                )}
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0 space-y-4">
          {(running || analyzing) && (
            <div className="flex items-center gap-4 rounded-2xl bg-gradient-to-r from-[#13254d] to-[#1e40af] p-5 text-white shadow-lg">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/10">
                <ScanSearch className="h-6 w-6 animate-pulse" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">AI 正在逐题解析试卷…</div>
                <div className="mt-0.5 text-sm text-blue-100/80">
                  已识别 {problems.length} 道题{chars ? ` · 已生成 ${chars.toLocaleString()} 字` : ""} · 识别题目、标注关键点与教材知识点
                </div>
              </div>
              <Loader2 className="h-6 w-6 animate-spin text-sky-300" />
            </div>
          )}

          {paper.overview && (
            <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70">
              <div className="mb-3 flex items-center gap-2 font-bold text-slate-800">
                <BookMarked className="h-5 w-5 text-blue-600" /> 试卷整体分析
              </div>
              <Markdown className="md text-[15px] text-slate-700" content={paper.overview} />
            </div>
          )}

          {props.sessions.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
              <div className="mb-3 font-bold text-slate-800">课堂记录</div>
              <div className="flex flex-wrap gap-3">
                {props.sessions.map((s) => (
                  <Link
                    key={s.id}
                    href={`/classroom/${s.id}`}
                    className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 hover:bg-blue-50 hover:ring-blue-300"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.tutorAvatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                    <div>
                      <div className="font-medium text-slate-700">导师 {s.tutorName}</div>
                      <div className="text-xs text-slate-400">
                        {s.status === "completed" ? "已完成" : `进行到第 ${s.currentIdx + 1} 题`} · {formatDate(s.updatedAt).slice(5)}
                      </div>
                    </div>
                    <Play className="h-4 w-4 text-blue-500" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {problems.map((p) => (
            <article key={p.id} className="fade-up rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
              <header className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-blue-600 px-2.5 py-1 text-sm font-bold text-white">第 {p.number} 题</span>
                {p.type && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.type}</span>}
                <span className="font-semibold text-slate-800">{p.title}</span>
                <span className="ml-auto text-sm tracking-tight text-amber-500" title={`难度 ${p.difficulty}/5`}>
                  {difficultyStars(p.difficulty)}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    p.strategy === "student_first" ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"
                  }`}
                >
                  {strategyLabel(p.strategy)}
                </span>
              </header>
              <div className="mt-3 text-[15px] text-slate-700">
                <Markdown className="md" content={p.content} />
              </div>
              {p.keyPoints.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-600">
                    <Lightbulb className="h-3.5 w-3.5" /> 解题关键点
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.keyPoints.map((k, i) => (
                      <span key={i} className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs text-amber-800 ring-1 ring-amber-200/70">
                        <Markdown className="md" content={k} />
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {p.knowledgePoints.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-blue-600">
                    <BookMarked className="h-3.5 w-3.5" /> 关联教材知识点
                  </div>
                  <ul className="space-y-1.5">
                    {p.knowledgePoints.map((k, i) => (
                      <li key={i} className="rounded-lg bg-blue-50/60 px-3 py-2 text-sm text-slate-700">
                        <span className="font-semibold text-blue-700">{k.name}</span>
                        {k.source && <span className="ml-2 text-xs text-slate-500">📖 {k.source}</span>}
                        {k.detail && <div className="mt-0.5 text-xs text-slate-500">{k.detail}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                onClick={() => toggle(p.id)}
                className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                {open.has(p.id) ? "收起答案与解析" : "查看答案与解析"}
                <ChevronDown className={`h-4 w-4 transition ${open.has(p.id) ? "rotate-180" : ""}`} />
              </button>
              {open.has(p.id) && (
                <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
                  <div>
                    <span className="font-semibold text-emerald-700">答案：</span>
                    <Markdown className="md inline-block align-top" content={p.answer || "—"} />
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-slate-800">详细解析</div>
                    <Markdown className="md" content={p.solution || "—"} />
                  </div>
                  {p.skills.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Wrench className="h-4 w-4 text-slate-400" />
                      {p.skills.map((s, i) => (
                        <span key={i} className="rounded-md bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.strategyReason && (
                    <div className="text-xs text-slate-500">
                      教学策略（{strategyLabel(p.strategy)}）：{p.strategyReason}
                    </div>
                  )}
                  {p.studentWork && <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">学生作答：{p.studentWork}</div>}
                </div>
              )}
            </article>
          ))}

          {!problems.length && !running && !analyzing && (
            <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 p-10 text-center text-slate-500">
              {paper.status === "failed" ? "解析失败，请检查模型设置后点击「重新解析」。" : "尚未解析。点击右上角「开始解析」。"}
            </div>
          )}
        </section>
      </div>

      {picker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={() => setPicker(false)}>
          <div className="w-full max-w-3xl rounded-3xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">选择你的 AI 导师</h3>
                <p className="text-sm text-slate-500">导师会以自己的性格与教学风格，陪你逐题讲透这张试卷。</p>
              </div>
              <button onClick={() => setPicker(false)} className="rounded-full p-2 text-slate-400 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-5 grid max-h-[55vh] gap-3 overflow-y-auto thin-scroll sm:grid-cols-2">
              {props.tutors.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTutorId(t.id)}
                  className={`flex gap-3 rounded-2xl p-3 text-left ring-2 transition ${
                    tutorId === t.id ? "bg-blue-50 ring-blue-500" : "bg-slate-50 ring-transparent hover:ring-slate-200"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.avatar} alt={t.name} className="h-16 w-16 shrink-0 rounded-full object-cover" />
                  <div className="min-w-0">
                    <div className="font-bold text-slate-800">AI导师 · {t.name}</div>
                    <div className="text-xs text-blue-600">{t.tags.join(" | ")}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-slate-500">{t.tagline || t.personality}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <Link href="/tutors/new" className="text-sm text-blue-600 hover:underline">
                + 创建新导师
              </Link>
              <button
                onClick={startClass}
                disabled={creating || !tutorId}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-6 py-2.5 font-semibold text-white shadow-md disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} 进入教室
              </button>
            </div>
          </div>
        </div>
      )}

      {preview !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4" onClick={() => setPreview(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/papers/${paper.id}/pages/${preview}`}
            alt=""
            className="max-h-[92vh] max-w-full rounded-xl bg-white shadow-2xl"
          />
        </div>
      )}
    </main>
  );
}
