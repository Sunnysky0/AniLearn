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
import { PaperPageThumbnail } from "@/components/PaperPageThumbnail";
import { PaperSourcePreview } from "@/components/PaperSourcePreview";
import { PAPER_STATUS } from "@/components/PaperCard";
import { difficultyStars, formatDate, strategyLabel } from "@/lib/text";
import type { AnalysisEvent, PaperDTO, ProblemDTO, TutorDTO } from "@/lib/types";
import { DEFAULT_PACE, type TeachingPace } from "@/lib/types";
import PacePicker from "@/components/PacePicker";

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
  const [pace, setPace] = useState<TeachingPace>(props.paper.pace ?? DEFAULT_PACE);
  const [learningRequest, setLearningRequest] = useState("");
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restart, pace }),
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
          if (ev.type === "paper" || ev.type === "done") setPaper((p) => ({ ...ev.paper, pageMimes: ev.paper.pageMimes ?? p.pageMimes }));
          else if (ev.type === "status") setPaper((p) => ({ ...p, status: ev.status }));
          else if (ev.type === "problem") setProblems((ps) => [...ps, ev.problem]);
          else if (ev.type === "progress") setChars(ev.chars);
          else if (ev.type === "inventory") setPaper((p) => ({ ...p, inventory: ev.inventory, analysisPlan: ev.plan }));
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
        body: JSON.stringify({ paperId: paper.id, tutorId, pace, request: learningRequest }),
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
      <Link href="/papers" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800">
        <ArrowLeft className="h-4 w-4" /> 试卷库
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[32px] font-bold text-neutral-900">{paper.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <span className="bg-neutral-100 px-2 py-0.5 text-neutral-800">{paper.subject}</span>
            <span>已解析 {problems.filter((p) => p.analysis !== "unparsed").length} / {paper.inventory?.items.length ?? problems.length} 题</span>
            <span className={` px-2.5 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
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
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <Trash2 className="h-4 w-4" /> 删除
          </button>
          <button
            onClick={() => void analyze(paper.status === "ready")}
            disabled={running}
            className="inline-flex items-center gap-1.5 bg-white px-4 py-2 text-sm font-medium text-neutral-700 border border-neutral-200 hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
            {paper.status === "uploaded" ? "开始解析" : paper.status === "ready" ? "重新解析" : "继续解析"}
          </button>
          {paper.status === "failed" && (
            <button
              onClick={() => void analyze(true)}
              disabled={running}
              title="从头重新解析"
              className="p-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
            >
              <ScanSearch className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => setPicker(true)}
            disabled={!problems.length || running || paper.status !== "ready" || !!paper.error}
            className="inline-flex items-center gap-2 bg-neutral-900 px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GraduationCap className="h-4 w-4" /> 开始一对一学习
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 flex flex-wrap items-center gap-3 border border-neutral-200 bg-neutral-100 p-4 text-sm text-neutral-800">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div className="min-w-[200px] flex-1 break-all">{error}</div>
          {needsKey && (
            <Link href="/settings" className="bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white">
              前往设置
            </Link>
          )}
        </div>
      )}
      {!props.llmReady && paper.status === "uploaded" && !error && (
        <div className="mt-5 flex items-center gap-3 border border-neutral-200 bg-neutral-100 p-4 text-sm text-neutral-800">
          <KeyRound className="h-5 w-5" /> 尚未配置 AI 模型 API Key，配置后即可开始解析。
          <Link href="/settings" className="ml-auto bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white">
            前往设置
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[250px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:h-[calc(100vh-7rem)] lg:overflow-y-auto thin-scroll">
          {problems.length > 0 && (
            <nav aria-label="试卷题目目录" className="mb-6 border-t-2 border-neutral-900 pt-4">
              <h2 className="mb-3 text-lg font-semibold">题目目录</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">
                {problems.map((p) => (
                  <a
                    key={p.id}
                    href={`#problem-${p.id}`}
                    className="border-b border-neutral-300 py-2 text-sm hover:bg-neutral-100"
                  >
                    第 {p.number} 题 <span className="text-neutral-500">{p.title}</span>
                  </a>
                ))}
              </div>
            </nav>
          )}
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
            {pages.map((i) => (
              <button
                key={i}
                onClick={() => setPreview(i)}
                className="relative overflow-hidden bg-white text-left border border-neutral-200 transition hover:border-neutral-900"
              >
                <PaperPageThumbnail
                  src={`/api/papers/${paper.id}/pages/${i}`}
                  mime={paper.pageMimes?.[i]}
                  alt={`第 ${i + 1} 页`}
                  className="aspect-[3/4] w-full object-cover object-top"
                />
                <span className="absolute left-2 top-2 bg-neutral-900/70 px-2 py-0.5 text-xs text-white">
                  第 {i + 1} 页
                </span>
                {(running || analyzing) && (
                  <div className="pointer-events-none absolute inset-0 bg-neutral-900/5">
                    <div className="scan absolute inset-x-0 h-1 bg-neutral-900" />
                  </div>
                )}
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0 space-y-4">
          {paper.analysisPlan && <div className="border-t-2 border-neutral-900 py-5"><h2 className="font-semibold">初始学习计划</h2><div className="mt-3 divide-y divide-neutral-200">{paper.analysisPlan.units.map((unit) => <div key={unit.idx} className="py-3"><div className="text-sm font-semibold">第 {problems[unit.idx]?.number ?? unit.idx + 1} 题{unit.related.length > 0 && <span className="ml-2 font-normal text-neutral-500">关联：{unit.related.map((idx) => `第${problems[idx]?.number ?? idx + 1}题`).join("、")}</span>}</div><p className="mt-1 text-xs text-neutral-500">{unit.reason}</p><ul className="mt-2 list-inside list-disc text-sm">{unit.goals.map((goal) => <li key={goal.id}>{goal.description}</li>)}</ul></div>)}</div></div>}
          {(running || analyzing) && (
            <div className="flex items-center gap-4 bg-neutral-900 p-5 text-white">
              <div className="flex h-12 w-12 items-center justify-center bg-white/10">
                <ScanSearch className="h-6 w-6 animate-pulse" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">AI 正在解析计划选中的题目…</div>
                <div className="mt-0.5 text-sm text-neutral-200/80">
                  已识别 {problems.length} 道题{chars ? ` · 已生成 ${chars.toLocaleString()} 字` : ""} ·
                  识别题目、标注关键点与教材知识点
                </div>
              </div>
              <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
            </div>
          )}

          {paper.overview && (
            <div className="border-t-2 border-neutral-900 py-6">
              <div className="mb-3 flex items-center gap-2 font-bold text-neutral-800">
                <BookMarked className="h-5 w-5 text-neutral-800" /> 试卷整体分析
              </div>
              <Markdown className="md text-base text-neutral-700" content={paper.overview} />
            </div>
          )}

          {props.sessions.length > 0 && (
            <div className="bg-white p-5 border border-neutral-200/70">
              <div className="mb-3 font-bold text-neutral-800">课堂记录</div>
              <div className="flex flex-wrap gap-3">
                {props.sessions.map((s) => (
                  <Link
                    key={s.id}
                    href={`/classroom/${s.id}`}
                    className="flex items-center gap-3 bg-neutral-50 px-3 py-2 text-sm border border-neutral-200 hover:bg-neutral-100 hover:border-neutral-300"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.tutorAvatar} alt="" className="h-8 w-8 object-cover" />
                    <div>
                      <div className="font-medium text-neutral-700">导师 {s.tutorName}</div>
                      <div className="text-xs text-neutral-500">
                        {s.status === "completed" ? "已完成" : `进行到第 ${s.currentIdx + 1} 题`} ·{" "}
                        {formatDate(s.updatedAt).slice(5)}
                      </div>
                    </div>
                    <Play className="h-4 w-4 text-neutral-800" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {problems.map((p) => (
            <article
              id={`problem-${p.id}`}
              key={p.id}
              className="fade-up scroll-mt-32 border-t-2 border-neutral-900 py-6"
            >
              <header className="flex flex-wrap items-center gap-2">
                <span className="bg-neutral-900 px-2.5 py-1 text-sm font-bold text-white">第 {p.number} 题</span>
                {p.type && <span className="bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{p.type}</span>}
                <span className="font-semibold text-neutral-800">{p.title}</span>
                <span className="ml-auto text-sm text-neutral-800" title={`难度 ${p.difficulty}/5`}>
                  {difficultyStars(p.difficulty)}
                </span>
                <span
                  className={` px-2.5 py-0.5 text-xs font-medium ${
                    p.strategy === "student_first" ? "bg-neutral-100 text-neutral-800" : "bg-neutral-900 text-white"
                  }`}
                >
                  {strategyLabel(p.strategy)}
                </span>
              </header>
              <div className="mt-3 text-base text-neutral-700">
                <Markdown className="md" content={p.content} />
              </div>
              {p.keyPoints.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-neutral-800">
                    <Lightbulb className="h-3.5 w-3.5" /> 解题关键点
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.keyPoints.map((k, i) => (
                      <span
                        key={i}
                        className="bg-neutral-100 px-2.5 py-1 text-xs text-neutral-800 border border-neutral-200/70"
                      >
                        <Markdown className="md" content={k} />
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {p.knowledgePoints.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-neutral-800">
                    <BookMarked className="h-3.5 w-3.5" /> 关联教材知识点
                  </div>
                  <ul className="space-y-1.5">
                    {p.knowledgePoints.map((k, i) => (
                      <li key={i} className="bg-neutral-100/60 px-3 py-2 text-sm text-neutral-700">
                        <span className="font-semibold text-neutral-800">{k.name}</span>
                        {k.source && <span className="ml-2 text-xs text-neutral-500">{k.source}</span>}
                        {k.detail && <div className="mt-0.5 text-xs text-neutral-500">{k.detail}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.analysis === "unparsed" && <p className="mt-3 text-sm text-neutral-500">未深入解析 · 未纳入初始讲解范围</p>}
              <button
                onClick={() => toggle(p.id)}
                disabled={p.analysis === "unparsed"}
                className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-neutral-800 hover:text-neutral-800"
              >
                {open.has(p.id) ? "收起答案与解析" : "查看答案与解析"}
                <ChevronDown className={`h-4 w-4 transition ${open.has(p.id) ? "rotate-180" : ""}`} />
              </button>
              {open.has(p.id) && (
                <div className="mt-3 space-y-3 bg-neutral-50 p-4 text-sm text-neutral-700">
                  <div>
                    <span className="font-semibold text-neutral-800">答案：</span>
                    <Markdown className="md inline-block align-top" content={p.answer || "—"} />
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-neutral-800">详细解析</div>
                    <Markdown className="md" content={p.solution || "—"} />
                  </div>
                  {p.skills.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Wrench className="h-4 w-4 text-neutral-500" />
                      {p.skills.map((s, i) => (
                        <span key={i} className="bg-white px-2 py-0.5 text-xs border border-neutral-200">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.strategyReason && (
                    <div className="text-xs text-neutral-500">
                      教学策略（{strategyLabel(p.strategy)}）：{p.strategyReason}
                    </div>
                  )}
                  {p.studentWork && (
                    <div className="bg-neutral-100 p-2 text-xs text-neutral-800">学生作答：{p.studentWork}</div>
                  )}
                </div>
              )}
            </article>
          ))}

          {!problems.length && !running && !analyzing && (
            <div className="border-2 border-dashed border-neutral-300 bg-white/60 p-10 text-center text-neutral-500">
              {paper.status === "failed"
                ? "解析失败，请检查模型设置后点击「重新解析」。"
                : "尚未解析。点击右上角「开始解析」。"}
            </div>
          )}
        </section>
      </div>

      {picker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4"
          onClick={() => setPicker(false)}
        >
          <div className="w-full max-w-3xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-neutral-900">选择你的 AI 导师</h3>
                <p className="text-sm text-neutral-500">选择本次学习的导师与目标。</p>
              </div>
              <button onClick={() => setPicker(false)} className="p-2 text-neutral-500 hover:bg-neutral-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4"><PacePicker value={pace} onChange={setPace} disabled={creating} /></div>
            <label className="mt-3 block text-sm">学习需求<textarea aria-label="开课学习需求" value={learningRequest} onChange={(e) => setLearningRequest(e.target.value)} maxLength={2000} disabled={creating} className="mt-1 min-h-20 w-full border border-neutral-300 p-2" /></label>
            <div className="mt-5 grid max-h-[55vh] gap-3 overflow-y-auto thin-scroll sm:grid-cols-2">
              {props.tutors.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTutorId(t.id)}
                  className={`flex gap-3  p-3 text-left border-2 transition ${
                    tutorId === t.id
                      ? "bg-neutral-100 border-neutral-900"
                      : "bg-neutral-50 border-transparent hover:border-neutral-200"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.avatar} alt={t.name} className="h-16 w-16 shrink-0 object-cover" />
                  <div className="min-w-0">
                    <div className="font-bold text-neutral-800">AI导师 · {t.name}</div>
                    <div className="text-xs text-neutral-800">{t.tags.join(" | ")}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-neutral-500">{t.tagline || t.personality}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <Link href="/tutors/new" className="text-sm text-neutral-800 hover:underline">
                + 创建新导师
              </Link>
              <button
                onClick={startClass}
                disabled={creating || !tutorId}
                className="inline-flex items-center gap-2 bg-neutral-900 px-6 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} 进入教室
              </button>
            </div>
          </div>
        </div>
      )}

      {preview !== null && (
        <PaperSourcePreview
          key={`${paper.id}-${preview}`}
          src={`/api/papers/${paper.id}/pages/${preview}`}
          mime={paper.pageMimes?.[preview]}
          page={preview + 1}
          onClose={() => setPreview(null)}
        />
      )}
    </main>
  );
}
