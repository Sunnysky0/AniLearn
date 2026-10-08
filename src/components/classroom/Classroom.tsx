"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  Circle,
  Image as ImageIcon,
  Lightbulb,
  Paperclip,
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
  TurnRequest,
  TutorDTO,
} from "@/lib/types";
import { GOODBYE_TEXT, turnIntentForText } from "@/lib/types";

type ClientTurn = {
  streamEnded: boolean;
  failed: boolean;
  cancelled: boolean;
  done?: Extract<TurnEvent, { type: "done" }>;
};
type QueueItem = Exclude<TurnEvent, { type: "user" }> & { turn: ClientTurn };

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
        <span
          key={i}
          className="voice-bar w-[3px] bg-neutral-900"
          style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
        />
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
          <img src={avatar} alt="" className="h-10 w-10 object-cover border-2 border-white" />
        )}
      </div>
      <div className="min-w-0 max-w-[86%]">
        <div
          className={`bg-white px-3 py-2.5 text-base text-neutral-900 border border-neutral-300 ${
            speaking ? "border-neutral-200" : ""
          }`}
        >
          <Markdown className="md" content={text || "\u200b"} />
        </div>
        <div className="mt-1 flex h-4 items-center gap-2 pl-1 text-[11px] text-neutral-500">
          {speaking ? <VoiceBars /> : showTime ? <span>{formatTime(m.createdAt)}</span> : null}
          {canReplay && m.speech && !speaking && (
            <button
              onClick={() => onReplay(m)}
              className="opacity-0 transition hover:text-neutral-800 group-hover:opacity-100"
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
              <img key={i} src={a} alt="" className="h-24 object-cover border border-neutral-200" />
            ))}
          </div>
        )}
        {m.content && (
          <div className="border border-neutral-300 bg-neutral-100 px-3 py-2.5 text-base text-neutral-900">
            <Markdown className="md" content={m.content} />
          </div>
        )}
        {showTime && <div className="mt-1 pr-1 text-[11px] text-neutral-500">{formatTime(m.createdAt)}</div>}
      </div>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neutral-300 bg-neutral-100 text-neutral-900">
        <User className="h-5 w-5" />
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`flex h-5 w-5 shrink-0 items-center justify-center border border-neutral-900 ${on ? "bg-neutral-900 text-white" : "bg-white"}`}
      role="checkbox"
      aria-label={label}
      aria-checked={on}
    >
      {on && <Check className="h-4 w-4" />}
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
  const [mobilePanel, setMobilePanel] = useState<"chat" | "board">("chat");
  const [returnState, setReturnState] = useState<"hidden" | "waiting" | "ready">(
    props.session.status === "completed" ? "ready" : "hidden",
  );

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
  const pendingRef = useRef<TurnRequest[]>([]);
  const currentTurnRef = useRef<ClientTurn | null>(null);
  const retryRef = useRef<TurnRequest>({});
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
  }, [messages, typing, busy, waitingTTS, error, mobilePanel]);

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
        if (!ac.signal.aborted && !disposedRef.current)
          setTtsError(
            e instanceof Error && e.name === "TimeoutError"
              ? "语音等待超时，已切换为文字显示。"
              : e instanceof Error
                ? e.message
                : String(e),
          );
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
            item.turn.done = item;
            if (!flushRef.current && !item.turn.cancelled) {
              lastActionRef.current = item.intent === "goodbye" ? "wait" : item.action;
              if (item.intent === "goodbye" || item.session.status === "completed") setReturnState("waiting");
            }
          } else if (item.type === "error") {
            item.turn.failed = true;
            setReturnState("hidden");
            setError(item.error);
          }
        } catch (e) {
          item.turn.failed = true;
          setReturnState("hidden");
          setError(e instanceof Error ? e.message : String(e));
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
    const turn = currentTurnRef.current;
    if (turn) {
      if (turn.streamEnded && !turn.failed && !turn.cancelled && turn.done &&
        (turn.done.intent === "goodbye" || turn.done.session.status === "completed")) {
        setReturnState("ready");
      }
      if (turn.failed || turn.cancelled) {
        lastActionRef.current = null;
        setReturnState("hidden");
      }
      currentTurnRef.current = null;
    }
    const act = lastActionRef.current;
    lastActionRef.current = null;
    if ((act === "continue" || act === "next") && prefs.current.autoContinue && autoCountRef.current < 6) {
      autoCountRef.current += 1;
      void startTurn({});
    }
  }

  async function startTurn(payload: TurnRequest) {
    if (disposedRef.current) return;
    const text = payload.text ?? "";
    const images = payload.images ?? [];
    payload = { ...payload, intent: payload.intent ?? turnIntentForText(text) };
    const turn: ClientTurn = { streamEnded: false, failed: false, cancelled: false };
    currentTurnRef.current = turn;
    retryRef.current = { intent: payload.intent, problemIdx: payload.problemIdx };
    setReturnState(payload.intent === "goodbye" ? "waiting" : "hidden");
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
      const request = () =>
        fetch(`/api/sessions/${props.session.id}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, images, intent: payload.intent, problemIdx: payload.problemIdx }),
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
      let receivedDone = false;
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
            throw new Error("导师回复格式不完整，请重试。");
          }
          if (!ev || !["user", "message", "board", "problem", "done", "error"].includes(ev.type) || receivedDone) {
            throw new Error("导师回复格式不完整，请重试。");
          }
          if (ev.type === "user") continue;
          if (ev.type === "done") receivedDone = true;
          if (ev.type === "error") turn.failed = true;
          if (
            ev.type === "message" &&
            props.ttsAvailable &&
            ev.message.speech &&
            !flushRef.current &&
            !prefs.current.muted
          ) {
            void getAudio(ev.message); // prefetch voice while earlier messages are still playing
          }
          queueRef.current.push({ ...ev, turn });
          void pump();
        }
      }
      if (buf.trim() || (!receivedDone && !turn.failed)) throw new Error("导师回复提前结束，请重试。");
      turn.streamEnded = true;
    } catch (e) {
      turn.failed = true;
      setReturnState("hidden");
      if (!ac.signal.aborted) {
        queueRef.current.push({ type: "error", error: e instanceof Error ? e.message : String(e), turn });
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
    setReturnState("hidden");
    const intent = turnIntentForText(text);
    if (streamingRef.current || pumpingRef.current) {
      // Interrupt: flush what the tutor already said, stop generation, then ask.
      pendingRef.current.push({ text, images, intent, problemIdx: intent === "complete_problem" ? session.currentIdx : undefined });
      if (currentTurnRef.current) currentTurnRef.current.cancelled = true;
      requestFlush();
      abortRef.current?.abort();
      return;
    }
    void startTurn({ text, images, intent, problemIdx: intent === "complete_problem" ? session.currentIdx : undefined });
  }

  function stop() {
    if (currentTurnRef.current) currentTurnRef.current.cancelled = true;
    setReturnState("hidden");
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
    setReturnState("hidden");
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
      const request = () =>
        fetch(`/api/sessions/${props.session.id}`, {
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
    const parts: string[] = [
      `# ${paper.title} · 板书笔记`,
      `> 导师：${tutor.name} ｜ 导出时间：${new Date().toLocaleString()}`,
    ];
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
      <div className="flex h-screen items-center justify-center text-neutral-500">
        这份试卷还没有解析出题目。
        <Link href={`/papers/${paper.id}`} className="ml-2 text-neutral-800 underline">
          返回试卷
        </Link>
      </div>
    );
  }

  return (
    <div className="classroom-shell flex flex-col bg-[#fafafa]">
      {/* ---------------- top bar ---------------- */}
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b-2 border-neutral-900 bg-[#fafafa] px-3 text-neutral-900 sm:gap-4 sm:px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Logo className="h-8 w-8" />
          <div className="leading-tight">
            <div className="font-serif font-bold">AniLearn</div>
            <div className="text-[10px] text-neutral-600">一对一课堂</div>
          </div>
        </Link>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-4">
          <span className="truncate font-semibold">
            高中{paper.subject} · {paper.title}
          </span>
          <span className="hidden h-5 w-px bg-neutral-300 md:block" />
          <span className="hidden truncate text-neutral-600 md:block">
            第 {current.number} 题{current.title ? ` · ${current.title}` : ""}
          </span>
        </div>
        <button
          onClick={() => setShowOutline(true)}
          title="课程目录"
          className="flex shrink-0 items-center gap-1.5 p-2 text-sm hover:bg-neutral-100"
        >
          <BookOpen className="h-4 w-4" /> <span className="hidden sm:inline">课程目录</span>
        </button>
        <div className="relative">
          <button
            onClick={() => setShowMenu((v) => !v)}
            title="课堂设置"
            className="flex items-center gap-1.5 p-2 text-sm hover:bg-neutral-100"
          >
            <Settings className="h-4 w-4" /> <span className="hidden sm:inline">设置</span>
          </button>
          {showMenu && (
            <div className="absolute right-0 top-11 w-72 space-y-3 bg-white p-4 text-sm text-neutral-700 border border-neutral-200">
              <div className="flex items-center justify-between">
                <span>语音播放</span>
                <Toggle on={!muted} onChange={(v) => setMuted(!v)} label="语音播放" />
              </div>
              <div className="flex items-center justify-between">
                <span>语速</span>
                <div className="flex bg-neutral-100 p-0.5 text-xs">
                  {[1, 1.25, 1.5].map((r) => (
                    <button
                      key={r}
                      onClick={() => setRate(r)}
                      className={` px-2 py-1 ${rate === r ? "bg-white font-semibold text-neutral-800 " : ""}`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span>导师连续讲解</span>
                <Toggle on={autoContinue} onChange={setAutoContinue} label="导师连续讲解" />
              </div>
              <div className="border-t border-neutral-100 pt-3 text-xs">
                {!props.ttsAvailable && <p className="mb-2 text-neutral-800">未配置 Fish Audio，当前为纯文字模式。</p>}
                <Link href="/settings" className="block py-1 text-neutral-800 hover:underline">
                  模型与语音设置 →
                </Link>
                <Link href={`/papers/${paper.id}`} className="block py-1 text-neutral-800 hover:underline">
                  返回试卷解析 →
                </Link>
              </div>
            </div>
          )}
        </div>
      </header>

      <div
        role="tablist"
        aria-label="课堂视图"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const panel =
            e.key === "Home" ? "chat" : e.key === "End" ? "board" : mobilePanel === "chat" ? "board" : "chat";
          setMobilePanel(panel);
          document.getElementById(`${panel}-tab`)?.focus();
        }}
        className="flex shrink-0 border-b border-neutral-900 lg:hidden"
      >
        <button
          id="chat-tab"
          role="tab"
          tabIndex={mobilePanel === "chat" ? 0 : -1}
          aria-controls="chat-panel"
          aria-selected={mobilePanel === "chat"}
          onClick={() => setMobilePanel("chat")}
          className={`flex-1 border-r border-neutral-900 py-2.5 text-sm font-medium ${mobilePanel === "chat" ? "bg-neutral-900 text-white" : "bg-[#fafafa] text-neutral-900"}`}
        >
          对话
        </button>
        <button
          id="board-tab"
          role="tab"
          tabIndex={mobilePanel === "board" ? 0 : -1}
          aria-controls="board-panel"
          aria-selected={mobilePanel === "board"}
          onClick={() => setMobilePanel("board")}
          className={`flex-1 py-2.5 text-sm font-medium ${mobilePanel === "board" ? "bg-neutral-900 text-white" : "bg-[#fafafa] text-neutral-900"}`}
        >
          板书
        </button>
      </div>

      {/* ---------------- main ---------------- */}
      <main className="classroom-main">
        {/* chat */}
        <section
          id="chat-panel"
          aria-labelledby="chat-tab"
          className={`classroom-chat flex flex-col overflow-hidden bg-[#fafafa] ${mobilePanel !== "chat" ? "classroom-panel-hidden" : ""}`}
        >
          <div className="flex items-center gap-4 border-b border-neutral-200/60 bg-white/70 px-5 py-4">
            <div className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tutor.avatar} alt={tutor.name} className="h-16 w-16 object-cover border-2 border-neutral-100" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-serif text-lg font-semibold text-neutral-900">
                {tutor.name}
                {speakingNow && <VoiceBars />}
              </div>
              <div className="truncate text-sm text-neutral-500">{tutor.tags.join(" | ") || tutor.subject}</div>
            </div>
            <button
              onClick={() => setMuted((v) => !v)}
              className="p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
              title={muted ? "开启语音" : "静音"}
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
          </div>

          <button
            onClick={() => {
              setViewIdx(safeIdx);
              setOverlay((o) => (o === "problem" ? "none" : "problem"));
              setMobilePanel("board");
            }}
            className="mx-4 mt-3 flex items-center gap-2 bg-white px-3 py-2 text-left text-xs border border-neutral-200/70 transition hover:border-neutral-300"
          >
            <span className="shrink-0 bg-neutral-900 px-1.5 py-0.5 font-bold text-white">第 {current.number} 题</span>
            <span className="line-clamp-1 flex-1 text-neutral-600">{current.title || current.type}</span>
            <span className="shrink-0 text-neutral-800">{difficultyStars(current.difficulty)}</span>
            <span className="shrink-0 text-neutral-800">{overlay === "problem" ? "收起" : "查看题目"}</span>
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
                    <div className="h-px flex-1 bg-neutral-200" />
                    <span className="bg-white px-3 py-1 text-xs font-medium text-neutral-800 border border-neutral-100">
                      {m.content}
                    </span>
                    <div className="h-px flex-1 bg-neutral-200" />
                  </div>
                );
              }
              if (m.kind === "board") {
                return (
                  <div key={m.id} className="mt-1.5 flex justify-center">
                    <button
                      onClick={() => {
                        setViewIdx(m.problemIdx);
                        setMobilePanel("board");
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] text-neutral-500 hover:bg-white hover:text-neutral-800"
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
                  canReplay={props.ttsAvailable && !muted}
                  onReplay={replay}
                />
              );
            })}

            {session.status === "completed" && busy === "idle" && (
              <div className="fade-up mt-5 border-y-2 border-neutral-900 py-5 text-center">
                <Check className="mx-auto h-7 w-7 text-neutral-900" />
                <div className="mt-2 font-serif text-lg font-semibold text-neutral-900">整张试卷已学完</div>
                <div className="mt-2 text-xs text-neutral-600">板书笔记已整理，可导出复习。</div>
                <div className="mt-3 flex justify-center gap-2">
                  <button onClick={exportNotes} className="bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white">
                    导出笔记
                  </button>
                  <Link
                    href={`/papers/${paper.id}`}
                    className="bg-white px-4 py-1.5 text-xs text-neutral-800 border border-neutral-200"
                  >
                    返回试卷
                  </Link>
                </div>
              </div>
            )}

            {error && (
              <div className="fade-up mt-4 bg-neutral-100 p-3 text-xs text-neutral-800 border border-neutral-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="flex-1 break-all">{error}</span>
                </div>
                <div className="mt-2 flex gap-2 pl-6">
                  <button
                    onClick={() => {
                      setError(null);
                      void startTurn(retryRef.current);
                    }}
                    disabled={busy !== "idle"}
                    className="inline-flex items-center gap-1 bg-neutral-900 px-3 py-1 text-white disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" /> 重试
                  </button>
                  {/API Key/i.test(error) && (
                    <Link href="/settings" className="bg-white px-3 py-1 border border-neutral-200">
                      前往设置
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>

          {showTyping && (
            <div className="flex items-center gap-2 px-5 pb-1.5 text-xs text-neutral-500">
              <span className="flex gap-1">
                <i className="typing-dot" />
                <i className="typing-dot" />
                <i className="typing-dot" />
              </span>
              AI 正在{waitingTTS ? "输入" : "思考"}中…
            </div>
          )}
          {ttsError && (
            <div className="mx-4 mb-1.5 flex items-center gap-2 bg-neutral-100 px-3 py-1.5 text-[11px] text-neutral-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="line-clamp-2 flex-1">语音不可用：{ttsError}</span>
              <button onClick={() => setTtsError(null)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="border-t border-neutral-200/60 bg-white/70 p-3">
            <button
              onClick={() => send(GOODBYE_TEXT)}
              className="mb-2 flex w-full items-center justify-center gap-2 border border-neutral-900 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
            >
              <ArrowLeft className="h-4 w-4" /> {GOODBYE_TEXT}
            </button>
            <div className="thin-scroll mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {QUICK.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="shrink-0 bg-white px-3 py-1 text-xs text-neutral-600 border border-neutral-200 transition hover:bg-neutral-100 hover:text-neutral-800 hover:border-neutral-200"
                >
                  {q}
                </button>
              ))}
              {busy !== "idle" && (
                <button
                  onClick={stop}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 bg-neutral-100 px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                >
                  <Square className="h-3 w-3" /> 停止讲解
                </button>
              )}
            </div>
            <div className="border border-neutral-200 bg-white p-2 transition">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1 pb-2">
                  {attachments.map((a, i) => (
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a} alt="" className="h-16 w-16 object-cover border border-neutral-200" />
                      <button
                        onClick={() => setAttachments((as) => as.filter((_, j) => j !== i))}
                        className="absolute -right-1.5 -top-1.5 bg-neutral-700 p-0.5 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                aria-label="课堂消息"
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
                className="w-full resize-none bg-transparent px-2 py-1 text-sm text-neutral-700 outline-none placeholder:text-neutral-500"
              />
              <div className="flex items-center gap-1 px-1">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                  title="上传解题草稿图片"
                >
                  <Paperclip className="h-5 w-5" />
                </button>
                <button
                  onClick={() => camRef.current?.click()}
                  className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                  title="拍照上传"
                >
                  <ImageIcon className="h-5 w-5" />
                </button>
                <button
                  onClick={() => send("给我一点提示")}
                  className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                  title="请求提示"
                >
                  <Lightbulb className="h-5 w-5" />
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickImages} />
                <input
                  ref={camRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onPickImages}
                />
                <button
                  onClick={() => send(input, attachments)}
                  disabled={!input.trim() && !attachments.length}
                  title="发送消息"
                  className="ml-auto flex h-10 w-10 items-center justify-center bg-neutral-900 text-white transition hover:brightness-110 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* blackboard */}
        <section
          id="board-panel"
          aria-labelledby="board-tab"
          className={`classroom-board ${mobilePanel !== "board" ? "classroom-panel-hidden" : ""}`}
        >
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

      {returnState !== "hidden" && (
        <div className="shrink-0 border-t-2 border-neutral-900 bg-white p-3">
          {returnState === "ready" ? (
            <Link href="/" className="flex min-h-11 w-full items-center justify-center gap-2 bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700">
              <ArrowLeft className="h-4 w-4" /> 返回首页
            </Link>
          ) : (
            <button disabled className="flex min-h-11 w-full items-center justify-center gap-2 bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white opacity-40">
              <ArrowLeft className="h-4 w-4" /> 返回首页
            </button>
          )}
        </div>
      )}

      {/* ---------------- outline drawer ---------------- */}
      {showOutline && (
        <div className="fixed inset-0 z-40 bg-neutral-900/30" onClick={() => setShowOutline(false)}>
          <aside
            className="thin-scroll absolute right-0 top-0 h-full w-full max-w-sm overflow-y-auto bg-white p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-neutral-900">课程目录</h3>
                <p className="text-xs text-neutral-500">
                  已完成 {doneCount}/{problems.length} 题 · 点击可跳转到任意一题
                </p>
              </div>
              <button onClick={() => setShowOutline(false)} className="p-2 text-neutral-500 hover:bg-neutral-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden bg-neutral-100">
              <div
                className="h-full bg-neutral-900"
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
                    className={`flex w-full items-start gap-3  p-3 text-left border transition ${
                      isCur ? "bg-neutral-100 border-neutral-300" : "border-neutral-200 hover:bg-neutral-50"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center  text-xs ${
                        st === "done"
                          ? "bg-neutral-900 text-white"
                          : isCur
                            ? "bg-neutral-900 text-white"
                            : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      {st === "done" ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : isCur ? (
                        <Play className="h-3 w-3" />
                      ) : (
                        <Circle className="h-3 w-3" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-neutral-800">
                        第 {p.number} 题 <span className="font-normal text-neutral-500">{p.type}</span>
                      </div>
                      <div className="line-clamp-1 text-xs text-neutral-500">{p.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <span className="text-neutral-800">{difficultyStars(p.difficulty)}</span>
                        <span className={p.strategy === "student_first" ? "text-neutral-800" : "text-violet-600"}>
                          {strategyLabel(p.strategy)}
                        </span>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#171717]/70 p-4">
          <div className="w-full max-w-md overflow-hidden bg-white text-center">
            <div className="border-b-2 border-neutral-900 px-6 py-6 text-neutral-900">
              <div className="font-serif text-sm">AniLearn</div>
              <h2 className="mt-3 text-xl font-semibold">{paper.title}</h2>
              <div className="mt-2 text-sm text-neutral-600">
                共 {problems.length} 题 · {session.status === "completed" ? "已全部完成" : `当前第 ${safeIdx + 1} 题`}
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={tutor.avatar}
              alt={tutor.name}
              className="mx-auto mt-6 h-24 w-24 object-cover border border-neutral-300"
            />
            <div className="px-6 pb-7 pt-3">
              <div className="text-lg font-bold text-neutral-800">AI导师 · {tutor.name}</div>
              <p className="mt-2 text-sm text-neutral-500">“{tutor.greeting || "准备好了吗？我们开始上课吧！"}”</p>
              {!props.llmReady && (
                <div className="mt-4 bg-neutral-100 p-3 text-xs text-neutral-800">
                  尚未配置 AI 模型 API Key，请先
                  <Link href="/settings" className="mx-1 underline">
                    前往设置
                  </Link>
                  。
                </div>
              )}
              {!props.ttsAvailable && (
                <div className="mt-3 text-xs text-neutral-500">未配置 Fish Audio 语音，将以纯文字形式上课。</div>
              )}
              <button
                onClick={enter}
                className="mt-6 inline-flex items-center gap-2 bg-neutral-900 px-8 py-3 font-semibold text-white transition hover:brightness-110"
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
