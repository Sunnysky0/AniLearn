"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Circle,
  Image as ImageIcon,
  Lightbulb,
  Paperclip,
  PartyPopper,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Settings,
  Square,
  User,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Logo } from "@/components/AppHeader";
import { Markdown } from "@/components/Markdown";
import Blackboard, { type BoardOverlay } from "@/components/classroom/Blackboard";
import { downloadText, fileToJpegDataUrl } from "@/lib/client/media";
import { difficultyStars, formatTime, strategyLabel, tokenizeForReveal } from "@/lib/text";
import type {
  BoardDTO,
  MessageDTO,
  PaperDTO,
  ProblemDTO,
  SessionDTO,
  TurnAction,
  TurnEvent,
  TutorDTO,
} from "@/lib/types";

type QueueItem = Exclude<TurnEvent, { type: "user" }>;

interface Props {
  session: SessionDTO;
  tutor: TutorDTO;
  paper: PaperDTO;
  problems: ProblemDTO[];
  initialMessages: MessageDTO[];
  initialBoards: BoardDTO[];
  ttsAvailable: boolean;
  llmReady: boolean;
  autoContinueDefault: boolean;
}

const QUICK = ["继续讲解", "给我一点提示", "我懂了，下一题", "能再讲一遍吗？"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTutorText = (m?: MessageDTO) => !!m && m.role === "tutor" && m.kind === "text";

function VoiceBars() {
  return (
    <span className="inline-flex h-3 items-end gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="voice-bar w-[3px] rounded-full bg-blue-500" style={{ height: "100%", animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}

const TutorBubble = memo(function TutorBubble({
  m,
  avatar,
  showAvatar,
  showTime,
  shown,
  canReplay,
  onReplay,
}: {
  m: MessageDTO;
  avatar: string;
  showAvatar: boolean;
  showTime: boolean;
  shown: number | null;
  canReplay: boolean;
  onReplay: (m: MessageDTO) => void;
}) {
  const tokens = useMemo(() => tokenizeForReveal(m.content), [m.content]);
  const text = shown === null ? m.content : tokens.slice(0, shown).join("");
  const speaking = shown !== null;
  return (
    <div className={`group fade-up flex gap-2.5 ${showAvatar ? "mt-3" : "mt-1.5"}`}>
      <div className="w-10 shrink-0">
        {showAvatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="h-10 w-10 rounded-full object-cover shadow ring-2 ring-white" />
        )}
      </div>
      <div className="min-w-0 max-w-[86%]">
        <div
          className={`rounded-2xl ${showAvatar ? "rounded-tl-md" : ""} bg-[#eaf1fb] px-4 py-2.5 text-[15px] text-slate-700 shadow-sm ring-1 ring-[#dde7f5] ${
            speaking ? "ring-blue-200" : ""
          }`}
        >
          <Markdown className="md" content={text || "\u200b"} />
        </div>
        <div className="mt-1 flex h-4 items-center gap-2 pl-1 text-[11px] text-slate-400">
          {speaking ? <VoiceBars /> : showTime ? <span>{formatTime(m.createdAt)}</span> : null}
          {canReplay && m.speech && !speaking && (
            <button
              onClick={() => onReplay(m)}
              className="opacity-0 transition hover:text-blue-500 group-hover:opacity-100"
              title="重播语音"
            >
              <Volume2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function UserBubble({ m, showTime }: { m: MessageDTO; showTime: boolean }) {
  return (
    <div className="fade-up mt-3 flex justify-end gap-2.5">
      <div className="flex min-w-0 max-w-[86%] flex-col items-end">
        {m.attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {m.attachments.map((a, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={a} alt="" className="h-24 rounded-xl object-cover ring-1 ring-slate-200" />
            ))}
          </div>
        )}
        {m.content && (
          <div className="rounded-2xl rounded-tr-md bg-gradient-to-br from-[#5b9bff] to-[#3a7af2] px-4 py-2.5 text-[15px] text-white shadow-md shadow-blue-500/20">
            <Markdown className="md md-invert" content={m.content} />
          </div>
        )}
        {showTime && <div className="mt-1 pr-1 text-[11px] text-slate-400">{formatTime(m.createdAt)}</div>}
      </div>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#5b9bff] to-[#3a7af2] text-white shadow">
        <User className="h-5 w-5" />
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-blue-600" : "bg-slate-300"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export default function Classroom(props: Props) {
  const { tutor, paper, problems } = props;
  const [messages, setMessages] = useState<MessageDTO[]>(props.initialMessages);
  const [typing, setTyping] = useState<{ id: number; shown: number } | null>(null);
  const [boards, setBoards] = useState<Record<number, BoardDTO>>(() => {
    const o: Record<number, BoardDTO> = {};
    for (const b of props.initialBoards) o[b.problemIdx] = b;
    return o;
  });
  const [session, setSession] = useState<SessionDTO>(props.session);
  const [viewIdx, setViewIdx] = useState(props.session.currentIdx);
  const [freshBlocks, setFreshBlocks] = useState<string[]>([]);
  const [busy, setBusy] = useState<"idle" | "thinking" | "speaking">("idle");
  const [waitingTTS, setWaitingTTS] = useState(false);
  const [entered, setEntered] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [autoContinue, setAutoContinue] = useState(props.autoContinueDefault);
  const [rate, setRate] = useState(1);
  const [overlay, setOverlay] = useState<BoardOverlay>("none");
  const [showOutline, setShowOutline] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const queueRef = useRef<QueueItem[]>([]);
  const pumpingRef = useRef(false);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const flushRef = useRef(false);
  const flushWaiters = useRef<Array<() => void>>([]);
  const finishRef = useRef<(() => void) | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const ttsCache = useRef(new Map<number, Promise<string | null>>());
  const ttsRequests = useRef(new Set<AbortController>());
  const audioUrls = useRef(new Set<string>());
  const disposedRef = useRef(false);
  const lastActionRef = useRef<TurnAction | null>(null);
  const autoCountRef = useRef(0);
  const pendingRef = useRef<Array<{ text: string; images: string[] }>>([]);
  const optimisticId = useRef(-1);
  const prefs = useRef({ muted: false, autoContinue: props.autoContinueDefault, rate: 1 });
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    prefs.current = { muted, autoContinue, rate };
    const a = playerRef.current;
    if (a) {
      a.muted = muted;
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
    }
    if (muted) {
      ttsRequests.current.forEach((request) => request.abort());
      ttsCache.current.clear();
      finishRef.current?.();
    }
  }, [muted, autoContinue, rate]);

  useEffect(() => {
    disposedRef.current = false;
    flushRef.current = false;
    const requests = ttsRequests.current;
    const urls = audioUrls.current;
    return () => {
      disposedRef.current = true;
      queueRef.current = [];
      pendingRef.current = [];
      requestFlush();
      abortRef.current?.abort();
      requests.forEach((request) => request.abort());
      playerRef.current?.pause();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing, busy, waitingTTS, error]);

  const safeIdx = Math.min(Math.max(session.currentIdx, 0), Math.max(problems.length - 1, 0));
  const current = problems[safeIdx];

  // ------------------------------------------------------------------ audio
  function requestFlush() {
    flushRef.current = true;
    const ws = flushWaiters.current;
    flushWaiters.current = [];
    ws.forEach((w) => w());
    finishRef.current?.();
    ttsRequests.current.forEach((request) => request.abort());
  }

  function untilFlush(): Promise<null> {
    return new Promise((resolve) => {
      if (flushRef.current) resolve(null);
      else flushWaiters.current.push(() => resolve(null));
    });
  }

  function getAudio(m: MessageDTO): Promise<string | null> {
    const hit = ttsCache.current.get(m.id);
    if (hit) return hit;
    const p = (async () => {
      const ac = new AbortController();
      ttsRequests.current.add(ac);
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: m.speech, voiceId: tutor.voiceId }),
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(15_000)]),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          throw new Error(j?.error || `语音合成失败 (${r.status})`);
        }
        const blob = await r.blob();
        if (ac.signal.aborted || disposedRef.current) return null;
        const url = URL.createObjectURL(blob);
        audioUrls.current.add(url);
        return url;
      } catch (e) {
        if (!ac.signal.aborted && !disposedRef.current) setTtsError(e instanceof Error && e.name === "TimeoutError"
          ? "语音等待超时，已切换为文字显示。" : e instanceof Error ? e.message : String(e));
        ttsCache.current.delete(m.id);
        return null;
      } finally {
        ttsRequests.current.delete(ac);
      }
    })();
    ttsCache.current.set(m.id, p);
    return p;
  }

  function appendMessage(m: MessageDTO) {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }

  /** Show a tutor message with its Japanese voice; text is revealed in sync with audio progress. */
  async function playMessage(m: MessageDTO) {
    if (flushRef.current) return appendMessage(m);
    let url: string | null = null;
    if (props.ttsAvailable && m.speech && !prefs.current.muted) {
      setWaitingTTS(true);
      url = await Promise.race([getAudio(m), untilFlush()]);
      setWaitingTTS(false);
    }
    if (flushRef.current) return appendMessage(m);
    const total = tokenizeForReveal(m.content).length;
    appendMessage(m);
    setTyping({ id: m.id, shown: 0 });
    await new Promise<void>((resolve) => {
      let done = false;
      let raf = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let last = -1;
      const a = url ? (playerRef.current ?? new Audio()) : null;
      if (a) playerRef.current = a;
      const show = (f: number) => {
        const n = Math.max(0, Math.min(total, Math.ceil(f * total)));
        if (n !== last) {
          last = n;
          setTyping({ id: m.id, shown: n });
        }
      };
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        if (timer) clearTimeout(timer);
        if (a) {
          a.onended = null;
          a.onerror = null;
          a.pause();
        }
        finishRef.current = null;
        setTyping(null);
        resolve();
      };
      finishRef.current = finish;
      const runTimer = () => {
        cancelAnimationFrame(raf);
        const dur = Math.min(9000, Math.max(800, total * 60)) / prefs.current.rate;
        const t0 = performance.now();
        const step = () => {
          const f = (performance.now() - t0) / dur;
          show(f);
          if (f >= 1) {
            timer = setTimeout(finish, 400);
            return;
          }
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      };
      if (a && url) {
        a.src = url;
        a.muted = prefs.current.muted;
        a.defaultPlaybackRate = prefs.current.rate;
        a.playbackRate = prefs.current.rate;
        const tick = () => {
          const d = a.duration;
          if (d && Number.isFinite(d) && d > 0) show(Math.min(1, a.currentTime / d));
          raf = requestAnimationFrame(tick);
        };
        a.onended = () => {
          cancelAnimationFrame(raf);
          show(1);
          timer = setTimeout(finish, 250);
        };
        a.onerror = () => runTimer();
        a.play()
          .then(() => {
            raf = requestAnimationFrame(tick);
          })
          .catch(() => runTimer());
      } else {
        runTimer();
      }
    });
  }

  // ------------------------------------------------------------------ agent loop
  async function pump() {
    if (pumpingRef.current || disposedRef.current) return;
    pumpingRef.current = true;
    setBusy("speaking");
    try {
      while (queueRef.current.length && !disposedRef.current) {
        const item = queueRef.current.shift()!;
        try {
          if (item.type === "message") {
            await playMessage(item.message);
          } else if (item.type === "board") {
            setBoards((b) => ({ ...b, [item.board.problemIdx]: item.board }));
            setViewIdx(item.board.problemIdx);
            if (!flushRef.current && item.blockId) setFreshBlocks((f) => [...f.slice(-12), item.blockId]);
            appendMessage(item.message);
            if (!flushRef.current) await sleep(500);
          } else if (item.type === "problem") {
            setSession(item.session);
            appendMessage(item.message);
            setViewIdx(item.session.currentIdx);
            setOverlay("none");
          } else if (item.type === "done") {
            setSession(item.session);
            if (!flushRef.current) lastActionRef.current = item.action;
          } else if (item.type === "error") {
            setError(item.error);
          }
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      pumpingRef.current = false;
      setWaitingTTS(false);
      setBusy(streamingRef.current ? "thinking" : "idle");
    }
    afterIdle();
  }

  function afterIdle() {
    if (disposedRef.current) return;
    if (streamingRef.current || pumpingRef.current || queueRef.current.length) return;
    flushRef.current = false;
    const pending = pendingRef.current.shift();
    if (pending) {
      lastActionRef.current = null;
      void startTurn(pending);
      return;
    }
    const act = lastActionRef.current;
    lastActionRef.current = null;
    if ((act === "continue" || act === "next") && prefs.current.autoContinue && autoCountRef.current < 6) {
      autoCountRef.current += 1;
      void startTurn({});
    }
  }

  async function startTurn(payload: { text?: string; images?: string[] }) {
    if (disposedRef.current) return;
    const text = payload.text ?? "";
    const images = payload.images ?? [];
    if (text || images.length) {
      appendMessage({
        id: optimisticId.current--,
        role: "user",
        kind: "text",
        content: text,
        speech: "",
        problemIdx: session.currentIdx,
        attachments: images,
        createdAt: new Date().toISOString(),
      });
      stickRef.current = true;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    streamingRef.current = true;
    setError(null);
    if (!pumpingRef.current) setBusy("thinking");
    try {
      const request = () => fetch(`/api/sessions/${props.session.id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images }),
        signal: ac.signal,
      });
      let res = await request();
      for (let attempt = 0; res.status === 409 && attempt < 8 && !ac.signal.aborted; attempt++) {
        await sleep(250);
        res = await request();
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `请求失败 (${res.status})`);
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
          let ev: TurnEvent;
          try {
            ev = JSON.parse(line) as TurnEvent;
          } catch {
            continue;
          }
          if (ev.type === "user") continue;
          if (ev.type === "message" && props.ttsAvailable && ev.message.speech && !flushRef.current && !prefs.current.muted) {
            void getAudio(ev.message); // prefetch voice while earlier messages are still playing
          }
          queueRef.current.push(ev);
          void pump();
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        queueRef.current.push({ type: "error", error: e instanceof Error ? e.message : String(e) });
        void pump();
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      streamingRef.current = false;
      if (!pumpingRef.current) setBusy("idle");
      afterIdle();
    }
  }

  function send(raw: string, images: string[] = []) {
    const text = raw.trim();
    if (!text && !images.length) return;
    if (!props.llmReady) {
      setError("尚未配置 AI 模型 API Key，请先前往「设置」页面配置。");
      return;
    }
    setInput("");
    setAttachments([]);
    setError(null);
    autoCountRef.current = 0;
    lastActionRef.current = null;
    if (streamingRef.current || pumpingRef.current) {
      // Interrupt: flush what the tutor already said, stop generation, then ask.
      pendingRef.current.push({ text, images });
      requestFlush();
      abortRef.current?.abort();
      return;
    }
    void startTurn({ text, images });
  }

  function stop() {
    lastActionRef.current = null;
    autoCountRef.current = 99;
    requestFlush();
    abortRef.current?.abort();
  }

  function waitIdle(timeout = 5000) {
    return new Promise<void>((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if ((!streamingRef.current && !pumpingRef.current) || Date.now() - t0 > timeout) resolve();
        else setTimeout(check, 40);
      };
      check();
    });
  }

  async function gotoProblem(i: number) {
    setShowOutline(false);
    if (i === session.currentIdx) {
      setViewIdx(i);
      return;
    }
    if (streamingRef.current || pumpingRef.current) {
      stop();
      await waitIdle();
    }
    autoCountRef.current = 0;
    try {
      const request = () => fetch(`/api/sessions/${props.session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentIdx: i }),
      });
      let r = await request();
      for (let attempt = 0; r.status === 409 && attempt < 8 && !disposedRef.current; attempt++) {
        await sleep(250);
        r = await request();
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "切换题目失败");
      setSession(j.session as SessionDTO);
      appendMessage(j.message as MessageDTO);
      setViewIdx(i);
      setOverlay("none");
      stickRef.current = true;
      if (props.llmReady) void startTurn({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const replay = useCallback(
    async (m: MessageDTO) => {
      if (pumpingRef.current || !props.ttsAvailable || prefs.current.muted || disposedRef.current) return;
      const url = await getAudio(m);
      if (!url || prefs.current.muted || disposedRef.current) return;
      playerRef.current?.pause();
      const a = new Audio(url);
      playerRef.current = a;
      a.muted = prefs.current.muted;
      a.playbackRate = prefs.current.rate;
      void a.play().catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.ttsAvailable],
  );

  function enter() {
    setEntered(true);
    try {
      // Create the audio element inside the user gesture so later playback is allowed.
      const a = new Audio();
      a.preload = "auto";
      a.load();
      playerRef.current = a;
    } catch {
      /* ignore */
    }
    const visible = messages.filter((m) => m.kind !== "board");
    const last = visible[visible.length - 1];
    if (props.llmReady && session.status !== "completed" && (!last || last.role !== "tutor")) {
      void startTurn({});
    }
  }

  async function onPickImages(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of files.slice(0, 4)) {
      try {
        const d = await fileToJpegDataUrl(f, 1400, 0.82);
        setAttachments((a) => [...a, d].slice(0, 4));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  function exportNotes() {
    const parts: string[] = [`# ${paper.title} · 板书笔记`, `> 导师：${tutor.name} ｜ 导出时间：${new Date().toLocaleString()}`];
    problems.forEach((p, i) => {
      const b = boards[i];
      if (!b?.blocks.length) return;
      parts.push(`## ${b.title || `第${p.number}题`}`, ...b.blocks.map((x) => x.md));
    });
    if (parts.length <= 2) {
      alert("黑板上还没有板书哦～");
      return;
    }
    downloadText(`AniLearn-${paper.title}-板书笔记.md`, parts.join("\n\n"));
  }

  const doneCount = Object.values(session.progress ?? {}).filter((v) => v === "done").length;
  const hasTutorMessages = messages.some(isTutorText);
  const showTyping = busy === "thinking" || waitingTTS;
  const speakingNow = typing !== null;

  if (!current) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        这份试卷还没有解析出题目。
        <Link href={`/papers/${paper.id}`} className="ml-2 text-blue-600 underline">
          返回试卷
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#e7edf6] lg:h-screen">
      {/* ---------------- top bar ---------------- */}
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-4 bg-gradient-to-r from-[#10204a] via-[#1a3166] to-[#10204a] px-4 text-white shadow-lg">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Logo className="h-8 w-8" />
          <div className="leading-tight">
            <div className="font-bold tracking-wide">AniLearn</div>
            <div className="text-[9px] tracking-[0.18em] text-blue-200/80">AI 一对一课堂</div>
          </div>
        </Link>
        <span className="hidden text-sm text-blue-100/70 xl:block">你的专属AI导师</span>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-4">
          <span className="truncate font-semibold">
            高中{paper.subject} · {paper.title}
          </span>
          <span className="hidden h-5 w-px bg-white/25 md:block" />
          <span className="hidden truncate text-blue-100 md:block">
            第 {current.number} 题{current.title ? ` · ${current.title}` : ""}
          </span>
        </div>
        <button onClick={() => setShowOutline(true)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-white/10">
          <BookOpen className="h-4 w-4" /> <span className="hidden sm:inline">课程目录</span>
        </button>
        <div className="relative">
          <button onClick={() => setShowMenu((v) => !v)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-white/10">
            <Settings className="h-4 w-4" /> <span className="hidden sm:inline">设置</span>
          </button>
          {showMenu && (
            <div className="absolute right-0 top-11 w-72 space-y-3 rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-2xl ring-1 ring-slate-200">
              <div className="flex items-center justify-between">
                <span>语音播放</span>
                <Toggle on={!muted} onChange={(v) => setMuted(!v)} />
              </div>
              <div className="flex items-center justify-between">
                <span>语速</span>
                <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
                  {[1, 1.25, 1.5].map((r) => (
                    <button key={r} onClick={() => setRate(r)} className={`rounded-md px-2 py-1 ${rate === r ? "bg-white font-semibold text-blue-600 shadow" : ""}`}>
                      {r}x
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span>导师连续讲解</span>
                <Toggle on={autoContinue} onChange={setAutoContinue} />
              </div>
              <div className="border-t border-slate-100 pt-3 text-xs">
                {!props.ttsAvailable && <p className="mb-2 text-amber-600">未配置 Fish Audio，当前为纯文字模式。</p>}
                <Link href="/settings" className="block py-1 text-blue-600 hover:underline">
                  模型与语音设置 →
                </Link>
                <Link href={`/papers/${paper.id}`} className="block py-1 text-blue-600 hover:underline">
                  返回试卷解析 →
                </Link>
              </div>
            </div>
          )}
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-blue-600 ring-2 ring-white/30">
          <User className="h-5 w-5" />
        </div>
      </header>

      {/* ---------------- main ---------------- */}
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        {/* chat */}
        <section className="flex h-[78vh] flex-col overflow-hidden rounded-2xl bg-[#f5f8fd] shadow-sm ring-1 ring-white lg:h-auto lg:w-[31%] lg:min-w-[360px] lg:max-w-[460px]">
          <div className="flex items-center gap-4 border-b border-slate-200/60 bg-white/70 px-5 py-4">
            <div className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tutor.avatar} alt={tutor.name} className="h-16 w-16 rounded-full object-cover ring-4 ring-blue-100" />
              {speakingNow && <span className="absolute inset-0 animate-ping rounded-full ring-4 ring-blue-400/40" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-lg font-bold text-slate-800">
                AI导师 · {tutor.name}
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                {speakingNow && <VoiceBars />}
              </div>
              <div className="truncate text-sm text-slate-500">{tutor.tags.join(" | ") || tutor.subject}</div>
            </div>
            <button
              onClick={() => setMuted((v) => !v)}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
              title={muted ? "开启语音" : "静音"}
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
          </div>

          <button
            onClick={() => {
              setViewIdx(safeIdx);
              setOverlay((o) => (o === "problem" ? "none" : "problem"));
            }}
            className="mx-4 mt-3 flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-left text-xs shadow-sm ring-1 ring-slate-200/70 transition hover:ring-blue-300"
          >
            <span className="shrink-0 rounded-md bg-blue-600 px-1.5 py-0.5 font-bold text-white">第 {current.number} 题</span>
            <span className="line-clamp-1 flex-1 text-slate-600">{current.title || current.type}</span>
            <span className="shrink-0 text-amber-500">{difficultyStars(current.difficulty)}</span>
            <span className="shrink-0 text-blue-600">{overlay === "problem" ? "收起" : "查看题目"}</span>
          </button>

          <div
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            }}
            className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1"
          >
            {messages.map((m, i) => {
              if (m.kind === "problem") {
                return (
                  <div key={m.id} className="my-4 flex items-center gap-3">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-blue-600 shadow-sm ring-1 ring-blue-100">
                      📘 {m.content}
                    </span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                );
              }
              if (m.kind === "board") {
                return (
                  <div key={m.id} className="mt-1.5 flex justify-center">
                    <button
                      onClick={() => setViewIdx(m.problemIdx)}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] text-slate-400 hover:bg-white hover:text-blue-500"
                    >
                      <PenLine className="h-3 w-3" /> 老师{m.speech === "replace" ? "重写" : "更新"}了板书
                    </button>
                  </div>
                );
              }
              let prev: MessageDTO | undefined;
              for (let k = i - 1; k >= 0; k--) {
                if (messages[k].kind !== "board") {
                  prev = messages[k];
                  break;
                }
              }
              let next: MessageDTO | undefined;
              for (let k = i + 1; k < messages.length; k++) {
                if (messages[k].kind !== "board") {
                  next = messages[k];
                  break;
                }
              }
              if (m.role === "user") {
                return <UserBubble key={m.id} m={m} showTime={!next || next.role !== "user"} />;
              }
              return (
                <TutorBubble
                  key={m.id}
                  m={m}
                  avatar={tutor.avatar}
                  showAvatar={!isTutorText(prev)}
                  showTime={!isTutorText(next)}
                  shown={typing && typing.id === m.id ? typing.shown : null}
                  canReplay={props.ttsAvailable}
                  onReplay={replay}
                />
              );
            })}

            {session.status === "completed" && busy === "idle" && (
              <div className="fade-up mt-5 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-4 text-center ring-1 ring-amber-200">
                <PartyPopper className="mx-auto h-7 w-7 text-amber-500" />
                <div className="mt-1 font-bold text-amber-800">整张试卷已学完！</div>
                <div className="mt-1 text-xs text-amber-700">记得导出板书笔记，过几天再回顾一遍效果更好～</div>
                <div className="mt-3 flex justify-center gap-2">
                  <button onClick={exportNotes} className="rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white">
                    导出笔记
                  </button>
                  <Link href={`/papers/${paper.id}`} className="rounded-full bg-white px-4 py-1.5 text-xs text-amber-700 ring-1 ring-amber-200">
                    返回试卷
                  </Link>
                </div>
              </div>
            )}

            {error && (
              <div className="fade-up mt-4 rounded-xl bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-rose-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="flex-1 break-all">{error}</span>
                </div>
                <div className="mt-2 flex gap-2 pl-6">
                  <button
                    onClick={() => {
                      setError(null);
                      void startTurn({});
                    }}
                    className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1 text-white"
                  >
                    <RotateCcw className="h-3 w-3" /> 重试
                  </button>
                  {/API Key/i.test(error) && (
                    <Link href="/settings" className="rounded-full bg-white px-3 py-1 ring-1 ring-rose-200">
                      前往设置
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>

          {showTyping && (
            <div className="flex items-center gap-2 px-5 pb-1.5 text-xs text-slate-400">
              <span className="flex gap-1">
                <i className="typing-dot" />
                <i className="typing-dot" />
                <i className="typing-dot" />
              </span>
              AI 正在{waitingTTS ? "输入" : "思考"}中…
            </div>
          )}
          {ttsError && (
            <div className="mx-4 mb-1.5 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="line-clamp-2 flex-1">语音不可用：{ttsError}</span>
              <button onClick={() => setTtsError(null)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="border-t border-slate-200/60 bg-white/70 p-3">
            <div className="thin-scroll mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {QUICK.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="shrink-0 rounded-full bg-white px-3 py-1 text-xs text-slate-600 ring-1 ring-slate-200 transition hover:bg-blue-50 hover:text-blue-600 hover:ring-blue-200"
                >
                  {q}
                </button>
              ))}
              {busy !== "idle" && (
                <button
                  onClick={stop}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                >
                  <Square className="h-3 w-3" /> 停止讲解
                </button>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-50">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1 pb-2">
                  {attachments.map((a, i) => (
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a} alt="" className="h-16 w-16 rounded-lg object-cover ring-1 ring-slate-200" />
                      <button
                        onClick={() => setAttachments((as) => as.filter((_, j) => j !== i))}
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-700 p-0.5 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    send(input, attachments);
                  }
                }}
                rows={2}
                placeholder="输入你的问题，或发送“继续讲解”…"
                className="w-full resize-none bg-transparent px-2 py-1 text-sm text-slate-700 outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center gap-1 px-1">
                <button onClick={() => fileRef.current?.click()} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600" title="上传解题草稿图片">
                  <Paperclip className="h-5 w-5" />
                </button>
                <button onClick={() => camRef.current?.click()} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600" title="拍照上传">
                  <ImageIcon className="h-5 w-5" />
                </button>
                <button onClick={() => send("给我一点提示")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-amber-500" title="请求提示">
                  <Lightbulb className="h-5 w-5" />
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickImages} />
                <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickImages} />
                <span className="ml-auto hidden text-[11px] text-slate-300 sm:inline">Enter 发送 · Shift+Enter 换行</span>
                <button
                  onClick={() => send(input, attachments)}
                  disabled={!input.trim() && !attachments.length}
                  className="ml-2 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#4f8ff7] to-[#2f6fe8] text-white shadow-md shadow-blue-500/30 transition hover:brightness-110 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* blackboard */}
        <section className="h-[80vh] min-w-0 lg:h-auto lg:flex-1">
          <Blackboard
            paperId={paper.id}
            paperTitle={paper.title}
            problems={problems}
            boards={boards}
            viewIdx={Math.min(viewIdx, problems.length - 1)}
            currentIdx={safeIdx}
            progress={session.progress ?? {}}
            freshBlocks={freshBlocks}
            overlay={overlay}
            onOverlay={setOverlay}
            onView={setViewIdx}
            onExport={exportNotes}
          />
        </section>
      </main>

      {/* ---------------- outline drawer ---------------- */}
      {showOutline && (
        <div className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[1px]" onClick={() => setShowOutline(false)}>
          <aside
            className="thin-scroll absolute right-0 top-0 h-full w-full max-w-sm overflow-y-auto bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">课程目录</h3>
                <p className="text-xs text-slate-500">
                  已完成 {doneCount}/{problems.length} 题 · 点击可跳转到任意一题
                </p>
              </div>
              <button onClick={() => setShowOutline(false)} className="rounded-full p-2 text-slate-400 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600"
                style={{ width: `${Math.round((doneCount / Math.max(problems.length, 1)) * 100)}%` }}
              />
            </div>
            <div className="mt-4 space-y-2">
              {problems.map((p, i) => {
                const st = session.progress?.[String(i)];
                const isCur = i === safeIdx;
                return (
                  <button
                    key={p.id}
                    onClick={() => void gotoProblem(i)}
                    className={`flex w-full items-start gap-3 rounded-xl p-3 text-left ring-1 transition ${
                      isCur ? "bg-blue-50 ring-blue-300" : "ring-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                        st === "done" ? "bg-emerald-500 text-white" : isCur ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {st === "done" ? <Check className="h-3.5 w-3.5" /> : isCur ? <Play className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-800">
                        第 {p.number} 题 <span className="font-normal text-slate-500">{p.type}</span>
                      </div>
                      <div className="line-clamp-1 text-xs text-slate-500">{p.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <span className="text-amber-500">{difficultyStars(p.difficulty)}</span>
                        <span className={p.strategy === "student_first" ? "text-emerald-600" : "text-violet-600"}>{strategyLabel(p.strategy)}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      )}

      {/* ---------------- enter overlay (unlocks audio) ---------------- */}
      {!entered && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0b1630]/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-3xl bg-white text-center shadow-2xl">
            <div className="bg-gradient-to-br from-[#13254d] to-[#2563eb] px-6 pb-14 pt-8 text-white">
              <div className="text-[10px] tracking-[0.35em] text-blue-200">ANILEARN CLASSROOM</div>
              <div className="mt-2 text-xl font-bold">{paper.title}</div>
              <div className="mt-1 text-sm text-blue-100/80">
                共 {problems.length} 题 · {session.status === "completed" ? "已全部完成" : `当前第 ${safeIdx + 1} 题`}
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={tutor.avatar} alt="" className="mx-auto -mt-12 h-24 w-24 rounded-full object-cover shadow-xl ring-4 ring-white" />
            <div className="px-6 pb-7 pt-3">
              <div className="text-lg font-bold text-slate-800">AI导师 · {tutor.name}</div>
              <p className="mt-2 text-sm text-slate-500">“{tutor.greeting || "准备好了吗？我们开始上课吧！"}”</p>
              {!props.llmReady && (
                <div className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-700">
                  尚未配置 AI 模型 API Key，请先
                  <Link href="/settings" className="mx-1 underline">
                    前往设置
                  </Link>
                  。
                </div>
              )}
              {!props.ttsAvailable && <div className="mt-3 text-xs text-slate-400">未配置 Fish Audio 语音，将以纯文字形式上课。</div>}
              <button
                onClick={enter}
                className="mt-6 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-8 py-3 font-semibold text-white shadow-lg shadow-blue-500/30 transition hover:brightness-110"
              >
                <Play className="h-5 w-5" /> {hasTutorMessages ? "继续上课" : "开始上课"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
