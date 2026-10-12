"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { BookOpen, NotebookPen, MessageSquare, Volume2, VolumeX, ChevronLeft, ChevronRight, LogOut, Play, Check, Loader2, Highlighter, X, RotateCcw, FileText } from "lucide-react";
import { ClassroomComposer } from "@/components/ClassroomComposer";
import { Markdown } from "@/components/Markdown";
import { revealTutorMessage } from "@/lib/client/tutor-playback";
import { useChatAttachments } from "@/lib/client/chat-attachments";
import { useSpeechAudioController } from "@/lib/client/speech-audio";
import { tokenizeForReveal } from "@/lib/text";
import type { ReadingSessionDTO } from "@/lib/types";
import { MAX_CHAT_TEXT_CHARS, type ReadingDTO, type ReadingFocus, type ReadingLearningState, type ReadingMessage, type ReadingPersonalNote, type ReadingPhase, type ReadingSelection, type ReadingSelectionTask, type ReadingTurnEvent, type ReadingTurnRequest, type TutorDTO } from "@/lib/types";

type TurnRequest = Omit<ReadingTurnRequest, "requestId" | "phase" | "stateRevision" | "paragraphIdx"> & {
  requestId: string; phase: ReadingPhase; stateRevision: number; paragraphIdx: number; text: string;
};
type AnalysisStatus = { status: string; completedChunks: number; totalChunks: number; running: boolean; resumable: boolean; error: string | null };
type SelectionBar = { selection: ReadingSelection; quote: string; x: number; y: number };

const FOCI: { id: ReadingFocus; label: string }[] = [
  { id: "structure", label: "结构" }, { id: "writing", label: "写作思路" }, { id: "theme", label: "主旨" },
  { id: "emotion", label: "情感" }, { id: "technique", label: "表现手法" },
];

function makeRequestId() { return crypto.randomUUID(); }
function selectedText(selection: ReadingSelection) { return selection.segments.map((segment) => segment.quote).join(" … "); }

function selectionFromArticle(article: HTMLElement, reading: ReadingDTO): ReadingSelection | null {
  const current = window.getSelection();
  if (!current || current.isCollapsed || !current.rangeCount) return null;
  const range = current.getRangeAt(0);
  const segments: ReadingSelection["segments"] = [];
  const roots = Array.from(article.querySelectorAll<HTMLElement>("[data-reading-paragraph-text]"));
  for (const root of roots) {
    if (!range.intersectsNode(root)) continue;
    const paragraphId = root.dataset.paragraphId;
    if (!paragraphId || !reading.paragraphs.some((paragraph) => paragraph.id === paragraphId)) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.parentElement?.closest("button,[aria-hidden='true'],script,style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const visible = nodes.map((node) => node.data).join("");
    let offset = 0;
    let first = -1;
    let last = -1;
    const parts: string[] = [];
    for (const node of nodes) {
      let intersects = false;
      try { intersects = range.intersectsNode(node); } catch { /* The selection may have moved while the toolbar was opening. */ }
      if (!intersects) { offset += node.length; continue; }
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.length;
      if (to > from) {
        if (first < 0) first = offset + from;
        last = offset + to;
        parts.push(node.data.slice(from, to));
      }
      offset += node.length;
    }
    const rawQuote = parts.join("");
    const quote = rawQuote.trim();
    if (!quote || first < 0 || last < first) continue;
    const leading = rawQuote.indexOf(quote);
    const start = first + Math.max(0, leading);
    const end = start + quote.length;
    segments.push({ paragraphId, start, end, quote, prefix: visible.slice(Math.max(0, start - 36), start), suffix: visible.slice(end, end + 36) });
  }
  if (!segments.length) return null;
  return { segments };
}

export default function ReadingClassroom(props: {
  reading: ReadingDTO;
  session: ReadingSessionDTO;
  tutor: TutorDTO;
  initialMessages: ReadingMessage[];
  initialPersonalNotes: ReadingPersonalNote[];
  ttsReady: boolean;
  llmReady: boolean;
  analysisReady: boolean;
}) {
  const { reading, tutor } = props;
  const [session, setSession] = useState(props.session);
  const sessionRef = useRef(props.session);
  const [messages, setMessages] = useState(props.initialMessages);
  const [personalNotes, setPersonalNotes] = useState(props.initialPersonalNotes);
  const notesRef = useRef(props.initialPersonalNotes);
  const [docDraft, setDocDraft] = useState(props.initialPersonalNotes.find((note) => note.kind === "document")?.content ?? "");
  const docSaved = useRef(props.initialPersonalNotes.find((note) => note.kind === "document")?.content ?? "");
  const docPending = useRef("");
  const docChain = useRef<Promise<void>>(Promise.resolve());
  const noteChains = useRef(new Map<number, Promise<void>>());
  const notePending = useRef(new Map<number, string>());
  const [annotationDrafts, setAnnotationDrafts] = useState<Record<number, string>>(() => Object.fromEntries(props.initialPersonalNotes.filter((note) => note.kind === "annotation").map((note) => [note.id, note.content])));
  const [noteStatus, setNoteStatus] = useState("已保存");
  const [noteErrors, setNoteErrors] = useState<Record<number, string>>({});
  const [tab, setTab] = useState<"source" | "notes" | "analysis">("source");
  const [historyTab, setHistoryTab] = useState(false);
  const [mobile, setMobile] = useState<"chat" | "reading">("reading");
  const [viewIdx, setViewIdx] = useState(props.session.currentIdx);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(!props.ttsReady);
  const mutedRef = useRef(!props.ttsReady);
  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);
  const [typing, setTyping] = useState<{ id: number; shown: number | null } | null>(null);
  const [lastRequest, setLastRequest] = useState<TurnRequest | null>(null);
  const [canExit, setCanExit] = useState(props.session.status === "completed" || !!props.session.learning.analysisCompletedAt);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({ status: "idle", completedChunks: 0, totalChunks: 0, running: false, resumable: false, error: null });
  const [selectionBar, setSelectionBar] = useState<SelectionBar | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ReadingSelection | null>(null);
  const pendingSelectionRef = useRef<ReadingSelection | null>(null);
  const [annotationEditor, setAnnotationEditor] = useState<ReadingSelection | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const annotationClientId = useRef("");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const analysisRequestId = useRef("");

  const replaceSession = useCallback((value: ReadingSessionDTO) => { sessionRef.current = value; setSession(value); }, []);
  const replaceNotes = useCallback((value: ReadingPersonalNote[]) => { notesRef.current = value; setPersonalNotes(value); }, []);

  const { images, processing: attachmentsProcessing, error: attachmentError, addFiles: addAttachments,
    removeImage: removeAttachment, clearImages: clearAttachments, clearError: clearAttachmentError } = useChatAttachments();
  const pending = useRef<TurnRequest[]>([]);
  const running = useRef(false);
  const request = useRef<AbortController | null>(null);
  const playback = useRef<AbortController | null>(null);
  const { controllerRef: speechAudioRef, getController: getSpeechAudio } = useSpeechAudioController();
  const disposed = useRef(false);
  const optimistic = useRef(-1);
  const chatEnd = useRef<HTMLDivElement>(null);
  const sourceScroll = useRef<HTMLDivElement>(null);
  const docTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const saveBookmarkRef = useRef<(idx: number, attempt?: number) => Promise<void>>(async () => undefined);

  const saveDocument = useCallback(async (content: string) => {
    docPending.current = content;
    docChain.current = docChain.current.catch(() => undefined).then(async () => {
      const nextContent = docPending.current;
      setNoteStatus("保存中…");
      let note = notesRef.current.find((item) => item.kind === "document");
      if (!note) {
        const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/notes`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: "document", kind: "document", content: nextContent }),
        });
        const data = await response.json() as ReadingPersonalNote & { error?: string };
        if (!response.ok) throw new Error(data.error || "全文笔记保存失败。");
        note = data;
        replaceNotes([...notesRef.current.filter((item) => item.clientId !== "document"), data]);
      }
      if (!note) throw new Error("全文笔记保存失败。");
      if (note.content !== nextContent) {
        const oldNote = note;
        const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/notes/${note.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: nextContent, revision: note.revision }),
        });
        const data = await response.json() as ReadingPersonalNote & { error?: string };
        if (!response.ok) throw new Error(data.error || "全文笔记已在其他页面修改，请同步后重试。");
        note = data;
        replaceNotes(notesRef.current.map((item) => item.id === oldNote.id ? data : item));
      }
      docSaved.current = nextContent;
      setNoteStatus(docPending.current === nextContent ? "已保存" : "保存中…");
    }).catch((cause) => { setNoteStatus("保存失败 · 点击重试"); setError(cause instanceof Error ? cause.message : String(cause)); });
    return docChain.current;
  }, [replaceNotes]);

  const saveAnnotation = useCallback(async (noteId: number, content: string) => {
    notePending.current.set(noteId, content);
    const old = noteChains.current.get(noteId) ?? Promise.resolve();
    const queued = old.catch(() => undefined).then(async () => {
      const nextContent = notePending.current.get(noteId) ?? content;
      const note = notesRef.current.find((item) => item.id === noteId);
      if (!note || note.content === nextContent) return;
      setNoteStatus("保存中…");
      const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/notes/${noteId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: nextContent, revision: note.revision }),
      });
      const data = await response.json();
      if (!response.ok) { setNoteErrors((all) => ({ ...all, [noteId]: data.error || "批注已在其他页面修改。" })); setNoteStatus("保存失败"); return; }
      setNoteErrors((all) => ({ ...all, [noteId]: "" }));
      replaceNotes(notesRef.current.map((item) => item.id === noteId ? data : item));
      setNoteStatus("已保存");
    }).catch((cause) => { setNoteErrors((all) => ({ ...all, [noteId]: cause instanceof Error ? cause.message : "批注保存失败。" })); setNoteStatus("保存失败"); });
    noteChains.current.set(noteId, queued);
    return queued;
  }, [replaceNotes]);

  const saveBookmark = useCallback(async (idx: number, attempt = 0) => {
    try {
      const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "bookmark", currentIdx: idx }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && attempt < 3) { setTimeout(() => { if (viewIdx === idx) void saveBookmarkRef.current(idx, attempt + 1); }, 400); return; }
        return;
      }
      if (sessionRef.current.currentIdx === idx) replaceSession(data);
      else replaceSession({ ...sessionRef.current, currentIdx: data.currentIdx });
    } catch { /* The local reading position remains available and will save on the next change. */ }
  }, [replaceSession, viewIdx]);
  useEffect(() => { saveBookmarkRef.current = saveBookmark; }, [saveBookmark]);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { notesRef.current = personalNotes; }, [personalNotes]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { getSpeechAudio().setEnabled(props.ttsReady && !muted); }, [getSpeechAudio, muted, props.ttsReady]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }); }, [messages.length, typing]);
  useEffect(() => {
    const node = sourceScroll.current;
    if (!node || tab !== "source") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const bounds = node.getBoundingClientRect();
        const paragraphs = Array.from(node.querySelectorAll<HTMLElement>("[data-reading-paragraph]"));
        const first = paragraphs.find((paragraph) => paragraph.getBoundingClientRect().bottom > bounds.top + 90);
        if (first) {
          const idx = Number(first.dataset.readingParagraph);
          if (Number.isInteger(idx) && idx !== viewIdx) setViewIdx(idx);
        }
      }, 140);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => { node.removeEventListener("scroll", onScroll); if (timer) clearTimeout(timer); };
  }, [tab, viewIdx]);
  useEffect(() => {
    if (session.learning.phase === "free_reading") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/analysis-status`, { cache: "no-store" });
        const data = await response.json();
        if (!active || !response.ok) return;
        setAnalysisStatus({ status: data.status, completedChunks: data.completedChunks, totalChunks: data.totalChunks, running: data.running, resumable: data.resumable, error: data.error });
        if (data.learning) {
          const next = { ...sessionRef.current, learning: data.learning };
          sessionRef.current = next; setSession(next);
        }
        if (data.running) timer = setTimeout(() => void poll(), 1400);
      } catch { if (active) timer = setTimeout(() => void poll(), 2500); }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [session.id, session.learning.phase]);
  useEffect(() => {
    const annotationTimerMap = annotationTimers.current;
    disposed.current = false;
    return () => {
      disposed.current = true;
      pending.current = [];
      request.current?.abort(); playback.current?.abort();
      getSpeechAudio().cancelPending(); speechAudioRef.current?.dispose(); speechAudioRef.current = null;
      if (docTimer.current) clearTimeout(docTimer.current);
      for (const timer of annotationTimerMap.values()) clearTimeout(timer);
    };
  }, [getSpeechAudio, speechAudioRef]);
  useEffect(() => {
    if (docDraft === docSaved.current) return;
    setNoteStatus("保存中…");
    if (docTimer.current) clearTimeout(docTimer.current);
    docTimer.current = setTimeout(() => { void saveDocument(docDraft); }, 500);
    return () => { if (docTimer.current) clearTimeout(docTimer.current); };
  }, [docDraft, saveDocument]);
  useEffect(() => {
    const timers = annotationTimers.current;
    const scheduled: { id: number; timer: ReturnType<typeof setTimeout> }[] = [];
    for (const note of personalNotes) {
      if (note.kind !== "annotation") continue;
      const draft = annotationDrafts[note.id] ?? note.content;
      if (draft === note.content) continue;
      const oldTimer = timers.get(note.id);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => { timers.delete(note.id); void saveAnnotation(note.id, draft); }, 500);
      timers.set(note.id, timer);
      scheduled.push({ id: note.id, timer });
    }
    return () => {
      for (const entry of scheduled) {
        clearTimeout(entry.timer);
        if (timers.get(entry.id) === entry.timer) timers.delete(entry.id);
      }
    };
  }, [annotationDrafts, personalNotes, saveAnnotation]);
  useEffect(() => {
    if (viewIdx === session.currentIdx) return;
    const timer = setTimeout(() => { void saveBookmark(viewIdx); }, 350);
    return () => clearTimeout(timer);
  }, [viewIdx, session.currentIdx, saveBookmark]);
  function append(message: ReadingMessage) { setMessages((all) => all.some((item) => item.id === message.id) ? all : [...all, message]); }

  async function play(message: ReadingMessage) {
    const controller = new AbortController(); playback.current = controller;
    await revealTutorMessage({ text: message.content, speech: message.language === "zh-CN" ? message.speech : "", voiceId: tutor.voiceId,
      audio: getSpeechAudio(), cacheKey: `reading:${sessionRef.current.id}:${message.id}`,
      muted: () => mutedRef.current, rate: () => rateRef.current, signal: controller.signal,
      onReveal: (shown) => { if (!disposed.current) setTyping({ id: message.id, shown }); } });
    if (playback.current === controller) playback.current = null;
    if (!disposed.current) setTyping(null);
  }

  function stop() {
    getSpeechAudio().cancelPending(); request.current?.abort(); playback.current?.abort(); setCanExit(false);
  }

  async function runQueue() {
    if (running.current || disposed.current) return;
    running.current = true; setBusy(true); setCanExit(false);
    try {
      while (pending.current.length && !disposed.current) {
        getSpeechAudio().cancelPending();
        const next = pending.current.shift()!;
        setLastRequest(next); setError("");
        const controller = new AbortController(); request.current = controller;
        let done: Extract<ReadingTurnEvent, { type: "done" }> | undefined;
        let eof = false;
        const localId = optimistic.current--;
        if (next.text || next.images?.length) append({
          id: localId, role: "user", content: next.text, speech: "", kind: "text", language: "zh-CN",
          paragraphIdx: next.paragraphIdx, attachments: next.images ?? [], attachmentCount: next.images?.length ?? 0,
          phase: next.phase, focus: next.focus ?? null, selection: next.selection ?? null,
        });
        try {
          const body = { ...next };
          let response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/turn`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
          });
          for (let attempt = 0; response.status === 409 && /上一轮仍在进行/.test((await response.clone().json().catch(() => ({}))).error ?? "") && attempt < 4 && !controller.signal.aborted; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
          }
          if (!response.ok || !response.body) { const data = await response.json(); throw new Error(data.error || "课堂回复失败"); }
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
          let processing = Promise.resolve(); let processingError: unknown;
          const handle = async (event: ReadingTurnEvent) => {
            if (event.type === "error") throw new Error(event.error);
            if (event.type === "message") {
              if (event.message.role === "user") setMessages((all) => [...all.filter((item) => item.id !== localId && item.id !== event.message.id), event.message]);
              else { append(event.message); if (!controller.signal.aborted) await play(event.message); }
            } else if (event.type === "notes") replaceSession({ ...sessionRef.current, notes: { ...sessionRef.current.notes, [String(event.paragraphIdx)]: event.notes } });
            else if (event.type === "analysis") replaceSession({ ...sessionRef.current, learning: event.learning });
            else if (event.type === "done") { done = event; replaceSession(event.session); }
          };
          const queueEvent = (event: ReadingTurnEvent) => {
            if (event.type === "message" && event.message.role === "tutor" && (event.message.kind === "text" || event.message.kind === "feedback") && event.message.language === "zh-CN" && event.message.speech && props.ttsReady && !mutedRef.current) {
              getSpeechAudio().prefetch({ key: `reading:${sessionRef.current.id}:${event.message.id}`, text: event.message.speech, voiceId: tutor.voiceId }, controller.signal);
            }
            processing = processing.then(async () => { if (!processingError && !controller.signal.aborted) await handle(event); }).catch((cause) => { processingError = cause; });
          };
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); eof = true; break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim()) queueEvent(JSON.parse(line)); }
          }
          if (buffer.trim()) queueEvent(JSON.parse(buffer));
          await processing;
          if (processingError) throw processingError;
          if (!done || !eof) throw new Error("课堂连接提前结束，请重试。");
          if (!controller.signal.aborted && (done.goodbye || done.session.status === "completed") && !pending.current.length) setCanExit(true);
        } catch (cause) {
          if (!controller.signal.aborted && !disposed.current) setError(cause instanceof Error ? cause.message : String(cause));
        } finally { if (request.current === controller) request.current = null; }
      }
    } finally { running.current = false; if (!disposed.current) setBusy(false); }
  }

  function enqueue(value: Omit<TurnRequest, "requestId" | "phase" | "stateRevision" | "paragraphIdx"> & { text: string; paragraphIdx?: number; requestId?: string; phase?: ReadingPhase; stateRevision?: number }) {
    const current = sessionRef.current;
    const next: TurnRequest = {
      ...value, requestId: value.requestId ?? makeRequestId(), phase: value.phase ?? current.learning.phase,
      stateRevision: value.stateRevision ?? current.learning.stateRevision,
      paragraphIdx: value.paragraphIdx ?? viewIdx,
    };
    pending.current.push(next); setLastRequest(next);
    if (running.current) stop();
    void runQueue();
  }

  async function replay(message: ReadingMessage) {
    if (running.current || mutedRef.current || disposed.current) return;
    getSpeechAudio().retryFailed(`reading:${sessionRef.current.id}:${message.id}`);
    running.current = true; setBusy(true);
    try { await play(message); } finally { running.current = false; if (!disposed.current) setBusy(false); void runQueue(); }
  }

  async function changeLearning(action: string, extra: Record<string, unknown> = {}) {
    const current = sessionRef.current;
    setAnalysisBusy(true); setError("");
    try {
      const response = await fetch(`/api/reading-sessions/${current.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, stateRevision: current.learning.stateRevision, ...extra }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "课堂状态更新失败。");
      replaceSession(data); setCanExit(data.status === "completed" || !!data.learning.analysisCompletedAt);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setAnalysisBusy(false); }
  }

  async function startAnalysis() {
    if (!props.analysisReady || busy || analysisBusy) return;
    setAnalysisBusy(true); setError(""); setAnalysisStatus((status) => ({ ...status, status: "running", running: true, resumable: false, error: null }));
    try {
      const current = sessionRef.current;
      if (!analysisRequestId.current) analysisRequestId.current = makeRequestId();
      const response = await fetch(`/api/reading-sessions/${current.id}/analysis`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", requestId: analysisRequestId.current, stateRevision: current.learning.stateRevision }),
      });
      const data = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(data.error || "无法开始文章分析。");
      analysisRequestId.current = "";
      if (data.learning) replaceSession({ ...sessionRef.current, learning: data.learning });
      setTab("analysis");
      setAnalysisStatus((status) => ({ ...status, status: data.status ?? "running", running: data.status === "ready" || data.status === "failed" ? false : true, resumable: data.status === "failed" || data.status === "interrupted", error: data.error ?? null }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setAnalysisStatus((status) => ({ ...status, status: "failed", running: false, resumable: true })); }
    finally { setAnalysisBusy(false); }
  }

  async function resumeAnalysis() {
    setAnalysisBusy(true); setError("");
    try {
      const current = sessionRef.current;
      if (!analysisRequestId.current) analysisRequestId.current = makeRequestId();
      const response = await fetch(`/api/reading-sessions/${current.id}/analysis`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume", requestId: analysisRequestId.current }),
      });
      const data = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(data.error || "无法续接全文分析。");
      analysisRequestId.current = "";
      setAnalysisStatus((status) => ({ ...status, status: data.status ?? "running", running: data.status === "ready" || data.status === "failed" ? false : true, resumable: data.status === "failed" || data.status === "interrupted", error: data.error ?? null }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAnalysisBusy(false); }
  }

  async function createAnnotation() {
    if (!annotationEditor || !annotationText.trim()) return;
    setSavingAnnotation(true); setError("");
    try {
      const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/notes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: annotationClientId.current || makeRequestId(), kind: "annotation", content: annotationText, selection: annotationEditor }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "批注保存失败。");
      replaceNotes([...notesRef.current, data]);
      setAnnotationDrafts((all) => ({ ...all, [data.id]: data.content }));
      annotationClientId.current = "";
      setAnnotationEditor(null); setAnnotationText(""); setTab("notes");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingAnnotation(false); }
  }

  async function deleteAnnotation(noteId: number) {
    if (!window.confirm("删除这条原文批注？")) return;
    try {
      const response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/notes/${noteId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("批注删除失败。");
      replaceNotes(notesRef.current.filter((note) => note.id !== noteId));
      setAnnotationDrafts((all) => { const next = { ...all }; delete next[noteId]; return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function leaveToArticle() {
    if (docDraft !== docSaved.current) {
      await saveDocument(docDraft);
      if (docSaved.current !== docDraft) return;
    }
    await Promise.all(personalNotes.filter((note) => note.kind === "annotation" && annotationDrafts[note.id] !== note.content).map((note) => saveAnnotation(note.id, annotationDrafts[note.id] ?? note.content)));
    if (personalNotes.some((note) => note.kind === "annotation" && (notesRef.current.find((item) => item.id === note.id)?.content !== (annotationDrafts[note.id] ?? note.content)))) return;
    window.location.assign(`/readings/${reading.id}`);
  }

  function handleSelection() {
    const article = sourceScroll.current?.querySelector<HTMLElement>("[data-reading-article]");
    if (!article) return;
    const selection = selectionFromArticle(article, reading);
    if (!selection) return;
    const range = window.getSelection()?.getRangeAt(0);
    const rect = range?.getBoundingClientRect();
    const quote = selectedText(selection);
    setSelectionBar({ selection, quote, x: Math.max(12, Math.min(window.innerWidth - 370, rect?.left ?? 12)), y: Math.max(60, (rect?.top ?? 80) - 58) });
  }

  function askAboutSelection(task: ReadingSelectionTask, question: string) {
    if (!selectionBar) return;
    const anchor = selectionBar.selection;
    setSelectionBar(null); setMobile("chat");
    const text = `${question}\n原文选区：“${selectedText(anchor)}”`;
    enqueue({ text: Array.from(text).length <= MAX_CHAT_TEXT_CHARS ? text : question, selection: anchor,
      selectionTask: task, paragraphIdx: viewIdx, focus: sessionRef.current.learning.currentFocus });
    window.getSelection()?.removeAllRanges();
  }

  function attachSelectionToComposer() {
    if (!selectionBar) return;
    const value = selectionBar.selection;
    pendingSelectionRef.current = value;
    setPendingSelection(value);
    setInput(`请结合我选中的原文回答：\n“${selectedText(value)}”\n`);
    setSelectionBar(null); setMobile("chat");
    window.getSelection()?.removeAllRanges();
  }

  function startAnnotationFromSelection() {
    if (!selectionBar) return;
    setAnnotationEditor(selectionBar.selection); setAnnotationText(""); setTab("notes");
    annotationClientId.current = makeRequestId();
    setSelectionBar(null); setMobile("reading");
    window.getSelection()?.removeAllRanges();
  }

  function changeView(idx: number) { setViewIdx(Math.max(0, Math.min(reading.paragraphs.length - 1, idx))); }
  function scrollToSelection(selection: ReadingSelection | null) {
    const first = selection?.segments[0];
    if (!first) return;
    const idx = reading.paragraphs.findIndex((paragraph) => paragraph.id === first.paragraphId);
    if (idx < 0) return;
    changeView(idx); setTab("source"); setMobile("reading");
    setTimeout(() => document.getElementById(`reading-paragraph-${idx}`)?.scrollIntoView({ block: "center" }), 80);
  }

  const paragraphs = reading.paragraphs;
  const paragraphGroup = Math.floor(viewIdx / 50);
  const paragraphStart = paragraphGroup * 50;
  const paragraphCount = Math.max(1, Math.ceil(paragraphs.length / 50));
  const visibleParagraphs = paragraphs.slice(paragraphStart, paragraphStart + 50);
  const learning = session.learning;
  const requiredFoci = learning.articleKind === "literary" ? FOCI : FOCI.slice(0, 3);
  const currentFocusMeta = FOCI.find((focus) => focus.id === learning.currentFocus);
  const historyMessages = messages.filter((message) => message.phase === "legacy");
  const documentNote = personalNotes.find((note) => note.kind === "document");
  const textFor = (message: ReadingMessage) => typing?.id === message.id && typing.shown !== null ? tokenizeForReveal(message.content).slice(0, typing.shown).join("") : message.content;
  const attachmentPreviews = (message: ReadingMessage) => message.attachments.map((src, index) => (
    <a href={src} target="_blank" rel="noreferrer" key={index}><Image src={src} width={320} height={260} unoptimized alt={`提问图片 ${index + 1}`} className="max-h-52 max-w-48 border border-neutral-300 object-contain" /></a>
  ));

  return <div className="flex h-dvh flex-col overflow-hidden bg-[#fafafa] text-neutral-900">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b-2 border-neutral-900 px-4 py-2">
      <span className="font-serif font-bold">AniLearn</span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{reading.title}</span>
      <button className="flex items-center gap-2 border px-3 py-1.5 text-xs" onClick={() => void leaveToArticle()}><LogOut className="h-4 w-4" />返回文章</button>
      {canExit && !busy && <Link href="/" className="flex items-center gap-2 text-sm"><LogOut className="h-4 w-4" />返回首页</Link>}
      <button className="p-2" title={muted ? "开启语音" : "静音"} aria-label={muted ? "开启语音" : "静音"} onClick={() => { if (!muted) playback.current?.abort(); setMuted(!muted); }}>{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
      <select aria-label="语速" value={rate} onChange={(event) => setRate(Number(event.target.value))} className="bg-transparent text-sm"><option value={1}>1x</option><option value={1.25}>1.25x</option><option value={1.5}>1.5x</option></select>
      {!canExit && <button disabled={busy && lastRequest?.intent === "goodbye"} className="flex items-center gap-2 text-sm" onClick={() => enqueue({ text: "", intent: "goodbye" })}><LogOut className="h-4 w-4" />结束本次阅读</button>}
    </header>
    <div className="flex shrink-0 border-b lg:hidden"><button className={`flex-1 py-2 text-sm ${mobile === "chat" ? "bg-neutral-900 text-white" : ""}`} onClick={() => setMobile("chat")}>导师</button><button className={`flex-1 py-2 text-sm ${mobile === "reading" ? "bg-neutral-900 text-white" : ""}`} onClick={() => setMobile("reading")}>阅读</button></div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(320px,38%)_1fr]">
      <section className={`${mobile === "chat" ? "flex" : "hidden"} min-h-0 flex-col border-r border-neutral-300 lg:flex`}>
        <div className="flex items-center gap-3 border-b px-4 py-3"><Image src={tutor.avatar} alt={tutor.name} width={40} height={40} unoptimized className="h-10 w-10 object-cover" /><div className="min-w-0"><h2 className="font-semibold">{tutor.name}</h2><span className="text-xs text-neutral-500">{learning.phase === "free_reading" ? "自由阅读 · 等待你的提问" : `文章分析 · ${currentFocusMeta?.label ?? "整篇总结"}`}</span></div></div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((message) => <div key={message.id} className={`${message.role === "user" ? "ml-8 bg-neutral-100" : "mr-4 bg-white"} border border-neutral-300 p-3`}>
            {message.phase === "legacy" && <div className="mb-1 text-xs text-neutral-500">旧课堂记录</div>}
            {message.language !== "zh-CN" && <div className="mb-1 text-xs text-neutral-500">{message.language === "ja" ? "日语" : "英语"}{message.kind === "exercise" ? "练习" : message.kind === "example" ? "例句" : message.role === "user" ? "回答" : "原文引用"}</div>}
            {message.selection && <button className="mb-2 block w-full border-l-2 border-neutral-500 bg-white px-3 py-2 text-left text-xs text-neutral-600" onClick={() => scrollToSelection(message.selection ?? null)}>原文选区：{selectedText(message.selection)}</button>}
            {message.content && <Markdown content={textFor(message)} className="md break-words" />}
            {message.attachmentCount > 0 && <div className="mt-2 flex flex-wrap gap-2">{attachmentPreviews(message)}</div>}
            {message.kind === "quote" && <button className="mt-2 text-xs underline" onClick={() => changeView(message.paragraphIdx)}>定位原文 · 第 {message.paragraphIdx + 1} 段</button>}
            {message.role === "tutor" && message.speech && !muted && <button disabled={busy} title="重播语音" aria-label="重播语音" className="mt-2 p-1 disabled:opacity-30" onClick={() => void replay(message)}><Volume2 className="h-3 w-3" /></button>}
          </div>)}
          {!messages.length && learning.phase === "free_reading" && <div className="mx-1 border-l-2 border-neutral-400 bg-white p-4 text-sm leading-7 text-neutral-600"><p>你可以先安静地读完整篇文章。</p><p className="mt-1">遇到词句问题时，划选原文提问；读书期间也可以随时写笔记。</p></div>}
          <div ref={chatEnd} />
        </div>
        {(error || attachmentError) && <div role="alert" className="border-t px-4 py-2 text-sm text-red-700">{error || attachmentError}{error && lastRequest && <button className="ml-3 underline" onClick={() => enqueue({ ...lastRequest })}>重试</button>}</div>}
        {!props.llmReady && <div className="border-t px-4 py-2 text-xs text-neutral-600">导师对话需要配置讲解模型。<Link href="/settings" className="ml-1 underline">前往设置</Link></div>}
        {pendingSelection && <div className="mx-3 border-l-2 border-neutral-500 bg-neutral-100 px-3 py-2 text-xs">提问引用：{selectedText(pendingSelection)}<button className="ml-2 underline" onClick={() => { pendingSelectionRef.current = null; setPendingSelection(null); }}>取消</button></div>}
        <ClassroomComposer
          value={input} onValueChange={setInput} images={images} onRemoveImage={removeAttachment} onAddImages={addAttachments}
          imageProcessing={attachmentsProcessing} attachmentError={attachmentError} onClearAttachmentError={clearAttachmentError}
          canSend={props.llmReady} busy={busy} placeholder={learning.phase === "free_reading" ? "选中文字后向导师提问…" : "围绕当前分析角度讨论…"}
          quickActions={learning.phase === "article_analysis" && learning.currentFocus ? [{ label: "请直接讲解", onSelect: () => enqueue({ text: `请直接讲解「${currentFocusMeta?.label ?? "当前角度"}」，结合文章证据说明。`, focus: learning.currentFocus }) }] : []}
          onHint={() => enqueue({ text: learning.phase === "article_analysis" ? "请围绕当前角度给我一个分析提示。" : "请给我一点理解当前原文的提示。", focus: learning.currentFocus })}
          onSend={(text, attachments) => {
            if (!props.llmReady || (!text.trim() && !attachments.length)) return;
            enqueue({ text: text.trim(), images: attachments, selection: pendingSelectionRef.current, paragraphIdx: viewIdx, focus: learning.currentFocus });
            setInput(""); setPendingSelection(null); pendingSelectionRef.current = null; clearAttachments();
          }}
          onStop={stop}
        />
      </section>

      <section className={`${mobile === "reading" ? "flex" : "hidden"} min-h-0 flex-col lg:flex`}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-300 px-4 py-3">
          <div role="tablist" aria-label="阅读内容" className="flex gap-1">
            {([{ id: "source", label: "原文", icon: BookOpen }, { id: "notes", label: "我的笔记", icon: NotebookPen }, { id: "analysis", label: "文章分析", icon: MessageSquare }] as const).map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`flex items-center gap-2 px-3 py-2 text-sm ${tab === item.id ? "bg-neutral-900 text-white" : ""}`}><item.icon className="h-4 w-4" />{item.label}</button>)}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button aria-pressed={learning.phase === "free_reading"} disabled={analysisBusy || busy || learning.phase === "free_reading"} onClick={() => void changeLearning("return_to_reading")} className={`border px-3 py-2 ${learning.phase === "free_reading" ? "bg-neutral-900 text-white" : ""}`}>自由阅读</button>
            <button aria-pressed={learning.phase === "article_analysis"} disabled={learning.phase !== "article_analysis" || analysisBusy || busy} onClick={() => setTab("analysis")} className={`border px-3 py-2 ${learning.phase === "article_analysis" ? "bg-neutral-900 text-white" : ""}`}>文章分析</button>
          </div>
          <label className="flex items-center gap-2 text-sm">段落组<select aria-label="段落组" className="max-w-full border bg-white p-2" value={paragraphGroup} onChange={(event) => changeView(Math.min(Number(event.target.value) * 50, paragraphs.length - 1))}>{Array.from({ length: paragraphCount }, (_, group) => <option key={group} value={group}>第 {group + 1}/{paragraphCount} 组</option>)}</select></label>
          <select aria-label="查看段落" className="max-w-full border bg-white p-2 text-sm" value={viewIdx} onChange={(event) => changeView(Number(event.target.value))}>{visibleParagraphs.map((_, local) => { const index = paragraphStart + local; return <option key={index} value={index}>第 {index + 1} 段</option>; })}</select>
        </div>
        <div ref={sourceScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          {tab === "source" && <>
            {learning.phase === "free_reading" && <div className="mx-auto mb-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-4"><p className="text-sm text-neutral-600">自由阅读 · 已读到第 {viewIdx + 1}/{paragraphs.length} 段</p><button disabled={busy || analysisBusy || !props.analysisReady} onClick={() => void startAnalysis()} className="ink-button px-4 py-2 disabled:opacity-40"><Play className="h-4 w-4" />已读完整篇，开始分析</button></div>}
            {learning.phase === "article_analysis" && analysisStatus.status !== "ready" && <div className="mx-auto mb-5 max-w-3xl border border-neutral-300 bg-white p-4" role="status">
              <p className="font-medium">{analysisStatus.running ? "导师正在准备整篇文章分析" : "整篇分析资料尚未就绪"}</p>
              {analysisStatus.totalChunks > 0 && <p className="mt-1 text-sm text-neutral-500">已整理 {analysisStatus.completedChunks}/{analysisStatus.totalChunks} 个文章片段</p>}
              {analysisStatus.error && <p className="mt-2 text-sm text-red-700">{analysisStatus.error}</p>}
              {analysisStatus.resumable && <button disabled={analysisBusy} className="mt-3 border px-3 py-2 text-sm" onClick={() => void resumeAnalysis()}><RotateCcw className="mr-2 inline h-4 w-4" />续接全文分析</button>}
            </div>}
            <article data-reading-article lang={reading.language} className="mx-auto max-w-3xl space-y-6 text-lg leading-9" onMouseUp={handleSelection} onKeyUp={handleSelection} onTouchEnd={handleSelection}>
              {visibleParagraphs.map((paragraph, local) => {
                const index = paragraphStart + local;
                return <div key={paragraph.id} id={`reading-paragraph-${index}`} data-reading-paragraph={index} className={`scroll-mt-8 border-l-2 pl-5 ${index === viewIdx ? "border-neutral-900 bg-white py-3" : "border-transparent"}`}>
                  <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500"><span>{index + 1}{index === viewIdx ? " · 当前阅读位置" : ""}</span><span>来源页 {paragraph.page}</span></div>
                  <div data-reading-paragraph-text data-paragraph-id={paragraph.id}><Markdown className="md break-words" content={paragraph.text} /></div>
                  <button className="mt-2 text-xs text-neutral-500 underline" onClick={() => changeView(index)}>从此段继续阅读</button>
                </div>;
              })}
            </article>
            <div className="mx-auto mt-5 flex max-w-3xl items-center justify-between border-t border-neutral-300 pt-3"><button aria-label="上一段" disabled={viewIdx === 0} className="p-2 disabled:opacity-30" onClick={() => changeView(viewIdx - 1)}><ChevronLeft className="h-4 w-4" /></button><span className="text-sm">第 {viewIdx + 1}/{paragraphs.length} 段</span><button aria-label="下一段" disabled={viewIdx >= paragraphs.length - 1} className="p-2 disabled:opacity-30" onClick={() => changeView(viewIdx + 1)}><ChevronRight className="h-4 w-4" /></button></div>
          </>}

          {tab === "notes" && <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">我的阅读笔记</h2><p className="mt-1 text-sm text-neutral-500">个人笔记独立保存，不会被导师的分析笔记覆盖。</p></div><span role="status" className={`text-xs ${noteStatus.includes("失败") ? "text-red-700" : "text-neutral-500"}`}>{noteStatus}</span></div>
            <label className="block text-sm font-medium">全文笔记<textarea aria-label="全文笔记" value={docDraft} maxLength={65536} onChange={(event) => setDocDraft(event.target.value)} placeholder="记录整篇文章的问题、想法和读后感…" className="mt-2 min-h-56 w-full border border-neutral-300 bg-white p-4 text-sm leading-7" /></label>
            <details className="border border-neutral-200 bg-white"><summary className="cursor-pointer px-4 py-2 text-sm">预览全文笔记</summary><div className="p-4"><Markdown content={docDraft || "（还没有笔记）"} className="md break-words" /></div></details>
            {documentNote && <p className="text-xs text-neutral-500">最近保存：{new Date(documentNote.updatedAt).toLocaleString("zh-CN")}</p>}
            <div className="border-t border-neutral-300 pt-5"><h3 className="font-semibold">原文批注</h3>{personalNotes.filter((note) => note.kind === "annotation").length === 0 && <p className="mt-2 text-sm text-neutral-500">还没有批注。选中原文后点击“添加批注”。</p>}
              <div className="mt-3 space-y-4">{personalNotes.filter((note) => note.kind === "annotation").map((note) => <div key={note.id} className="border border-neutral-200 bg-white p-4">
                <button className="mb-3 block border-l-2 border-neutral-500 pl-3 text-left text-xs text-neutral-600" onClick={() => scrollToSelection(note.selection)}>{note.selection ? `原文：${selectedText(note.selection)}` : "原文选区"}</button>
                <textarea aria-label="编辑原文批注" value={annotationDrafts[note.id] ?? note.content} onChange={(event) => { setNoteStatus("保存中…"); setAnnotationDrafts((all) => ({ ...all, [note.id]: event.target.value })); }} className="min-h-24 w-full border border-neutral-200 p-3 text-sm leading-6" />
                <div className="mt-2 flex items-center justify-between gap-3"><span role="status" className="text-xs text-red-700">{noteErrors[note.id] || ""}</span><button className="text-xs text-neutral-500 underline" onClick={() => void deleteAnnotation(note.id)}>删除批注</button></div>
              </div>)}</div>
            </div>
            <div className="border-t border-neutral-300 pt-5"><button aria-expanded={historyTab} className="flex items-center gap-2 font-semibold" onClick={() => setHistoryTab(!historyTab)}><FileText className="h-4 w-4" />历史课堂笔记与练习（{historyMessages.length + Object.values(session.notes).flat().length}）</button>
              {historyTab && <div className="mt-4 space-y-4">{Object.entries(session.notes).flatMap(([paragraph, notes]) => notes.map((note, index) => <div key={`note-${paragraph}-${index}`} className="border-l-2 border-neutral-400 pl-3"><p className="mb-1 text-xs text-neutral-500">旧课堂导师笔记 · 第 {Number(paragraph) + 1} 段</p><Markdown content={note} className="md" /></div>))}{historyMessages.map((message) => <div key={message.id} className="border-l-2 border-neutral-300 pl-3"><p className="mb-1 text-xs text-neutral-500">旧课堂记录 · 第 {message.paragraphIdx + 1} 段</p><Markdown content={message.content} className="md" /></div>)}</div>}
            </div>
          </div>}

          {tab === "analysis" && <div className="mx-auto max-w-3xl space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">整篇文章分析</h2><p className="mt-1 text-sm text-neutral-500">从结构、写作思路和主旨开始；文学作品增加情感与表现手法。</p></div>{analysisStatus.status === "ready" && <label className="flex items-center gap-2 text-sm">文章类型<select aria-label="文章类型" value={learning.articleKind ?? "general"} disabled={analysisBusy || busy} onChange={(event) => void changeLearning("set_article_kind", { articleKind: event.target.value })} className="border bg-white p-2"><option value="general">普通文章</option><option value="literary">文学作品</option></select></label>}</div>
            {learning.phase === "free_reading" && <div className="border border-neutral-300 bg-white p-5"><p className="font-medium">先读完整篇文章，再开始整篇分析。</p><button disabled={!props.analysisReady || analysisBusy} className="ink-button mt-4 px-4 py-2 disabled:opacity-40" onClick={() => void startAnalysis()}><Play className="h-4 w-4" />已读完整篇，开始分析</button></div>}
            {learning.phase === "article_analysis" && analysisStatus.status !== "ready" && <div role="status" className="border border-neutral-300 bg-white p-5"><p className="font-medium">{analysisStatus.running ? "正在整理全文结构与依据" : "全文分析资料尚未准备完成"}</p>{analysisStatus.totalChunks > 0 && <p className="mt-2 text-sm text-neutral-500">已整理 {analysisStatus.completedChunks}/{analysisStatus.totalChunks} 个片段</p>}{analysisStatus.error && <p className="mt-2 text-sm text-red-700">{analysisStatus.error}</p>}{analysisStatus.resumable && <button className="mt-3 border px-3 py-2 text-sm" disabled={analysisBusy} onClick={() => void resumeAnalysis()}>续接全文准备</button>}</div>}
            {learning.phase === "article_analysis" && analysisStatus.status === "ready" && <>
              <div className="border-y-2 border-neutral-900 bg-white p-4"><h3 className="font-semibold">分析进度</h3><div className="mt-3 flex flex-wrap gap-2">{requiredFoci.map((focus) => <button key={focus.id} disabled={busy || analysisBusy} onClick={() => void changeLearning("set_focus", { focus: focus.id })} className={`flex items-center gap-2 border px-3 py-2 text-sm ${learning.currentFocus === focus.id ? "bg-neutral-900 text-white" : "bg-white"}`}><span>{focus.label}</span><span className="text-xs">{learning.focusStatus[focus.id] === "confirmed" ? "已确认" : learning.focusStatus[focus.id] === "in_progress" ? "进行中" : "未开始"}</span></button>)}</div></div>
              {learning.currentFocus && <section className="space-y-4 border border-neutral-300 bg-white p-5"><div><p className="text-xs text-neutral-500">当前分析角度</p><h3 className="mt-1 text-lg font-semibold">{currentFocusMeta?.label}</h3></div>
                {learning.analysisNotes[learning.currentFocus] && <div className="border-l-2 border-neutral-600 pl-4"><Markdown content={learning.analysisNotes[learning.currentFocus] ?? ""} className="md break-words" /></div>}
                <div className="flex flex-wrap gap-2"><button disabled={busy || !props.llmReady} className="ink-button px-4 py-2 disabled:opacity-40" onClick={() => { setMobile("chat"); enqueue({ text: `请围绕「${currentFocusMeta?.label}」向我提出一个具体问题，引导我结合文章分析。`, focus: learning.currentFocus }); }}><MessageSquare className="h-4 w-4" />开始讨论</button><button disabled={busy || !props.llmReady} className="border px-4 py-2 text-sm disabled:opacity-40" onClick={() => { setMobile("chat"); enqueue({ text: `请直接讲解「${currentFocusMeta?.label}」，结合文章原文和具体段落说明。`, focus: learning.currentFocus }); }}>直接讲解</button><button disabled={busy || analysisBusy || !learning.analysisNotes[learning.currentFocus]} className="ml-auto border border-neutral-900 px-4 py-2 text-sm disabled:opacity-40" onClick={() => void changeLearning("confirm_focus")}><Check className="mr-1 inline h-4 w-4" />这个角度已理解</button></div>
              </section>}
              {!learning.currentFocus && requiredFoci.every((focus) => learning.focusStatus[focus.id] === "confirmed") && <section className="border border-neutral-300 bg-white p-5"><h3 className="font-semibold">各分析角度已确认</h3>{learning.summary ? <div className="mt-4"><Markdown content={learning.summary} className="md break-words" />{learning.analysisCompletedAt ? <p role="status" className="mt-5 border-l-2 border-neutral-900 pl-3 text-sm font-medium">本篇分析已完成</p> : <button disabled={analysisBusy || busy} className="ink-button mt-5 px-4 py-2 disabled:opacity-40" onClick={() => void changeLearning("complete_analysis")}><Check className="h-4 w-4" />完成本篇分析</button>}</div> : <><p className="mt-2 text-sm text-neutral-600">导师会依据已确认的角度整理整篇总结。</p><button disabled={busy || !props.llmReady} className="ink-button mt-4 px-4 py-2 disabled:opacity-40" onClick={() => { setMobile("chat"); enqueue({ text: "请整理整篇文章的最终分析总结。", intent: "analysis_summary" }); }}><FileText className="h-4 w-4" />生成整篇总结</button></>}</section>}
              <button disabled={analysisBusy || busy} className="text-sm text-neutral-600 underline disabled:opacity-40" onClick={() => void changeLearning("return_to_reading")}>回到自由阅读</button>
            </>}
          </div>}
        </div>
      </section>
    </div>

    {selectionBar && <div className="fixed z-[70] flex max-w-[calc(100vw-24px)] flex-wrap gap-1 border border-neutral-300 bg-neutral-900 p-2 text-white shadow-xl" style={{ left: selectionBar.x, top: selectionBar.y }}>
      <span className="max-w-48 truncate px-2 py-2 text-xs text-neutral-300">{selectionBar.quote}</span>
      {([{ task: "vocabulary", label: "解释词语", prompt: "请解释我选中的词语在此处的含义和语境。" }, { task: "grammar", label: "分析语法", prompt: "请分析我选中句子的语法结构和关键用法。" }, { task: "meaning", label: "说明句意", prompt: "请用简洁中文说明我选中内容的句意。" }] as const).map((item) => <button key={item.label} className="px-2 py-2 text-xs hover:bg-neutral-700" onClick={() => askAboutSelection(item.task, item.prompt)}>{item.label}</button>)}
      <button className="px-2 py-2 text-xs hover:bg-neutral-700" onClick={attachSelectionToComposer}>自由提问</button><button className="px-2 py-2 text-xs hover:bg-neutral-700" onClick={startAnnotationFromSelection}><Highlighter className="mr-1 inline h-3.5 w-3.5" />添加批注</button>
      <button aria-label="关闭选区工具栏" className="px-2 py-2 text-xs hover:bg-neutral-700" onClick={() => setSelectionBar(null)}><X className="h-4 w-4" /></button>
    </div>}

    {annotationEditor && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-neutral-900/50 p-4"><section role="dialog" aria-modal="true" aria-label="添加原文批注" className="w-full max-w-lg space-y-4 bg-white p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">添加原文批注</h2><button aria-label="关闭" onClick={() => setAnnotationEditor(null)}><X className="h-4 w-4" /></button></div><blockquote className="border-l-2 border-neutral-500 pl-3 text-sm text-neutral-600">{selectedText(annotationEditor)}</blockquote><textarea aria-label="批注内容" autoFocus value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder="写下对这段原文的想法…" className="min-h-32 w-full border border-neutral-300 p-3 text-sm leading-6" /><div className="flex justify-end gap-2"><button className="border px-4 py-2 text-sm" onClick={() => setAnnotationEditor(null)}>取消</button><button disabled={savingAnnotation || !annotationText.trim()} className="ink-button px-4 py-2 disabled:opacity-40" onClick={() => void createAnnotation()}>{savingAnnotation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}保存批注</button></div></section></div>}
  </div>;
}
