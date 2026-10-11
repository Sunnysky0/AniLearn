"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Download, Maximize2, MessageCircle, MoreHorizontal, NotebookPen, Pause, Play, RotateCcw, Settings, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClassroomComposer } from "@/components/ClassroomComposer";
import { Markdown } from "@/components/Markdown";
import { Logo } from "@/components/AppHeader";
import { useChatAttachments } from "@/lib/client/chat-attachments";
import { useSpeechAudioController } from "@/lib/client/speech-audio";
import { revealTutorMessage } from "@/lib/client/tutor-playback";
import { tokenizeForReveal } from "@/lib/text";
import type { BoardBlock, FreeMessageDTO, FreeSessionDTO, FreeTopicDTO, FreeTurnAction, FreeTurnEvent, FreeTurnRequest, TutorDTO } from "@/lib/types";

type PageResponse = {
  session: FreeSessionDTO; tutor: TutorDTO; topics: FreeTopicDTO[]; messages: FreeMessageDTO[];
  hasMoreMessages: boolean; oldestMessageId: number | null;
  moreTurns: { id: number; requestId: string; intent: string | null; status: string; topicId: number | null; requestedTopicId: number | null; action: string | null }[];
};
type PendingTurn = { payload: FreeTurnRequest; optimisticId?: number };

const SUGGESTIONS = ["继续讲解", "给我一点提示", "能举个例子吗？", "请再讲一遍"];
const toTitle = (text: string) => Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 32).join("") || "图片提问";
const imageUrl = (src: string) => src;
const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error("恢复图片失败，请重新附加图片后重试。"));
  reader.readAsDataURL(blob);
});

export default function FreeClassroom(props: PageResponse & { llmReady: boolean; ttsReady: boolean; autoContinueDefault: boolean }) {
  const router = useRouter();
  const [session, setSession] = useState(props.session);
  const sessionRef = useRef(session);
  const [topics, setTopics] = useState(props.topics);
  const [messages, setMessages] = useState(props.messages);
  const [input, setInput] = useState("");
  const {
    images, processing: attachmentsProcessing, error: attachmentError,
    addFiles: addAttachments, removeImage: removeAttachment, clearImages: clearAttachments,
    clearError: clearAttachmentError,
  } = useChatAttachments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncRequired, setSyncRequired] = useState(false);
  const [lastRequest, setLastRequest] = useState<PendingTurn | null>(null);
  const [muted, setMuted] = useState(!props.ttsReady);
  const [autoContinue, setAutoContinue] = useState(props.autoContinueDefault);
  const [mobilePanel, setMobilePanel] = useState<"chat" | "board">("chat");
  const [viewTopicId, setViewTopicId] = useState<number | null>(session.currentTopicId);
  const [typing, setTyping] = useState<{ id: number; shown: number | null } | null>(null);
  const [hasMore, setHasMore] = useState(props.hasMoreMessages);
  const [loadingMore, setLoadingMore] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [returnReady, setReturnReady] = useState(false);
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title || `与${props.tutor.name}自由提问`);
  const [moreBusy, setMoreBusy] = useState(false);
  const autoRef = useRef(autoContinue);
  const autoCountRef = useRef(0);
  const mutedRef = useRef(muted);
  const rateRef = useRef(1);
  const requestRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingTurn[]>([]);
  const runningRef = useRef(false);
  const disposedRef = useRef(false);
  const greetingStartedRef = useRef(false);
  const returningRef = useRef(false);
  const interruptPlaybackRef = useRef(false);
  const optimisticIdRef = useRef(-1);
  const { controllerRef: speechAudioRef, getController: getSpeechAudio } = useSpeechAudioController();
  const chatListRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const preserveScrollRef = useRef<{ top: number; height: number } | null>(null);
  const scrollPinnedRef = useRef(true);
  const changedTopicRef = useRef(false);

  const currentTopic = topics.find((topic) => topic.id === session.currentTopicId) ?? null;
  const viewedTopic = topics.find((topic) => topic.id === viewTopicId) ?? null;
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { autoRef.current = autoContinue; }, [autoContinue]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { getSpeechAudio().setEnabled(props.ttsReady && !muted); }, [getSpeechAudio, muted, props.ttsReady]);

  useEffect(() => {
    const update = () => setDesktop(window.matchMedia("(min-width: 1024px)").matches);
    update();
    window.addEventListener("resize", update);
    const element = boardRef.current;
    const fullscreenChange = () => setFullscreen(document.fullscreenElement === element);
    document.addEventListener("fullscreenchange", fullscreenChange);
    return () => { window.removeEventListener("resize", update); document.removeEventListener("fullscreenchange", fullscreenChange); };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      pendingRef.current = [];
      requestRef.current?.abort();
      playbackRef.current?.abort();
      getSpeechAudio().cancelPending();
      speechAudioRef.current?.dispose();
      speechAudioRef.current = null;
    };
  }, [getSpeechAudio, speechAudioRef]);

  useEffect(() => {
    const list = chatListRef.current;
    const previous = preserveScrollRef.current;
    if (list && previous) {
      list.scrollTop = previous.top + list.scrollHeight - previous.height;
      preserveScrollRef.current = null;
    } else if (list && scrollPinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [messages.length, typing?.id, typing?.shown]);

  const appendMessage = useCallback((message: FreeMessageDTO) => {
    setMessages((all) => {
      if (all.some((item) => item.id === message.id)) return all;
      return [...all, message];
    });
  }, []);

  const playMessage = useCallback(async (message: FreeMessageDTO) => {
    if (interruptPlaybackRef.current || disposedRef.current) {
      setTyping(null);
      return;
    }
    const controller = new AbortController();
    playbackRef.current = controller;
    await revealTutorMessage({
      text: message.content, speech: message.speech, voiceId: props.tutor.voiceId,
      audio: getSpeechAudio(), cacheKey: "free:" + message.sessionId + ":" + message.id,
      muted: () => mutedRef.current, rate: () => rateRef.current, signal: controller.signal,
      onReveal: (shown) => { if (!disposedRef.current) setTyping({ id: message.id, shown }); },
    });
    if (playbackRef.current === controller) playbackRef.current = null;
    if (!disposedRef.current) setTyping(null);
  }, [getSpeechAudio, props.tutor.voiceId]);

  const applyEvent = useCallback(async (event: FreeTurnEvent, optimisticId?: number) => {
    if (event.type === "user") {
      setMessages((all) => {
        const withoutOptimistic = optimisticId === undefined ? all : all.filter((message) => message.id !== optimisticId);
        return withoutOptimistic.some((message) => message.id === event.message.id) ? withoutOptimistic : [...withoutOptimistic, event.message];
      });
      return;
    }
    if (event.type === "topic") {
      setTopics((all) => all.some((topic) => topic.id === event.topic.id) ? all.map((topic) => topic.id === event.topic.id ? event.topic : topic) : [...all, event.topic].sort((a, b) => a.idx - b.idx));
      if (event.current === false) return;
      setSession((current) => {
        const latestUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const next = { ...current, currentTopicId: event.topic.id, title: current.title || (latestUser ? toTitle(latestUser) : "") };
        sessionRef.current = next;
        return next;
      });
      if (!changedTopicRef.current) setViewTopicId(event.topic.id);
      return;
    }
    if (event.type === "message") {
      appendMessage(event.message);
      if (event.message.kind === "text" || event.message.kind === "feedback") await playMessage(event.message);
      return;
    }
    if (event.type === "board") {
      setTopics((all) => all.map((topic) => topic.id === event.topic.id ? event.topic : topic));
      appendMessage(event.message);
      if (!changedTopicRef.current) setViewTopicId(event.topic.id);
      return;
    }
    if (event.type === "error") throw new Error(event.error);
  }, [appendMessage, messages, playMessage]);

  const applyEventRef = useRef(applyEvent);
  const runQueueRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { applyEventRef.current = applyEvent; }, [applyEvent]);

  const enqueueTurn = useCallback((payload: FreeTurnRequest, optimisticId?: number) => {
    pendingRef.current.push({ payload, optimisticId });
    setReturnReady(false);
    returningRef.current = false;
    if (runningRef.current) {
      interruptPlaybackRef.current = true;
      getSpeechAudio().cancelPending();
      playbackRef.current?.abort();
      requestRef.current?.abort();
    }
    void runQueueRef.current();
  }, [getSpeechAudio]);

  const runQueue = useCallback(async () => {
    if (runningRef.current || disposedRef.current) return;
    runningRef.current = true;
    setBusy(true);
    try {
      while (pendingRef.current.length && !disposedRef.current) {
        const next = pendingRef.current.shift()!;
        getSpeechAudio().cancelPending();
        interruptPlaybackRef.current = false;
        setError("");
        setLastRequest(next);
        returningRef.current = next.payload.intent === "goodbye";
        const controller = new AbortController();
        requestRef.current = controller;
        const playbackQueue: FreeTurnEvent[] = [];
        let queuePump: Promise<void> = Promise.resolve();
        let queueError: unknown;
        const appendToPlaybackQueue = (event: FreeTurnEvent) => {
          playbackQueue.push(event);
          queuePump = queuePump.then(async () => {
            const queued = playbackQueue.shift();
            if (queued && !queueError && !disposedRef.current) {
              try { await applyEventRef.current(queued, next.optimisticId); }
              catch (cause) { queueError = cause; }
            }
          });
        };
        let doneAction: FreeTurnAction | null = null;
        let normalEof = false;
        try {
          const body = JSON.stringify(next.payload);
          let response = await fetch(`/api/free-sessions/${sessionRef.current.id}/turn`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal,
          });
          for (let attempt = 0; response.status === 409 && attempt < 8 && !controller.signal.aborted; attempt++) {
            const conflict = await response.clone().json().catch(() => null);
            if (conflict?.error && !/正在回复|正在回复，请稍候重试/.test(conflict.error)) throw new Error(conflict.error);
            await new Promise((resolve) => setTimeout(resolve, 250));
            response = await fetch(`/api/free-sessions/${sessionRef.current.id}/turn`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal,
            });
          }
          if (!response.ok || !response.body) {
            const data = await response.json().catch(() => null);
            throw new Error(data?.error || `请求失败 (${response.status})`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const acceptLine = (line: string) => {
            if (!line.trim()) return;
            const event = JSON.parse(line) as FreeTurnEvent;
            if (event.requestId !== next.payload.requestId) throw new Error("回复编号与当前请求不匹配，请重试。");
            if (event.type === "done") {
              if (doneAction) throw new Error("导师回复包含重复结束事件。");
              doneAction = event.action;
            }
            if (event.type === "message" && event.message.role === "tutor" &&
              (event.message.kind === "text" || event.message.kind === "feedback") &&
              event.message.language === "zh-CN" && event.message.speech && props.ttsReady) {
              getSpeechAudio().prefetch({
                key: "free:" + event.message.sessionId + ":" + event.message.id,
                text: event.message.speech,
                voiceId: props.tutor.voiceId,
              }, controller.signal);
            }
            appendToPlaybackQueue(event);
          };
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); normalEof = true; break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              acceptLine(line);
            }
          }
          if (buffer.trim()) acceptLine(buffer);
          await queuePump;
          if (queueError) throw queueError;
          if (!normalEof || !doneAction) throw new Error("导师回复提前结束，请重试。");
          if (returningRef.current && !pendingRef.current.length && !controller.signal.aborted) setReturnReady(true);
          if (doneAction === "continue" && autoRef.current && autoCountRef.current < 6 && !pendingRef.current.length && !controller.signal.aborted) {
            autoCountRef.current++;
            pendingRef.current.push({ payload: { requestId: crypto.randomUUID(), intent: "continue", topicId: sessionRef.current.currentTopicId } });
          }
          setLastRequest((current) => current?.payload.requestId === next.payload.requestId ? null : current);
        } catch (cause) {
          if (!controller.signal.aborted && !disposedRef.current) {
            const message = cause instanceof Error ? cause.message : "课堂请求失败，请重试。";
            setError(message);
            if (/当前话题已变化/.test(message)) setSyncRequired(true);
          }
          if (controller.signal.aborted && !disposedRef.current) setError("本轮已停止。已保存内容保留在对话中，可以重试或继续提问。");
          try { await queuePump; } catch { /* Retry replays any persisted messages from this turn. */ }
        } finally {
          if (requestRef.current === controller) requestRef.current = null;
          if (returningRef.current && (controller.signal.aborted || !normalEof)) setReturnReady(false);
          returningRef.current = false;
        }
      }
    } finally {
      runningRef.current = false;
      if (!disposedRef.current) setBusy(false);
    }
  }, [getSpeechAudio, props.ttsReady, props.tutor.voiceId]);
  useEffect(() => { runQueueRef.current = runQueue; }, [runQueue]);

  useEffect(() => {
    if (!props.llmReady || greetingStartedRef.current) return;
    const greeting = props.moreTurns.find((turn) => turn.requestId === props.session.welcomeRequestId);
    if (greeting?.status === "success") return;
    const payload: FreeTurnRequest = { requestId: props.session.welcomeRequestId, intent: "greeting" };
    if (greeting) return;
    const timer = window.setTimeout(() => {
      if (greetingStartedRef.current) return;
      greetingStartedRef.current = true;
      enqueueTurn(payload);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [enqueueTurn, props.llmReady, props.moreTurns, props.session.welcomeRequestId]);

  const makeOptimistic = useCallback((text: string, attachments: string[]) => {
    const id = optimisticIdRef.current--;
    const message: FreeMessageDTO = {
      id, sessionId: sessionRef.current.id, turnId: null, topicId: sessionRef.current.currentTopicId,
      role: "user", kind: "text", language: "zh-CN", content: text, speech: "", boardMode: null,
      attachments, attachmentCount: attachments.length, createdAt: new Date().toISOString(),
    };
    setMessages((all) => [...all, message]);
    return id;
  }, []);

  const welcomeNeedsRetry = props.moreTurns.some((turn) => turn.requestId === props.session.welcomeRequestId && turn.status !== "success");
  const recoverableTurn = [...props.moreTurns].reverse().find((turn) => ["failed", "cancelled", "running"].includes(turn.status) && turn.intent !== "greeting");

  const retrySavedTurn = useCallback(async (turn: PageResponse["moreTurns"][number]) => {
    setError("");
    setMoreBusy(true);
    try {
      const response = await fetch(`/api/free-sessions/${session.id}/messages?turn=${turn.id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法恢复上次提问。");
      const user = (data.messages as FreeMessageDTO[]).find((message) => message.role === "user");
      const restoredImages = await Promise.all((user?.attachments ?? []).map(async (url) => {
        const imageResponse = await fetch(url, { cache: "no-store" });
        if (!imageResponse.ok) throw new Error("恢复图片失败，请重新附加图片后重试。");
        return blobToDataUrl(await imageResponse.blob());
      }));
      const intent = turn.intent === "continue" || turn.intent === "goodbye" ? turn.intent : undefined;
      const payload: FreeTurnRequest = {
        requestId: turn.requestId, intent, text: user?.content ?? "", images: restoredImages,
        topicId: turn.requestedTopicId,
      };
      const pending = { payload };
      setLastRequest(pending);
      enqueueTurn(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法恢复上次提问。");
    } finally { setMoreBusy(false); }
  }, [enqueueTurn, session.id]);

  const send = useCallback((text = input, attachmentList = images, clearDraft = true): boolean => {
    const clean = text.trim();
    if (!clean && !attachmentList.length) return false;
    autoCountRef.current = 0;
    const failedRequest = lastRequest ?? (welcomeNeedsRetry ? { payload: { requestId: props.session.welcomeRequestId, intent: "greeting" as const } } : null);
    if (failedRequest && error && !pendingRef.current.some((item) => item.payload.requestId === failedRequest.payload.requestId)) {
      pendingRef.current.push(failedRequest);
    }
    const optimisticId = makeOptimistic(clean, attachmentList);
    const payload: FreeTurnRequest = {
      requestId: crypto.randomUUID(), text: clean, images: attachmentList,
      topicId: sessionRef.current.currentTopicId,
    };
    if (!sessionRef.current.title) {
      const next = { ...sessionRef.current, title: toTitle(clean || "图片提问") };
      sessionRef.current = next;
      setSession(next);
    }
    enqueueTurn(payload, optimisticId);
    if (clearDraft) {
      setInput("");
      clearAttachments();
    }
    setError("");
    return true;
  }, [clearAttachments, enqueueTurn, error, images, input, lastRequest, makeOptimistic, props.session.welcomeRequestId, welcomeNeedsRetry]);

  const retry = useCallback(() => {
    const request = lastRequest ?? (welcomeNeedsRetry ? { payload: { requestId: props.session.welcomeRequestId, intent: "greeting" as const } } : null);
    if (!request) return;
    setError("");
    setSyncRequired(false);
    enqueueTurn(request.payload, request.optimisticId);
  }, [enqueueTurn, lastRequest, props.session.welcomeRequestId, welcomeNeedsRetry]);

  const syncClassroom = useCallback(async () => {
    setMoreBusy(true);
    try {
      const response = await fetch(`/api/free-sessions/${session.id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "同步课堂失败。");
      sessionRef.current = data.session;
      setSession(data.session);
      setTopics(data.topics);
      setMessages((all) => {
        const byId = new Map(all.map((message) => [message.id, message]));
        for (const message of data.messages as FreeMessageDTO[]) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => a.id - b.id);
      });
      if (lastRequest && !data.moreTurns.some((turn: PageResponse["moreTurns"][number]) => turn.requestId === lastRequest.payload.requestId)) {
        const payload = { ...lastRequest.payload, topicId: data.session.currentTopicId };
        setLastRequest({ ...lastRequest, payload });
      }
      setSyncRequired(false);
      setError("课堂已同步。保留的提问可以重试，或返回当前话题后继续。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "同步课堂失败。"); }
    finally { setMoreBusy(false); }
  }, [lastRequest, session.id]);

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    interruptPlaybackRef.current = true;
    getSpeechAudio().cancelPending();
    playbackRef.current?.abort();
    requestRef.current?.abort();
    setReturnReady(false);
  }, [getSpeechAudio]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[0]?.id;
    if (!oldest || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      if (chatListRef.current) preserveScrollRef.current = { top: chatListRef.current.scrollTop, height: chatListRef.current.scrollHeight };
      const response = await fetch(`/api/free-sessions/${session.id}/messages?before=${oldest}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取更早的消息。");
      setMessages((all) => [...data.messages.filter((message: FreeMessageDTO) => !all.some((item) => item.id === message.id)), ...all]);
      setHasMore(data.hasMore);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取更早的消息。"); }
    finally { setLoadingMore(false); }
  }, [hasMore, loadingMore, messages, session.id]);

  const switchTopic = useCallback(async (topic: FreeTopicDTO, makeCurrent = false) => {
    setViewTopicId(topic.id);
    setTopicMenuOpen(false);
    changedTopicRef.current = !makeCurrent;
    if (!makeCurrent) return;
    if (runningRef.current) { setError("导师正在回复，稍候再继续这个话题。"); return; }
    try {
      const response = await fetch(`/api/free-sessions/${session.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: topic.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "切换话题失败。");
      setSession(data); sessionRef.current = data; setViewTopicId(topic.id); changedTopicRef.current = false; setReturnReady(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "切换话题失败。"); }
  }, [session.id]);

  const rename = useCallback(async () => {
    if (!renameValue.trim()) return;
    setMoreBusy(true);
    try {
      const response = await fetch(`/api/free-sessions/${session.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: renameValue.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "重命名失败。");
      setSession(data); sessionRef.current = data; setRenameOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重命名失败。"); }
    finally { setMoreBusy(false); }
  }, [renameValue, session.id]);

  const deleteSession = useCallback(async () => {
    if (!window.confirm("删除这次自由提问？对话、话题和板书都会一起删除。")) return;
    setMoreBusy(true);
    try {
      const response = await fetch(`/api/free-sessions/${session.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败。");
      router.push("/free");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败。"); }
    finally { setMoreBusy(false); }
  }, [router, session.id]);

  const toggleFullscreen = useCallback(async () => {
    if (!boardRef.current) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await boardRef.current.requestFullscreen();
    } catch { setError("当前浏览器不支持全屏黑板。"); }
  }, []);

  const visibleText = (message: FreeMessageDTO) => {
    if (typing?.id !== message.id || typing.shown === null) return message.content;
    return tokenizeForReveal(message.content).slice(0, typing.shown).join("");
  };

  const currentViewedIndex = topics.findIndex((topic) => topic.id === viewTopicId);
  const viewPrev = () => { const topic = topics[currentViewedIndex - 1]; if (topic) void switchTopic(topic); };
  const viewNext = () => { const topic = topics[currentViewedIndex + 1]; if (topic) void switchTopic(topic); };
  const currentTitle = session.title || `与${props.tutor.name}自由提问`;

  const renderMessage = (message: FreeMessageDTO) => {
    const mine = message.role === "user";
    const shown = visibleText(message);
    if (message.kind === "board") return (
      <div key={message.id} className="my-4 border-y border-[#c8c8c8] py-2 text-xs text-[#626262]">
        <NotebookPen className="mr-2 inline h-3.5 w-3.5" />{message.boardMode === "replace" ? "更新了黑板" : "写下了黑板笔记"}
      </div>
    );
    const foreign = message.kind === "quote" || message.kind === "example" || message.kind === "exercise";
    return (
      <article key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div className={`max-w-[92%] border px-3.5 py-3 sm:max-w-[88%] ${mine ? "border-[#171717] bg-[#171717] text-white" : foreign ? "border-[#a3a3a3] bg-[#eeeeee]" : "border-[#c8c8c8] bg-white"}`}>
          {!mine && <div className="mb-1.5 text-[11px] font-semibold text-[#626262]">{foreign ? `${message.kind === "quote" ? "原文引用" : message.kind === "example" ? "外语例句" : "外语练习"} · ${message.language === "ja" ? "日语" : "英语"}` : props.tutor.name}</div>}
          {message.content && <Markdown content={shown} className="md text-[15px] leading-7" />}
          {message.attachmentCount > 0 && <div className="mt-2 flex flex-wrap gap-2">{message.attachments.length ? message.attachments.map((src, index) => <a href={imageUrl(src)} target="_blank" rel="noreferrer" key={`${message.id}-${index}`}><Image src={imageUrl(src)} width={320} height={260} unoptimized alt={`提问图片 ${index + 1}`} className="max-h-52 max-w-48 border border-current/30 object-contain" /></a>) : <a href={`/api/free-sessions/${message.sessionId}/messages/${message.id}/attachments/0`} target="_blank" rel="noreferrer" className="text-xs underline">查看附带的 {message.attachmentCount} 张图片</a>}</div>}
          <div className={`mt-1.5 text-right text-[10px] ${mine ? "text-white/60" : "text-[#8a8a8a]"}`}>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      </article>
    );
  };

  const renderComposer = () => (
    <ClassroomComposer
      value={input}
      onValueChange={setInput}
      images={images}
      onRemoveImage={removeAttachment}
      onAddImages={addAttachments}
      imageProcessing={attachmentsProcessing}
      attachmentError={attachmentError}
      onClearAttachmentError={clearAttachmentError}
      canSend={props.llmReady}
      busy={busy}
      placeholder="问任何问题；Enter 发送，Shift+Enter 换行"
      quickActions={(messages.length ? SUGGESTIONS : []).map((suggestion) => ({
        label: suggestion,
        onSelect: () => suggestion === "继续讲解"
          ? (autoCountRef.current = 0, enqueueTurn({ requestId: crypto.randomUUID(), intent: "continue", topicId: session.currentTopicId }))
          : send(suggestion, [], false),
      }))}
      onHint={() => send("给我一点提示", [], false)}
      onSend={(text, attachments) => send(text, attachments)}
      onStop={stop}
    />
  );

  return (
    <main className="classroom-shell flex flex-col bg-[#fafafa]">
      <header className="z-20 flex min-h-14 items-center gap-3 border-b-2 border-[#171717] px-3 sm:px-5">
        <Link href="/free" aria-label="返回自由提问" className="p-1.5 hover:bg-[#eeeeee]"><ArrowLeft className="h-5 w-5" /></Link>
        <Logo className="h-7 w-7 shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-2"><span className="text-[10px] uppercase tracking-[0.14em] text-[#626262]">自由提问</span><span className="hidden text-[#a3a3a3] sm:inline">/</span><span className="hidden truncate text-xs text-[#626262] sm:inline">{props.tutor.name}</span></div>
          <h1 className="truncate text-sm font-semibold sm:text-base">{currentTitle}</h1>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <button onClick={() => setMuted((value) => !value)} disabled={!props.ttsReady} className="paper-button !px-2.5 !py-2 text-xs disabled:cursor-default disabled:opacity-60" title={!props.ttsReady ? "未配置日语语音" : muted ? "开启日语语音" : "静音"}>{muted || !props.ttsReady ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}{props.ttsReady ? muted ? "静音" : "语音" : "纯文字"}</button>
          <label className="flex items-center gap-1.5 text-xs text-[#626262]"><input type="checkbox" checked={autoContinue} onChange={(event) => setAutoContinue(event.target.checked)} />连续讲解</label>
          <Link href="/settings" title="设置" className="p-2 text-[#626262] hover:text-black"><Settings className="h-4 w-4" /></Link>
        </div>
        <details className="relative sm:hidden"><summary aria-label="课堂设置" className="list-none p-2"><MoreHorizontal className="h-5 w-5" /></summary><div className="absolute right-0 top-full z-50 mt-2 w-52 border border-[#171717] bg-[#fafafa] p-3 shadow-lg">
          <button onClick={() => setMuted((value) => !value)} disabled={!props.ttsReady} className="flex w-full items-center gap-2 py-2 text-left text-sm disabled:cursor-default disabled:opacity-60">{muted || !props.ttsReady ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}{props.ttsReady ? muted ? "开启日语语音" : "静音" : "纯文字（未配置语音）"}</button>
          <label className="flex items-center gap-2 border-t border-[#c8c8c8] py-2 text-sm"><input type="checkbox" checked={autoContinue} onChange={(event) => setAutoContinue(event.target.checked)} />连续讲解</label>
          <Link href="/settings" className="flex items-center gap-2 border-t border-[#c8c8c8] py-2 text-sm"><Settings className="h-4 w-4" />语音与模型设置</Link>
        </div></details>
      </header>

      {!props.llmReady && <div className="border-b border-[#b45309] bg-[#fff7ed] px-4 py-2 text-sm">尚未配置讲解模型。<Link href="/settings" className="ml-1 underline">前往设置</Link></div>}
      <div className="flex border-b border-[#c8c8c8] lg:hidden">
        <button onClick={() => setMobilePanel("chat")} className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-2.5 text-sm ${mobilePanel === "chat" ? "border-[#171717] font-semibold" : "border-transparent text-[#626262]"}`}><MessageCircle className="h-4 w-4" />对话</button>
        <button onClick={() => setMobilePanel("board")} className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-2.5 text-sm ${mobilePanel === "board" ? "border-[#171717] font-semibold" : "border-transparent text-[#626262]"}`}><BookOpen className="h-4 w-4" />黑板</button>
      </div>

      <div className="classroom-main !flex-1 !grid-cols-1 min-h-0 lg:!grid-cols-[minmax(340px,38%)_minmax(0,1fr)]">
        <section className={`classroom-chat flex min-w-0 flex-col ${!desktop && mobilePanel !== "chat" ? "classroom-panel-hidden" : ""}`}>
          <div className="flex min-h-11 items-center justify-between gap-2 border-b border-[#c8c8c8] px-3 text-xs">
            <div className="flex min-w-0 items-center gap-2"><Image src={props.tutor.avatar} width={28} height={28} alt="" className="h-7 w-7 border border-[#c8c8c8] object-cover" /><span className="truncate font-semibold">与 {props.tutor.name} 对话</span></div>
            <div className="flex items-center gap-1">
              <button className="paper-button !gap-1 !px-2 !py-1.5 text-xs" onClick={() => { setRenameValue(session.title || `与${props.tutor.name}自由提问`); setRenameOpen(true); }} title="重命名课堂"><span className="hidden sm:inline">重命名</span><ChevronDown className="h-3.5 w-3.5" /></button>
              <button className="p-1.5 text-[#626262] hover:text-red-700" onClick={() => void deleteSession()} disabled={moreBusy} title="删除课堂"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
          {renameOpen && <form onSubmit={(event) => { event.preventDefault(); void rename(); }} className="flex gap-2 border-b border-[#c8c8c8] bg-[#eeeeee] p-2">
            <input value={renameValue} maxLength={80} autoFocus onChange={(event) => setRenameValue(event.target.value)} className="flex-1 border border-[#a3a3a3] bg-white px-2 py-1.5 text-sm" aria-label="课堂名称" />
            <button disabled={moreBusy} className="ink-button !px-3 !py-1.5 text-xs">保存</button><button type="button" onClick={() => setRenameOpen(false)} className="paper-button !px-2 !py-1.5 text-xs">取消</button>
          </form>}
          <div ref={chatListRef} onScroll={(event) => {
            const element = event.currentTarget;
            scrollPinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          }} className="thin-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4">
            {hasMore && <button onClick={() => void loadOlder()} disabled={loadingMore} className="paper-button mx-auto !py-1.5 text-xs">{loadingMore ? "正在读取…" : "加载更早的对话"}</button>}
            {messages.map(renderMessage)}
            {busy && !typing && <div className="flex items-center gap-2 text-sm text-[#626262]"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />导师正在思考</div>}
            {typing && <div className="flex items-center gap-2 text-[10px] text-[#777]"><span className="h-1.5 w-1.5 animate-pulse bg-[#171717]" />正在讲解</div>}
            {!busy && recoverableTurn && !lastRequest && <div className="flex items-center justify-between gap-2 border-l-2 border-[#b45309] bg-[#fff7ed] px-3 py-2 text-sm text-[#92400e]"><span>检测到上一轮没有完整结束，已保存的内容可以接着恢复。</span><button onClick={() => void retrySavedTurn(recoverableTurn)} disabled={moreBusy} className="shrink-0 font-semibold underline">{moreBusy ? "正在恢复…" : "恢复这一轮"}</button></div>}
            {welcomeNeedsRetry && !busy && !error && <div role="alert" className="flex items-center gap-2 border-l-2 border-[#b45309] bg-[#fff7ed] px-3 py-2 text-sm text-[#92400e]"><span className="flex-1">欢迎语尚未完成，已保存的课堂可以继续。</span><button onClick={retry} className="shrink-0 font-semibold underline">重试欢迎语</button></div>}
            {error && <div role="alert" className="flex items-start gap-2 border-l-2 border-[#b91c1c] bg-[#fef2f2] px-3 py-2 text-sm text-[#991b1b]"><span className="flex-1">{error}</span>{syncRequired ? <button onClick={() => void syncClassroom()} disabled={moreBusy} className="shrink-0 font-semibold underline">同步课堂</button> : (lastRequest || welcomeNeedsRetry) ? <button onClick={retry} className="shrink-0 font-semibold underline">重试</button> : null}</div>}
          </div>
          {returnReady ? <div className="flex items-center justify-between border-t border-[#171717] bg-[#eeeeee] px-4 py-3"><span className="text-sm">本次交流已结束，内容已经保存。</span><Link href="/" className="ink-button !py-2 text-sm">返回首页 <ArrowRight className="h-4 w-4" /></Link></div> : <div>{!busy && <div className="flex justify-end px-3 pt-2 sm:px-4"><button onClick={() => { autoCountRef.current = 0; enqueueTurn({ requestId: crypto.randomUUID(), intent: "goodbye", topicId: session.currentTopicId }); }} disabled={!props.llmReady} className="text-xs text-[#626262] underline underline-offset-2 hover:text-black">结束本次交流</button></div>}{renderComposer()}</div>}
        </section>

        <section ref={boardRef} className={`classroom-board chalkboard flex min-w-0 flex-col ${!desktop && mobilePanel !== "board" ? "classroom-panel-hidden" : ""}`}>
          <div className="flex min-h-12 items-center gap-2 border-b border-[#525252] px-3 sm:px-5">
            <BookOpen className="h-4 w-4 shrink-0" />
            <div className="relative min-w-0 flex-1">
              <button onClick={() => setTopicMenuOpen((open) => !open)} className="flex max-w-full items-center gap-2 py-2 text-left text-sm font-semibold" aria-expanded={topicMenuOpen}>
                <span className="truncate">{viewedTopic?.title ?? "等待第一个问题"}</span><ChevronDown className="h-4 w-4 shrink-0" />
              </button>
              {topicMenuOpen && <div className="absolute left-0 top-full z-30 max-h-72 w-72 max-w-[85vw] overflow-y-auto border border-white/30 bg-[#222] shadow-xl">
                {topics.length ? topics.map((topic) => <button key={topic.id} onClick={() => void switchTopic(topic)} className={`block w-full border-b border-white/10 px-3 py-2.5 text-left text-sm hover:bg-white/10 ${topic.id === viewTopicId ? "bg-white/10" : ""}`}><span className="mr-2 text-xs text-white/50">{topic.idx + 1}</span>{topic.title}</button>) : <div className="px-3 py-3 text-sm text-white/60">提出问题后，导师会自动整理话题。</div>}
              </div>}
            </div>
            <button onClick={viewPrev} disabled={currentViewedIndex <= 0} title="上一话题" className="p-1.5 text-white/75 hover:text-white disabled:opacity-25"><ChevronLeft className="h-4 w-4" /></button>
            <span className="hidden text-xs text-white/55 sm:inline">{topics.length ? `${Math.max(1, currentViewedIndex + 1)} / ${topics.length}` : "0 / 0"}</span>
            <button onClick={viewNext} disabled={currentViewedIndex < 0 || currentViewedIndex >= topics.length - 1} title="下一话题" className="p-1.5 text-white/75 hover:text-white disabled:opacity-25"><ChevronRight className="h-4 w-4" /></button>
            <a href={`/api/free-sessions/${session.id}/notes`} title="导出全部笔记" className="p-1.5 text-white/75 hover:text-white"><Download className="h-4 w-4" /></a>
            <button onClick={() => void toggleFullscreen()} title={fullscreen ? "退出全屏" : "黑板全屏"} className="p-1.5 text-white/75 hover:text-white"><Maximize2 className="h-4 w-4" /></button>
          </div>
          {viewedTopic && viewedTopic.id !== session.currentTopicId && <div className="flex items-center justify-between gap-3 border-b border-white/20 bg-white/5 px-4 py-2 text-xs text-white/75">
            <span>正在查看历史话题</span><span className="flex items-center gap-3"><button onClick={() => { setViewTopicId(session.currentTopicId); changedTopicRef.current = false; }} className="underline">返回当前黑板</button><button onClick={() => void switchTopic(viewedTopic, true)} disabled={busy} className="border border-white/40 px-2 py-1 hover:bg-white/10 disabled:opacity-40">继续这个话题</button></span>
          </div>}
          {viewedTopic && viewedTopic.id === session.currentTopicId && viewTopicId !== session.currentTopicId && <div className="flex items-center justify-between gap-3 border-b border-white/20 bg-white/5 px-4 py-2 text-xs text-white/75"><span>新内容已写入当前话题</span><button onClick={() => { setViewTopicId(session.currentTopicId); changedTopicRef.current = false; }} className="underline">返回当前黑板</button></div>}
          <div className="chalk-scroll min-h-0 flex-1 overflow-y-auto p-4 sm:p-7 lg:p-9">
            {viewedTopic?.blocks?.length ? <div className="mx-auto max-w-4xl space-y-7">{viewedTopic.blocks.map((block: BoardBlock, index) => <article key={block.id} className="chalk chalk-in"><Markdown content={block.md} className="chalk" /><div className="mt-4 border-b border-dashed border-white/20 pb-1 text-right text-[10px] text-white/35">笔记 {index + 1}</div></article>)}</div> : <div className="flex h-full min-h-52 flex-col items-center justify-center text-center text-white/55"><div className="mb-4 border border-white/25 p-4"><BookOpen className="h-7 w-7" /></div><p className="font-serif text-xl">黑板会在对话中逐步形成</p><p className="mt-2 max-w-xs text-sm leading-6">定义、推导和结论会保存在对应话题下。追问时沿用当前页面，换题时自动新建页面。</p></div>}
          </div>
          {props.ttsReady && <div className="flex items-center justify-between border-t border-white/20 px-4 py-2 text-[11px] text-white/45"><span>中文讲解 · 日语配音</span><span>{autoContinue ? "连续讲解已开启" : "等待你继续"}</span></div>}
        </section>
      </div>
    </main>
  );
}
