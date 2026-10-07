"use client";

import { useEffect, useRef, useState } from "react";
import {
  BookMarked,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Lightbulb,
  Maximize2,
  Minimize2,
  NotebookPen,
  PenLine,
  Star,
  Wrench,
  X,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { difficultyStars, strategyLabel } from "@/lib/text";
import type { BoardDTO, ProblemDTO } from "@/lib/types";

export type BoardOverlay = "none" | "problem" | "keypoints";

interface Props {
  paperId: number;
  paperTitle: string;
  problems: ProblemDTO[];
  boards: Record<number, BoardDTO>;
  viewIdx: number;
  currentIdx: number;
  progress: Record<string, string>;
  freshBlocks: string[];
  overlay: BoardOverlay;
  onOverlay: (o: BoardOverlay) => void;
  onView: (i: number) => void;
  onExport: () => void;
}

function ToolBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition ${
        active ? "bg-white/20 text-white" : "hover:bg-white/10 hover:text-white"
      }`}
    >
      <Icon className={`h-4 w-4 ${label === "重点" ? "text-amber-300" : ""}`} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export default function Blackboard(props: Props) {
  const { problems, boards, viewIdx } = props;
  const problem = problems[viewIdx];
  const board = boards[viewIdx];
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [answerState, setAnswerState] = useState({ viewIdx, visible: false });

  // Reset before rendering a different problem so its answer stays hidden.
  if (answerState.viewIdx !== viewIdx) {
    setAnswerState({ viewIdx, visible: false });
  }
  const showAnswer = answerState.viewIdx === viewIdx && answerState.visible;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 820));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const blockCount = board?.blocks.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      if (wide) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
      else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [blockCount, viewIdx, wide]);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen?.();
  }

  const title =
    board?.title ||
    (problem ? `第${problem.number}题${problem.title ? ` · ${problem.title}` : ""}` : props.paperTitle);

  return (
    <div ref={wrapRef} className="board-frame flex h-full flex-col rounded-2xl p-2.5 pb-0">
      <div className="chalkboard relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          <div className="flex items-center gap-1.5 rounded-lg bg-[#1c3361] px-3 py-1.5 text-sm font-medium text-white shadow-md">
            <PenLine className="h-4 w-4" /> AI 板书
          </div>
          <div className="flex items-center rounded-lg bg-black/25 text-sm text-white/85">
            <button
              disabled={viewIdx <= 0}
              onClick={() => props.onView(viewIdx - 1)}
              className="p-1.5 disabled:opacity-30"
              title="上一页"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <select
              value={viewIdx}
              onChange={(e) => props.onView(Number(e.target.value))}
              className="cursor-pointer bg-transparent py-1 text-sm outline-none [&>option]:text-slate-800"
            >
              {problems.map((p, i) => (
                <option key={p.id} value={i}>
                  第 {p.number} 题{props.progress[String(i)] === "done" ? " ✓" : i === props.currentIdx ? " ●" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={viewIdx >= problems.length - 1}
              onClick={() => props.onView(viewIdx + 1)}
              className="p-1.5 disabled:opacity-30"
              title="下一页"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          {viewIdx !== props.currentIdx && (
            <button
              onClick={() => props.onView(props.currentIdx)}
              className="rounded-lg bg-amber-300/20 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-300/30"
            >
              回到当前题
            </button>
          )}
          <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-black/25 p-1 text-[13px] text-white/85">
            <ToolBtn
              icon={FileText}
              label="题目"
              active={props.overlay === "problem"}
              onClick={() => props.onOverlay(props.overlay === "problem" ? "none" : "problem")}
            />
            <ToolBtn
              icon={Star}
              label="重点"
              active={props.overlay === "keypoints"}
              onClick={() => props.onOverlay(props.overlay === "keypoints" ? "none" : "keypoints")}
            />
            <ToolBtn icon={NotebookPen} label="笔记" onClick={props.onExport} />
            <ToolBtn icon={fullscreen ? Minimize2 : Maximize2} label={fullscreen ? "退出" : "全屏"} onClick={toggleFullscreen} />
          </div>
        </div>

        <div className="chalk px-8 pt-4 lg:px-10">
          <h1 key={`${viewIdx}-${title}`} className="chalk-in">
            {title}
          </h1>
        </div>

        <div
          ref={scrollRef}
          onWheel={(e) => {
            if (!wide) return;
            const el = scrollRef.current;
            if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
          }}
          className={`chalk-scroll min-h-0 flex-1 px-8 pb-5 lg:px-10 ${
            wide ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto"
          }`}
        >
          {board && board.blocks.length ? (
            <div className={`chalk ${wide ? "board-cols" : ""}`}>
              {board.blocks.map((b) => (
                <div key={b.id} className={props.freshBlocks.includes(b.id) ? "chalk-in" : ""}>
                  <Markdown content={b.md} />
                </div>
              ))}
            </div>
          ) : (
            <div className="chalk flex h-full min-h-[240px] flex-col items-center justify-center text-center text-white/35">
              <PenLine className="h-10 w-10" />
              <p className="mt-3 text-xl">黑板还是空的</p>
              <p className="text-base">导师讲课时，会在这里同步写下板书，方便你记笔记</p>
            </div>
          )}
        </div>

        {props.overlay !== "none" && problem && (
          <div className="chalk-scroll fade-up absolute inset-x-4 bottom-4 top-16 z-10 overflow-y-auto rounded-xl bg-[#11211d]/95 p-6 shadow-2xl ring-1 ring-white/15 backdrop-blur">
            <button
              onClick={() => props.onOverlay("none")}
              className="absolute right-3 top-3 rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            {props.overlay === "problem" ? (
              <div className="chalk">
                <h3>
                  第 {problem.number} 题 {problem.type && `· ${problem.type}`}
                  <span className="ml-3 text-base text-amber-300/80">{difficultyStars(problem.difficulty)}</span>
                </h3>
                <Markdown content={problem.content} />
                <a
                  href={`/api/papers/${props.paperId}/pages/${Math.max(0, problem.page - 1)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-base text-sky-300 hover:underline"
                >
                  查看原卷第 {problem.page} 页 ↗
                </a>
              </div>
            ) : (
              <div className="chalk space-y-3">
                <h3>本题重点 · {problem.title || `第 ${problem.number} 题`}</h3>
                <div className="text-sm text-white/60">
                  建议教学方式：{strategyLabel(problem.strategy)}
                  {problem.strategyReason ? `（${problem.strategyReason}）` : ""}
                </div>
                {problem.keyPoints.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-1.5">
                      <Lightbulb className="h-4 w-4" /> 解题关键点
                    </h4>
                    <ul>
                      {problem.keyPoints.map((k, i) => (
                        <li key={i}>
                          <Markdown content={k} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {problem.knowledgePoints.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-1.5">
                      <BookMarked className="h-4 w-4" /> 关联教材知识点
                    </h4>
                    <ul>
                      {problem.knowledgePoints.map((k, i) => (
                        <li key={i}>
                          <strong>{k.name}</strong>
                          {k.source && <span className="text-sky-200/80"> 📖 {k.source}</span>}
                          {k.detail && <div className="text-[0.92em] text-white/70">{k.detail}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {problem.skills.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-1.5">
                      <Wrench className="h-4 w-4" /> 方法与技能
                    </h4>
                    <p>{problem.skills.join(" · ")}</p>
                  </div>
                )}
                <div>
                  {showAnswer ? (
                    <blockquote>
                      <strong>答案：</strong>
                      <Markdown content={problem.answer || "—"} />
                    </blockquote>
                  ) : (
                    <button
                      onClick={() => setAnswerState({ viewIdx, visible: true })}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 px-3 py-1 text-base text-white/80 hover:bg-white/10"
                    >
                      <Eye className="h-4 w-4" /> 显示参考答案
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="relative mx-6 h-4 rounded-b-md bg-gradient-to-b from-[#6e5c49] to-[#3d3127] shadow-inner">
        <span className="absolute -top-1.5 left-10 h-2.5 w-14 rounded-sm bg-gradient-to-b from-[#d8c7aa] to-[#8a785f] shadow" />
        <span className="absolute -top-1 right-16 h-1.5 w-8 rounded-full bg-white/90 shadow" />
        <span className="absolute -top-1 right-28 h-1.5 w-6 rounded-full bg-amber-200 shadow" />
        <span className="absolute -top-1 right-40 h-1.5 w-7 rounded-full bg-sky-300 shadow" />
      </div>
    </div>
  );
}
