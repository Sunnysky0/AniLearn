"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { BookOpen, Check, FileText, LogOut, MessageSquare, NotebookPen, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import type { BookDTO, BookSessionDTO, BookMessage, BookPersonalNote, BookTurnRequest, BookTurnEvent, ReaderDocument, ReaderAnchor, ReaderPosition, ReaderSelectionTask, TutorDTO } from "@/lib/types";
import Reader from "@/components/reader/Reader";
import ReadingWorkspace from "@/components/reader/ReadingWorkspace";
import { ClassroomComposer } from "@/components/ClassroomComposer";
import { Markdown } from "@/components/Markdown";
import { useChatAttachments } from "@/lib/client/chat-attachments";
import { useSpeechAudioController } from "@/lib/client/speech-audio";
import { revealTutorMessage } from "@/lib/client/tutor-playback";
import { tokenizeForReveal } from "@/lib/text";
import { anchorQuote } from "@/lib/reader/anchors";
import { currentReaderPosition } from "@/lib/reader/dom-selection";

const FOCI = { literary: [{ id: "content", label: "情节与人物" }, { id: "structure", label: "叙事结构" }, { id: "language", label: "语言手法" }, { id: "theme", label: "主题" }, { id: "emotion", label: "情感表达" }],
  thought: [{ id: "concepts", label: "核心概念" }, { id: "argument", label: "论证过程" }, { id: "implications", label: "思想推演" }],
  classical: [{ id: "words", label: "字词与句读" }, { id: "meaning", label: "句意与典故" }, { id: "ideas", label: "篇章义理" }] } as const;
type Progress = { status: string; completedChunks: number; totalChunks: number; running: boolean; resumable: boolean; error: string | null; summary?: string };
const EMPTY_PROGRESS: Progress = { status: "idle", completedChunks: 0, totalChunks: 0, running: false, resumable: false, error: null };
type Payload = { session: BookSessionDTO; book: BookDTO; document: ReaderDocument; tutor: TutorDTO; messages: BookMessage[]; notes: BookPersonalNote[] };

export default function BookClassroom(props: Payload & { llmReady: boolean; analysisReady: boolean; ttsReady: boolean }) {
  const { book, tutor } = props;
  const [session, setSession] = useState(props.session); const sessionRef = useRef(props.session);
  const [document, setDocument] = useState(props.document); const documentRef = useRef(props.document);
  const [messages, setMessages] = useState(props.messages);
  const [notes, setNotes] = useState(props.notes); const notesRef = useRef(props.notes);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(props.notes.map(note => [note.id, note.content])));
  const [tab, setTab] = useState<"source" | "notes" | "analysis" | "summary">("source");
  const [tutorOpen, setTutorOpen] = useState(false); const [inspectAnchor, setInspectAnchor] = useState<ReaderAnchor | null>(null); const inspectingRef = useRef(false);
  const [input, setInput] = useState(""); const [pendingAnchor, setPendingAnchor] = useState<ReaderAnchor | null>(null);
  const [attachedNotes, setAttachedNotes] = useState<number[]>([]);
  const [busy, setBusy] = useState(false); const [changing, setChanging] = useState(false); const [error, setError] = useState("");
  const [noteStatus, setNoteStatus] = useState("已保存"); const [noteErrors, setNoteErrors] = useState<Record<number, string>>({});
  const [analysis, setAnalysis] = useState<Progress>(EMPTY_PROGRESS); const [summaryProgress, setSummaryProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [muted, setMuted] = useState(!props.ttsReady); const mutedRef = useRef(!props.ttsReady);
  const [rate, setRate] = useState(1); const rateRef = useRef(1);
  const [typing, setTyping] = useState<{ id: number; shown: number | null } | null>(null);
  const [lastRequest, setLastRequest] = useState<BookTurnRequest | null>(null); const [canExit, setCanExit] = useState(false);
  const queue = useRef<BookTurnRequest[]>([]); const running = useRef(false); const disposed = useRef(false); const optimistic = useRef(-1);
  const request = useRef<AbortController | null>(null); const playback = useRef<AbortController | null>(null);
  const { controllerRef: speechAudioRef, getController: getSpeechAudio } = useSpeechAudioController();
  const chatEnd = useRef<HTMLDivElement>(null); const bookmarkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readerContainer = useRef<HTMLDivElement>(null);
  const bookmarkChain = useRef<Promise<void>>(Promise.resolve());
  const positionRef = useRef<ReaderPosition | null>(props.session.chapters.find(chapter => chapter.chapterId === props.document.unitId)?.position ?? null);
  const noteChains = useRef(new Map<string, Promise<void>>()); const notePending = useRef(new Map<string, string>());
  const annotationRetry = useRef<{ signature: string; clientId: string } | null>(null);

  const replaceSession = useCallback((next: BookSessionDTO) => { sessionRef.current = next; setSession(next); }, []);
  const replaceNotes = useCallback((next: BookPersonalNote[]) => { notesRef.current = next; setNotes(next); }, []);
  const state = session.chapters.find(chapter => chapter.chapterId === session.currentChapterId)!;
  const displayed = session.chapters.find(chapter => chapter.chapterId === document.unitId);
  const foci = FOCI[book.kind]; const currentFocus = foci.find(focus => focus.id === state.learning.currentFocus);
  const { images, processing: attachmentsProcessing, error: attachmentError, addFiles: addAttachments, removeImage: removeAttachment, clearImages: clearAttachments, clearError: clearAttachmentError } = useChatAttachments();

  useEffect(() => { mutedRef.current = muted; getSpeechAudio().setEnabled(props.ttsReady && !muted); }, [muted, props.ttsReady, getSpeechAudio]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }); }, [messages.length, typing]);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; queue.current = []; request.current?.abort(); playback.current?.abort();
      getSpeechAudio().cancelPending(); speechAudioRef.current?.dispose(); speechAudioRef.current = null; if (bookmarkTimer.current) clearTimeout(bookmarkTimer.current); };
  }, [getSpeechAudio, speechAudioRef]);

  useEffect(() => {
    if (state.learning.phase !== "chapter_analysis") return;
    let active = true; let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await fetch(`/api/book-sessions/${session.id}/analysis-status?chapterId=${encodeURIComponent(session.currentChapterId)}`, { cache: "no-store" }); const data = await response.json();
        if (!active || !response.ok) return; setAnalysis(data);
        if (data.learning) replaceSession({ ...sessionRef.current, chapters: sessionRef.current.chapters.map(chapter => chapter.chapterId === data.chapterId ? { ...chapter,
          learning: data.learning.stateRevision >= chapter.learning.stateRevision ? data.learning : chapter.learning,
          analysis: { ...chapter.analysis, status: data.status === "ready" ? "ready" : chapter.analysis.status } } : chapter) });
        if (data.running) timer = setTimeout(() => void poll(), 1300);
      } catch { if (active) timer = setTimeout(() => void poll(), 2300); }
    };
    void poll(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [session.id, session.currentChapterId, state.learning.phase, replaceSession]);
  useEffect(() => {
    if (tab !== "summary") return;
    let active = true; let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try { const response = await fetch(`/api/book-sessions/${session.id}/summary-status`, { cache: "no-store" }); const data = await response.json();
        if (!active || !response.ok) return; setSummaryProgress(data); if (data.status === "ready") replaceSession({ ...sessionRef.current, summary: data.summary });
        if (data.running) timer = setTimeout(() => void poll(), 1600);
      } catch { if (active) timer = setTimeout(() => void poll(), 2300); }
    };
    void poll(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [tab, session.id, summaryProgress.running, replaceSession]);

  async function api(path: string, body: unknown, method = "POST", signal?: AbortSignal) {
    const response = await fetch(`/api/book-sessions/${sessionRef.current.id}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试。"); return data;
  }
  function visibleReadingPosition() {
    const scroll = readerContainer.current?.querySelector<HTMLElement>("[aria-label='阅读正文']");
    return scroll && scroll.getBoundingClientRect().height > 0 ? currentReaderPosition(scroll, documentRef.current) : null;
  }
  async function savePosition(position: ReaderPosition, required = false, signal?: AbortSignal): Promise<void> {
    const save = async () => {
      signal?.throwIfAborted();
      if (disposed.current || position.unitId !== sessionRef.current.currentChapterId) {
        if (required) throw new Error("当前章节已变化，请重新提问。");
        return;
      }
      if (!required && (inspectingRef.current || positionRef.current !== position)) return;
      for (let attempt = 0; attempt < 4; attempt++) {
        signal?.throwIfAborted();
        if (!required && (disposed.current || positionRef.current !== position || inspectingRef.current)) return;
        const bookmarkSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
        const response = await fetch(`/api/book-sessions/${sessionRef.current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, signal: bookmarkSignal,
          body: JSON.stringify({ action: "bookmark", versionId: sessionRef.current.versionId, chapterId: position.unitId, position }) });
        const data = await response.json();
        if (response.ok) {
          if (positionRef.current === position) replaceSession({ ...sessionRef.current, chapters: sessionRef.current.chapters.map(chapter => chapter.chapterId === position.unitId ? { ...chapter, position: data.chapters.find((item: { chapterId: string }) => item.chapterId === position.unitId)?.position ?? position } : chapter) });
          return;
        }
        if (response.status !== 409 || attempt === 3) throw new Error(data.error || "阅读位置未保存，请重试提问。");
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("提问已取消。")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    };
    const queued = bookmarkChain.current.catch(() => undefined).then(save);
    bookmarkChain.current = queued;
    if (required && signal) await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("提问已取消。")); };
      signal.addEventListener("abort", abort, { once: true });
      void queued.then(() => { signal.removeEventListener("abort", abort); resolve(); }, cause => { signal.removeEventListener("abort", abort); reject(cause); });
      if (signal.aborted) abort();
    });
    else if (required) await queued;
    else await queued.catch(() => undefined);
  }
  async function flushBookmarkForTurn(next: BookTurnRequest, signal: AbortSignal) {
    if (next.phase !== "free_reading" || next.anchor || next.selectionTask || next.intent) return;
    if (!inspectingRef.current && documentRef.current.unitId === next.chapterId) {
      const visible = visibleReadingPosition();
      if (visible) positionRef.current = visible;
    }
    const position = positionRef.current;
    if (!position || position.unitId !== next.chapterId) return;
    if (bookmarkTimer.current) { clearTimeout(bookmarkTimer.current); bookmarkTimer.current = null; }
    await savePosition(position, true, signal);
  }
  async function changeChapter(chapterId: string, inspect = false) {
    if (changing) return;
    setChanging(true); setError("");
    try {
      if (!inspect && positionRef.current && positionRef.current.unitId === sessionRef.current.currentChapterId && !inspectingRef.current) await savePosition(positionRef.current);
      const response = inspect || chapterId === sessionRef.current.currentChapterId
        ? await fetch(`/api/book-sessions/${sessionRef.current.id}?chapterId=${encodeURIComponent(chapterId)}`, { cache: "no-store" }) : null;
      const data: Payload = response ? await response.json() : await api("", { action: "chapter", versionId: sessionRef.current.versionId, chapterId }, "PATCH");
      if (response && !response.ok) throw new Error((data as unknown as { error: string }).error || "无法加载章节。");
      documentRef.current = data.document; setDocument(data.document); setTab("source");
      if (!inspect) { replaceSession(data.session); setMessages(data.messages); setAttachedNotes([]); setPendingAnchor(null); setInspectAnchor(null); setAnalysis(EMPTY_PROGRESS); positionRef.current = data.session.chapters.find(chapter => chapter.chapterId === chapterId)?.position ?? null; }
      replaceNotes(data.notes); setDrafts(previous => ({ ...previous, ...Object.fromEntries(data.notes.filter(note => previous[note.id] === undefined).map(note => [note.id, note.content])) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "章节加载失败。"); }
    finally { setChanging(false); }
  }
  function onPosition(position: ReaderPosition) {
    if (inspectingRef.current) return;
    positionRef.current = position;
    if (position.unitId !== sessionRef.current.currentChapterId) {
      void api("", { action: "chapter", versionId: sessionRef.current.versionId, chapterId: position.unitId }, "PATCH").then((data: Payload) => { replaceSession(data.session); setMessages(data.messages); return savePosition(position); }).catch(cause => setError(cause.message));
      return;
    }
    if (bookmarkTimer.current) clearTimeout(bookmarkTimer.current);
    bookmarkTimer.current = setTimeout(() => void savePosition(position), 300);
  }
  async function inspectQuote(anchor: ReaderAnchor) {
    setInspectAnchor(anchor); setTab("source"); setTutorOpen(false);
  }
  function append(message: BookMessage) { setMessages(all => all.some(item => item.id === message.id) ? all : [...all, message]); }
  async function play(message: BookMessage) {
    if (message.language !== "zh-CN" || message.kind === "quote") return;
    const controller = new AbortController(); playback.current = controller;
    await revealTutorMessage({ text: message.content, speech: message.language === "zh-CN" ? message.speech : "", voiceId: tutor.voiceId,
      audio: getSpeechAudio(), cacheKey: `book:${sessionRef.current.id}:${message.id}`, muted: () => mutedRef.current, rate: () => rateRef.current, signal: controller.signal,
      onReveal: shown => { if (!disposed.current) setTyping({ id: message.id, shown }); } });
    if (playback.current === controller) playback.current = null; if (!disposed.current) setTyping(null);
  }
  function stop() { getSpeechAudio().cancelPending(); request.current?.abort(); playback.current?.abort(); setCanExit(false); }
  async function runQueue() {
    if (running.current || disposed.current) return; running.current = true; setBusy(true); setCanExit(false);
    try {
      while (queue.current.length && !disposed.current) {
        getSpeechAudio().cancelPending(); const next = queue.current.shift()!; setLastRequest(next); setError(""); const controller = new AbortController(); request.current = controller;
        const localId = optimistic.current--; let done: Extract<BookTurnEvent, { type: "done" }> | null = null;
        if (next.text || next.images?.length) append({ id: localId, role: "user", content: next.text ?? "", speech: "", chapterId: next.chapterId, kind: "text", language: "zh-CN", attachments: next.images ?? [], attachmentCount: next.images?.length ?? 0, phase: next.phase, focus: next.focus ?? null, anchor: next.anchor ?? null });
        try {
          await flushBookmarkForTurn(next, controller.signal);
          let response = await fetch(`/api/book-sessions/${sessionRef.current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next), signal: controller.signal });
          for (let attempt = 0; response.status === 409 && /上一轮仍在进行/.test((await response.clone().json().catch(() => ({}))).error ?? "") && attempt < 4 && !controller.signal.aborted; attempt++) { await new Promise(resolve => setTimeout(resolve, 250)); response = await fetch(`/api/book-sessions/${sessionRef.current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next), signal: controller.signal }); }
          if (!response.ok || !response.body) { const data = await response.json(); throw new Error(data.error || "导师回复失败。"); }
          const stream = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let processing = Promise.resolve(); let failure: unknown; let eof = false;
          const handle = async (event: BookTurnEvent) => {
            if (event.type === "error") throw new Error(event.error);
            if (event.type === "message") { if (event.message.role === "user") setMessages(all => [...all.filter(item => item.id !== localId && item.id !== event.message.id), event.message]); else { append(event.message); await play(event.message); } }
            else if (event.type === "analysis") replaceSession({ ...sessionRef.current, chapters: sessionRef.current.chapters.map(chapter => chapter.chapterId === event.chapter.chapterId ? event.chapter : chapter) });
            else if (event.type === "done") { done = event; replaceSession(event.session); }
          };
          const dispatch = (event: BookTurnEvent) => { if (event.type === "message" && event.message.role === "tutor" && event.message.language === "zh-CN" && event.message.speech && props.ttsReady && !mutedRef.current) getSpeechAudio().prefetch({ key: `book:${sessionRef.current.id}:${event.message.id}`, text: event.message.speech, voiceId: tutor.voiceId }, controller.signal);
            processing = processing.then(async () => { if (!failure && !controller.signal.aborted) await handle(event); }).catch(cause => { failure = cause; }); };
          for (;;) { const chunk = await stream.read(); if (chunk.done) { buffer += decoder.decode(); eof = true; break; } buffer += decoder.decode(chunk.value, { stream: true }); let end: number; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) dispatch(JSON.parse(line)); } }
          if (buffer.trim()) dispatch(JSON.parse(buffer)); await processing; if (failure) throw failure;
          const completed = done as Extract<BookTurnEvent, { type: "done" }> | null;
          if (!completed || !eof) throw new Error("课堂连接提前结束，请重试。");
          if (!controller.signal.aborted && completed.goodbye && !queue.current.length) setCanExit(true);
        } catch (cause) { if (!controller.signal.aborted && !disposed.current) setError(cause instanceof Error ? cause.message : "导师回复失败。"); }
        finally { if (request.current === controller) request.current = null; }
      }
    } finally { running.current = false; if (!disposed.current) setBusy(false); }
  }
  function enqueue(value: Partial<BookTurnRequest>) {
    const current = sessionRef.current; const chapter = current.chapters.find(item => item.chapterId === current.currentChapterId)!;
    const next: BookTurnRequest = { requestId: crypto.randomUUID(), versionId: current.versionId, chapterId: current.currentChapterId, phase: chapter.learning.phase, stateRevision: chapter.learning.stateRevision, focus: chapter.learning.currentFocus, ...value };
    queue.current.push(next); setLastRequest(next); setTutorOpen(true); if (running.current) stop(); void runQueue();
  }
  async function replayMessage(message: BookMessage) { if (running.current || mutedRef.current) return; running.current = true; setBusy(true); getSpeechAudio().retryFailed(`book:${sessionRef.current.id}:${message.id}`); try { await play(message); } finally { running.current = false; setBusy(false); void runQueue(); } }
  async function changeLearning(action: string, extra = {}) {
    setChanging(true); setError(""); try { const data = await api("", { action, versionId: sessionRef.current.versionId, chapterId: sessionRef.current.currentChapterId, stateRevision: state.learning.stateRevision, ...extra }, "PATCH"); replaceSession(data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败。"); } finally { setChanging(false); }
  }
  async function startAnalysis(resume = false) {
    setChanging(true); setError(""); try { const data = await api("/analysis", { action: resume ? "resume" : "start", requestId: crypto.randomUUID(), versionId: sessionRef.current.versionId, chapterId: sessionRef.current.currentChapterId, stateRevision: state.learning.stateRevision });
      if (data.learning) replaceSession({ ...sessionRef.current, chapters: sessionRef.current.chapters.map(chapter => chapter.chapterId === sessionRef.current.currentChapterId ? { ...chapter, learning: data.learning } : chapter) }); setAnalysis({ ...EMPTY_PROGRESS, status: data.status, running: data.status === "running" }); setTab("analysis");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导读准备失败。"); } finally { setChanging(false); }
  }
  async function startSummary(resume = false) { setChanging(true); setError(""); try { const data = await api("/summary", { action: resume ? "resume" : "start", requestId: crypto.randomUUID(), versionId: sessionRef.current.versionId }); setSummaryProgress({ ...EMPTY_PROGRESS, status: data.status, running: data.status === "running" }); if (data.summary) replaceSession({ ...sessionRef.current, summary: data.summary }); setTab("summary"); } catch (cause) { setError(cause instanceof Error ? cause.message : "全书总结失败。"); } finally { setChanging(false); } }
  function question(anchor: ReaderAnchor) { if (anchor.unitId !== sessionRef.current.currentChapterId) { setError("请先从这里继续阅读，再向导师提问。"); return; } setPendingAnchor(anchor); setInput("请结合我选中的原文回答：\n"); setTutorOpen(true); }
  function selectionTask(task: ReaderSelectionTask, anchor: ReaderAnchor) { if (anchor.unitId !== sessionRef.current.currentChapterId) { setError("请先从这里继续阅读，再向导师提问。"); return; } enqueue({ text: ({ vocabulary: "请解释我选中的词语在此处的含义和语境。", grammar: "请分析我选中句子的语法结构和关键用法。", meaning: "请用简洁中文说明我选中内容的句意。" })[task], selectionTask: task, anchor }); }
  async function annotate(anchor: ReaderAnchor, content: string) {
    const signature = JSON.stringify({ anchor, content }); if (annotationRetry.current?.signature !== signature) annotationRetry.current = { signature, clientId: crypto.randomUUID() };
    const note = await api("/notes", { kind: "annotation", versionId: sessionRef.current.versionId, chapterId: anchor.unitId, anchor, content, clientId: annotationRetry.current!.clientId });
    replaceNotes([...notesRef.current.filter(item => item.id !== note.id), note]); setDrafts(all => ({ ...all, [note.id]: note.content })); annotationRetry.current = null;
  }
  async function saveNotebook(kind: "chapter" | "book", content: string, chapterId: string) {
    const key = kind === "book" ? "book" : `chapter-${chapterId}`; notePending.current.set(key, content);
    const chain = (noteChains.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const next = notePending.current.get(key) ?? content; setNoteStatus("保存中…"); let note = notesRef.current.find(item => item.kind === kind && (kind === "book" || item.chapterId === chapterId));
      if (!note) { note = await api("/notes", { versionId: sessionRef.current.versionId, chapterId, kind, content: next, clientId: key }); replaceNotes([...notesRef.current.filter(item => item.id !== note!.id), note!]); }
      if (note!.content !== next) { const saved = await api(`/notes/${note!.id}`, { content: next, revision: note!.revision }, "PATCH"); replaceNotes(notesRef.current.map(item => item.id === saved.id ? saved : item)); }
      setNoteStatus("已保存");
    }).catch(cause => { setNoteStatus("保存失败 · 草稿已保留"); setError(cause.message); }); noteChains.current.set(key, chain); return chain;
  }
  async function saveEditedNote(note: BookPersonalNote, content: string) {
    const key = String(note.id); notePending.current.set(key, content);
    const chain = (noteChains.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const latest = notesRef.current.find(item => item.id === note.id); if (!latest) return;
      const next = notePending.current.get(key) ?? content; if (latest.content === next) return;
      const saved = await api(`/notes/${note.id}`, { content: next, revision: latest.revision }, "PATCH"); replaceNotes(notesRef.current.map(item => item.id === saved.id ? saved : item)); setNoteErrors(all => ({ ...all, [note.id]: "" })); setNoteStatus("已保存");
    }).catch(cause => { setNoteErrors(all => ({ ...all, [note.id]: cause.message })); setNoteStatus("保存失败 · 草稿已保留"); }); noteChains.current.set(key, chain); return chain;
  }
  async function deleteNote(note: BookPersonalNote) { if (!window.confirm("删除这条原文批注？")) return; try { await api(`/notes/${note.id}`, {}, "DELETE"); replaceNotes(notesRef.current.filter(item => item.id !== note.id)); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败。"); } }
  const chapterNote = notes.find(note => note.kind === "chapter" && note.chapterId === document.unitId); const bookNote = notes.find(note => note.kind === "book");
  const canSummary = document.units.filter(unit => unit.role === "main" && (unit.blockCount ?? 1) > 0).every(unit => session.chapters.some(chapter => chapter.chapterId === unit.id && !!chapter.learning.readingConfirmedAt));
  const nextChapter = document.units[document.units.findIndex(unit => unit.id === session.currentChapterId) + 1];
  const tutorPanel = <section className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-3 border-b p-4"><Image src={tutor.avatar} alt={tutor.name} width={36} height={36} unoptimized className="h-9 w-9 object-cover" /><div><p className="text-sm font-semibold">{tutor.name}</p><p className="text-xs text-neutral-500">{state.learning.phase === "free_reading" ? "安静阅读 · 随时提问" : `本章导读 · ${currentFocus?.label ?? "章总结"}`}</p></div></div><div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{messages.map(message => <div key={message.id} className={`border p-3 ${message.role === "user" ? "ml-5 bg-neutral-100" : "mr-2 bg-white"}`}>
    {message.anchor && <button className="mb-2 block w-full border-l-2 border-neutral-400 pl-2 text-left text-xs text-neutral-500" onClick={() => void inspectQuote(message.anchor!)}>原文：{anchorQuote(message.anchor)}</button>}
    {message.language !== "zh-CN" && <p className="mb-1 text-xs text-neutral-500">{message.language === "ja" ? "日语" : message.language === "en" ? "英语" : "中文"}{message.kind === "quote" ? "原文引用" : "例句"}</p>}
    <Markdown content={typing?.id === message.id && typing.shown !== null ? tokenizeForReveal(message.content).slice(0, typing.shown).join("") : message.content} className="md break-words" />
    {!!message.attachments.length && <div className="mt-2 flex flex-wrap gap-2">{message.attachments.map((url, index) => <a key={index} href={url} target="_blank" rel="noreferrer"><Image src={url} alt={`提问图片${index + 1}`} width={280} height={220} unoptimized className="max-h-40 max-w-36 object-contain" /></a>)}</div>}
    {message.role === "tutor" && message.speech && !muted && <button aria-label="重播语音" disabled={busy} className="mt-2" onClick={() => void replayMessage(message)}><Volume2 size={14} /></button>}
  </div>)}{!messages.length && <p className="border-l-2 pl-3 text-sm leading-7 text-neutral-500">先安静读书。遇到词句问题可以选中文字；导师会在你主动提问后回答。</p>}<div ref={chatEnd} /></div>{pendingAnchor && <div className="mx-3 border-l-2 p-2 text-xs">引用：{anchorQuote(pendingAnchor)}<button className="ml-2 underline" onClick={() => setPendingAnchor(null)}>取消</button></div>}{!!attachedNotes.length && <p className="px-4 py-2 text-xs">附加笔记：{attachedNotes.join("、")}<button className="ml-2 underline" onClick={() => setAttachedNotes([])}>清除</button></p>}
    <ClassroomComposer value={input} onValueChange={setInput} images={images} onAddImages={addAttachments} onRemoveImage={removeAttachment} imageProcessing={attachmentsProcessing} attachmentError={attachmentError} onClearAttachmentError={clearAttachmentError} canSend={props.llmReady} busy={busy} placeholder="选中文字，或向导师提问…" quickActions={[]} onStop={stop} onHint={() => enqueue({ text: state.learning.phase === "free_reading" ? "请给我一点理解当前原文的提示。" : "请围绕当前导读角度给一个提示。" })} onSend={(text, attachments) => { enqueue({ text, images: attachments, anchor: pendingAnchor, noteIds: attachedNotes }); setInput(""); setPendingAnchor(null); setAttachedNotes([]); clearAttachments(); }} />
  </section>;

  return <div className="flex h-dvh flex-col overflow-hidden bg-[#fcfcfa] text-neutral-900"><header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b-2 border-neutral-900 px-4 py-2"><span className="hidden font-serif font-bold sm:inline">AniLearn</span><span className="w-full min-w-0 truncate text-sm font-semibold sm:w-auto sm:flex-1">{book.title}</span><Link href={`/books/${book.id}`} className="flex items-center gap-1 text-xs"><BookOpen size={15} />返回典籍</Link><button aria-label={muted ? "开启语音" : "静音"} onClick={() => { if (!muted) playback.current?.abort(); setMuted(!muted); }}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><select aria-label="语速" value={rate} className="bg-transparent text-xs" onChange={event => setRate(Number(event.target.value))}><option value={1}>1x</option><option value={1.25}>1.25x</option><option value={1.5}>1.5x</option></select>{canExit && !busy ? <Link href="/" className="flex items-center gap-1 text-xs"><LogOut size={15} />返回首页</Link> : <button className="text-xs" disabled={busy && lastRequest?.intent === "goodbye"} onClick={() => enqueue({ intent: "goodbye" })}>结束本次阅读</button>}</header>
    {(error || attachmentError) && <div role="alert" className="flex shrink-0 items-center gap-3 border-b bg-red-50 px-4 py-2 text-xs text-red-700">{error || attachmentError}{lastRequest && error && <button className="underline" onClick={() => enqueue(lastRequest)}>重试提问</button>}<button className="ml-auto" onClick={() => setError("")}>关闭</button></div>}
    <ReadingWorkspace tutor={tutorPanel} open={tutorOpen} onOpenChange={setTutorOpen}><div className="flex min-h-0 flex-1 flex-col"><nav aria-label="典籍阅读内容" className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">{([{ id: "source", label: "原文", icon: BookOpen }, { id: "notes", label: "我的笔记", icon: NotebookPen }, { id: "analysis", label: "本章导读", icon: MessageSquare }, { id: "summary", label: "全书总结", icon: FileText }] as const).map(item => <button key={item.id} aria-pressed={tab === item.id} className={`flex items-center gap-1 px-3 py-2 text-xs ${tab === item.id ? "bg-neutral-900 text-white" : ""}`} onClick={() => setTab(item.id)}><item.icon size={14} />{item.label}</button>)}</nav>
      <div className={`min-h-0 flex-1 ${tab === "source" ? "flex flex-col" : "overflow-y-auto p-5 sm:p-8"}`}>
        <div ref={readerContainer} className={tab === "source" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs"><span>{document.unitId === session.currentChapterId ? state.learning.phase === "free_reading" ? "自由阅读" : "本章导读" : "临时查看其他章节"}{displayed?.learning.readingConfirmedAt ? " · 已确认读完" : ""}</span>{document.unitId === session.currentChapterId && <div className="flex gap-3"><button disabled={busy || changing} className="underline disabled:opacity-40" onClick={() => void changeLearning("confirm_reading")}>确认已读完本章</button><button disabled={busy || changing || !props.analysisReady} className="underline disabled:opacity-40" onClick={() => void startAnalysis()}><Play size={12} className="mr-1 inline" />已读完，开始导读</button></div>}</div>
          <Reader document={document} initialPosition={displayed?.position} inspectAnchor={inspectAnchor} annotations={notes.filter(note => note.kind === "annotation" && note.anchor?.unitId === document.unitId).map(note => ({ id: note.id, anchor: note.anchor!, content: drafts[note.id] ?? note.content }))} onPositionChange={onPosition} onUnitChange={(id, inspect) => void changeChapter(id, inspect)} onInspectionChange={value => { if (value && !inspectingRef.current && documentRef.current.unitId === sessionRef.current.currentChapterId) { const position = visibleReadingPosition(); if (position) positionRef.current = position; } inspectingRef.current = value; }} onQuestion={question} onSelectionTask={selectionTask} onAnnotation={annotate} />
        </div>
        {tab === "notes" && <div className="mx-auto max-w-3xl space-y-6"><div className="flex justify-between"><h2 className="text-xl font-semibold">我的阅读笔记</h2><span role="status" className="text-xs text-neutral-500">{noteStatus}</span></div><p className="text-xs text-neutral-500">笔记属于这一版本，同一本书换导师时继续保留；全书笔记只有主动附加时才传给导师。</p>
          {([{ kind: "chapter", label: "本章笔记", note: chapterNote }, { kind: "book", label: "全书笔记", note: bookNote }] as const).map(item => { const key = item.note ? String(item.note.id) : item.kind === "book" ? "book" : `chapter-${document.unitId}`; return <section key={item.kind}><label className="block text-sm font-medium">{item.label}<textarea aria-label={item.label} className="mt-2 min-h-40 w-full border bg-white p-4 text-sm leading-7" value={drafts[key] ?? item.note?.content ?? ""} onChange={event => { setDrafts(all => ({ ...all, [key]: event.target.value })); setNoteStatus("草稿未保存"); }} /></label><div className="mt-2 flex gap-3"><button className="border px-3 py-1.5 text-xs" onClick={() => void saveNotebook(item.kind, drafts[key] ?? item.note?.content ?? "", document.unitId)}>保存{item.label}</button>{item.note && <button className="text-xs underline" onClick={() => { setAttachedNotes(all => [...new Set([...all, item.note!.id])]); setTutorOpen(true); }}>附到提问</button>}</div></section>; })}
          <section className="space-y-4 border-t pt-5"><h3 className="font-semibold">原文批注</h3>{notes.filter(note => note.kind === "annotation").map(note => <div key={note.id} className="space-y-2 border bg-white p-4"><button className="border-l-2 pl-3 text-left text-xs text-neutral-500" onClick={() => note.anchor && void inspectQuote(note.anchor)}>{note.anchor ? anchorQuote(note.anchor) : "原文选区"}</button><textarea aria-label="编辑原文批注" className="min-h-24 w-full border p-3 text-sm" value={drafts[note.id] ?? note.content} onChange={event => setDrafts(all => ({ ...all, [note.id]: event.target.value }))} /><div className="flex gap-3 text-xs"><button className="underline" onClick={() => void saveEditedNote(note, drafts[note.id] ?? note.content)}>保存批注</button><button className="underline" onClick={() => void deleteNote(note)}>删除批注</button><span role="status" className="text-red-700">{noteErrors[note.id]}</span></div></div>)}</section>
        </div>}
        {tab === "analysis" && <div className="mx-auto max-w-3xl space-y-6"><h2 className="text-xl font-semibold">本章导读 · {document.units.find(unit => unit.id === session.currentChapterId)?.title}</h2>{state.learning.phase === "free_reading" ? <div className="border p-5"><p className="text-sm">先读完本章，再一起分析。可以跳章阅读，导读进度分别保留。</p><button disabled={!props.analysisReady || changing || busy} className="ink-button mt-4 px-4 py-2 disabled:opacity-40" onClick={() => void startAnalysis()}><Play size={15} />已读完本章，开始导读</button></div> : <>{(analysis.status === "interrupted" || analysis.status === "failed" || analysis.status !== "ready" && state.analysis.status !== "ready") ? <div role="status" className="space-y-2 border p-5"><p>{analysis.running ? "导师正在整理本章资料" : "本章资料尚未准备完成"}</p><p className="text-xs text-neutral-500">已整理 {analysis.completedChunks}/{analysis.totalChunks} 个片段</p>{analysis.error && <p className="text-sm text-red-700">{analysis.error}</p>}{analysis.resumable && <button disabled={changing} className="border px-3 py-2 text-sm" onClick={() => void startAnalysis(true)}><RotateCcw className="mr-1 inline" size={14} />续接本章准备</button>}</div> : <><div className="flex flex-wrap gap-2">{foci.map(focus => <button key={focus.id} disabled={busy || changing} className={`border px-3 py-2 text-sm ${state.learning.currentFocus === focus.id ? "bg-neutral-900 text-white" : ""}`} onClick={() => void changeLearning("set_focus", { focus: focus.id })}>{focus.label} · {state.learning.focusStatus[focus.id] === "confirmed" ? "已确认" : state.learning.focusStatus[focus.id] === "in_progress" ? "进行中" : "未开始"}</button>)}</div>{state.learning.currentFocus ? <section className="space-y-4 border p-5"><h3 className="font-semibold">{currentFocus?.label}</h3>{state.learning.analysisNotes[state.learning.currentFocus] && <Markdown className="md" content={state.learning.analysisNotes[state.learning.currentFocus] ?? ""} />}<div className="flex flex-wrap gap-2"><button disabled={busy || !props.llmReady} className="ink-button px-4 py-2 disabled:opacity-40" onClick={() => enqueue({ text: `请围绕「${currentFocus?.label}」提出一个具体问题，引导我分析本章。` })}>开始讨论</button><button disabled={busy || !props.llmReady} className="border px-4 py-2 text-sm" onClick={() => enqueue({ text: `请直接讲解本章的「${currentFocus?.label}」，结合原文证据。` })}>直接讲解</button><button disabled={busy || changing || !state.learning.analysisNotes[state.learning.currentFocus]} className="ml-auto border px-4 py-2 text-sm disabled:opacity-40" onClick={() => void changeLearning("confirm_focus")}><Check className="mr-1 inline" size={14} />这个角度已理解</button></div></section> : <section className="space-y-4 border p-5"><h3 className="font-semibold">全部角度已确认</h3>{state.learning.summary ? <><Markdown content={state.learning.summary} className="md" />{state.learning.completedAt ? <div className="space-y-3"><p role="status" className="text-sm font-semibold">本章导读已完成</p>{nextChapter && <button disabled={busy || changing} className="border px-4 py-2 text-sm" onClick={() => void changeChapter(nextChapter.id)}>进入下一章</button>}</div> : <button disabled={busy || changing} className="ink-button px-4 py-2" onClick={() => void changeLearning("complete_analysis")}><Check size={15} />明确完成本章</button>}</> : <button disabled={busy || !props.llmReady} className="ink-button px-4 py-2" onClick={() => enqueue({ intent: "chapter_summary" })}>生成本章总结</button>}</section>}</>}
          <button disabled={busy || changing} className="text-sm underline" onClick={() => { void changeLearning("return_to_reading"); setTab("source"); }}>回到自由阅读</button></>}</div>}
        {tab === "summary" && <div className="mx-auto max-w-3xl space-y-5"><h2 className="text-xl font-semibold">全书总结</h2><p className="text-sm text-neutral-600">确认已读完全部正文主章后，整理全书结构与思想。每章导师导读可以自行选择。</p>{!canSummary && <p role="status" className="border p-4 text-sm">尚有正文主章未确认读完。请回到对应章节明确确认。</p>}{summaryProgress.running && <div role="status" className="border p-4 text-sm">正在准备全书资料 · {summaryProgress.completedChunks}/{summaryProgress.totalChunks} 章</div>}{summaryProgress.error && <p className="text-sm text-red-700">{summaryProgress.error}</p>}{session.summary ? <Markdown content={session.summary} className="md" /> : <button disabled={!canSummary || changing || summaryProgress.running || !props.analysisReady} className="ink-button px-4 py-2 disabled:opacity-40" onClick={() => void startSummary(summaryProgress.resumable)}>{summaryProgress.resumable ? "续接全书总结" : "生成全书总结"}</button>}</div>}
      </div></div></ReadingWorkspace>
  </div>;
}
