"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { BookOpen, NotebookPen, MessageSquare, Send, Square, Volume2, VolumeX, ChevronLeft, ChevronRight, LogOut, Play } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { revealTutorMessage } from "@/lib/client/tutor-playback";
import { tokenizeForReveal } from "@/lib/text";
import type { ReadingDTO, ReadingSessionDTO, ReadingMessage, ReadingTurnEvent, TutorDTO } from "@/lib/types";

type Request = { text: string; intent?: "next" | "goodbye"; paragraphIdx?: number };
export default function ReadingClassroom(props: { reading: ReadingDTO; session: ReadingSessionDTO; tutor: TutorDTO; initialMessages: ReadingMessage[]; ttsReady: boolean; llmReady: boolean }) {
  const { reading, tutor } = props;
  const [session, setSession] = useState(props.session); const sessionRef = useRef(props.session);
  const [messages, setMessages] = useState(props.initialMessages); const [input, setInput] = useState(""); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [entered, setEntered] = useState(false); const [muted, setMuted] = useState(!props.ttsReady);
  const mutedRef = useRef(!props.ttsReady); const [rate, setRate] = useState(1); const rateRef = useRef(1);
  const [tab, setTab] = useState<"source" | "notes" | "practice">("source"); const [mobile, setMobile] = useState<"chat" | "reading">("reading");
  const [viewIdx, setViewIdx] = useState(session.currentIdx); const [typing, setTyping] = useState<{ id: number; shown: number | null } | null>(null);
  const [canExit, setCanExit] = useState(session.status === "completed"); const [lastRequest, setLastRequest] = useState<Request | null>(null);
  const pending = useRef<Request[]>([]); const running = useRef(false); const request = useRef<AbortController | null>(null); const playback = useRef<AbortController | null>(null);
  const disposed = useRef(false); const optimistic = useRef(-1); const chatEnd = useRef<HTMLDivElement>(null);
  const autoCount = useRef(0);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  const append = (message: ReadingMessage) => setMessages((all) => all.some((m) => m.id === message.id) ? all : [...all, message]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }); }, [messages.length, typing]);
  useEffect(() => { if (tab === "source") document.getElementById(`paragraph-${viewIdx}`)?.scrollIntoView({ block: "nearest" }); }, [viewIdx, tab, entered, mobile]);
  useEffect(() => { disposed.current = false; return () => { disposed.current = true; pending.current = []; request.current?.abort(); playback.current?.abort(); }; }, []);
  async function play(message: ReadingMessage) {
    const ac = new AbortController(); playback.current = ac;
    await revealTutorMessage({ text: message.content, speech: message.speech, voiceId: tutor.voiceId, muted: () => mutedRef.current, rate: () => rateRef.current,
      signal: ac.signal, onReveal: (shown) => { if (!disposed.current) setTyping({ id: message.id, shown }); } });
    if (playback.current === ac) playback.current = null;
    if (!disposed.current) setTyping(null);
  }
  function stop() { request.current?.abort(); playback.current?.abort(); setCanExit(false); }
  async function runQueue() {
    if (running.current || disposed.current) return; running.current = true; setBusy(true); setCanExit(false);
    try {
      while (pending.current.length && !disposed.current) {
        const next = pending.current.shift()!; const idx = next.paragraphIdx ?? sessionRef.current.currentIdx;
        setLastRequest({ ...next, paragraphIdx: idx }); setError(""); const ac = new AbortController(); request.current = ac;
        let done: Extract<ReadingTurnEvent, { type: "done" }> | undefined; let eof = false;
        const localId = optimistic.current--; if (next.text) append({ id: localId, role: "user", content: next.text, speech: "", kind: "text", language: reading.language, paragraphIdx: idx });
        try {
          let response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...next, paragraphIdx: idx }), signal: ac.signal });
          for (let attempt = 0; response.status === 409 && attempt < 4 && !ac.signal.aborted; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            response = await fetch(`/api/reading-sessions/${sessionRef.current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...next, paragraphIdx: idx }), signal: ac.signal });
          }
          if (!response.ok || !response.body) { const data = await response.json(); throw new Error(data.error || "讲解请求失败"); }
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
          let processing = Promise.resolve(); let processingError: unknown;
          const handle = async (event: ReadingTurnEvent) => {
            if (event.type === "error") throw new Error(event.error);
            if (event.type === "message") {
              if (event.message.role === "user") setMessages((all) => [...all.filter((m) => m.id !== localId && m.id !== event.message.id), event.message]);
              else { append(event.message); if (!ac.signal.aborted) await play(event.message); }
            } else if (event.type === "notes") setSession((s) => ({ ...s, notes: { ...s.notes, [String(event.paragraphIdx)]: event.notes } }));
            else if (event.type === "done") { done = event; sessionRef.current = event.session; setSession(event.session); setViewIdx(event.session.currentIdx); }
          };
          const queue = (event: ReadingTurnEvent) => { processing = processing.then(async () => { if (!processingError && !ac.signal.aborted) await handle(event); }).catch((e) => { processingError = e; }); };
          for (;;) { const chunk = await reader.read(); if (chunk.done) { buffer += decoder.decode(); eof = true; break; } buffer += decoder.decode(chunk.value, { stream: true }); let nl; while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (line.trim()) queue(JSON.parse(line)); } }
          if (buffer.trim()) queue(JSON.parse(buffer));
          await processing;
          if (processingError) throw processingError;
          if (!done || !eof) throw new Error("讲解连接提前结束，请重试");
          if (!ac.signal.aborted && (done.goodbye || done.session.status === "completed") && !pending.current.length) setCanExit(true);
          if (!ac.signal.aborted && done.action === "continue" && !done.goodbye && !pending.current.length && autoCount.current < 6) { autoCount.current++; pending.current.push({ text: "" }); }
        } catch (e) { if (!ac.signal.aborted && !disposed.current) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (request.current === ac) request.current = null; }
      }
    } finally { running.current = false; if (!disposed.current) setBusy(false); }
  }
  function enqueue(next: Request) { autoCount.current = 0; pending.current.push(next); if (running.current) stop(); void runQueue(); }
  async function replay(message: ReadingMessage) { if (running.current) return; running.current = true; setBusy(true); try { await play(message); } finally { running.current = false; setBusy(false); void runQueue(); } }
  async function jump(idx: number) {
    if (busy || idx === session.currentIdx) return; setBusy(true); setError("");
    try { const response = await fetch(`/api/reading-sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentIdx: idx }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); sessionRef.current = data; setSession(data); setViewIdx(idx); setCanExit(false); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  function enter() { setEntered(true); if (!messages.some((m) => m.role === "tutor") && session.status !== "completed" && props.llmReady) enqueue({ text: "" }); }
  const paragraphs = reading.paragraphs; const paragraphGroup = Math.floor(viewIdx / 50); const paragraphStart = paragraphGroup * 50; const paragraphCount = Math.max(1, Math.ceil(paragraphs.length / 50)); const visibleParagraphs = paragraphs.slice(paragraphStart, paragraphStart + 50); const exercises = messages.filter((m) => m.paragraphIdx === viewIdx && (m.kind === "exercise" || m.kind === "feedback" || m.role === "user"));
  const textFor = (m: ReadingMessage) => typing?.id === m.id && typing.shown !== null ? tokenizeForReveal(m.content).slice(0, typing.shown).join("") : m.content;
  return <div className="flex h-dvh flex-col overflow-hidden bg-[#fafafa] text-neutral-900">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b-2 border-neutral-900 px-4 py-2"><span className="font-serif font-bold">AniLearn</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{reading.title}</span>
      <button className="p-2" title={muted ? "开启语音" : "静音"} aria-label={muted ? "开启语音" : "静音"} onClick={() => { if (!muted) playback.current?.abort(); setMuted(!muted); }}>{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
      <select aria-label="语速" value={rate} onChange={(e) => setRate(Number(e.target.value))} className="bg-transparent text-sm"><option value={1}>1x</option><option value={1.25}>1.25x</option><option value={1.5}>1.5x</option></select>
      {canExit && !busy ? <Link href="/" className="flex items-center gap-2 text-sm"><LogOut className="h-4 w-4" />返回首页</Link> : <button disabled={busy && lastRequest?.intent === "goodbye"} className="flex items-center gap-2 text-sm" onClick={() => enqueue({ text: "就到这里，再见", intent: "goodbye" })}><LogOut className="h-4 w-4" />结束本次阅读</button>}
    </header>
    <div className="flex shrink-0 border-b lg:hidden"><button className={`flex-1 py-2 text-sm ${mobile === "chat" ? "bg-neutral-900 text-white" : ""}`} onClick={() => setMobile("chat")}>导师</button><button className={`flex-1 py-2 text-sm ${mobile === "reading" ? "bg-neutral-900 text-white" : ""}`} onClick={() => setMobile("reading")}>阅读</button></div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(300px,38%)_1fr]">
      <section className={`${mobile === "chat" ? "flex" : "hidden"} min-h-0 flex-col border-r border-neutral-300 lg:flex`}>
        <div className="flex items-center gap-3 border-b px-4 py-3"><Image src={tutor.avatar} alt={tutor.name} width={40} height={40} unoptimized className="h-10 w-10 object-cover" /><div className="min-w-0"><h2 className="font-semibold">{tutor.name}</h2><span className="text-xs text-neutral-500">第 {session.currentIdx + 1} 段 · {session.status === "completed" ? "本篇已读完" : "陪伴导读"}</span></div></div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">{messages.map((m) => <div key={m.id} className={`${m.role === "user" ? "ml-8 bg-neutral-100" : "mr-4 bg-white"} border border-neutral-300 p-3`}>
          {m.language !== "zh-CN" && <div className="mb-1 text-xs text-neutral-500">{m.language === "ja" ? "日语" : "英语"}{m.kind === "exercise" ? "练习" : m.role === "user" ? "回答" : m.kind === "example" ? "例句" : "原文引用"}</div>}
          <Markdown content={textFor(m) || " "} className="md break-words" />
          {m.role === "tutor" && m.speech && !muted && <button disabled={busy} title="重播语音" aria-label="重播语音" className="mt-2 p-1 disabled:opacity-30" onClick={() => void replay(m)}><Volume2 className="h-3 w-3" /></button>}
        </div>)}<div ref={chatEnd} /></div>
        {error && <div role="alert" className="border-t px-4 py-2 text-sm">{error}<button className="ml-3 underline" onClick={() => { if (lastRequest) enqueue(lastRequest); }}>重试</button></div>}
        <form className="shrink-0 border-t p-3" onSubmit={(e) => { e.preventDefault(); if (input.trim()) { enqueue({ text: input.trim() }); setInput(""); } }}>
          <div className="flex items-end gap-2"><textarea aria-label="向导师提问或作答" className="min-h-20 min-w-0 flex-1 resize-none border border-neutral-300 bg-white p-2 text-sm" value={input} onChange={(e) => setInput(e.target.value)} />
            {busy && <button type="button" title="打断" aria-label="打断" className="p-2" onClick={stop}><Square className="h-5 w-5" /></button>}<button disabled={!props.llmReady || !input.trim()} title="发送" aria-label="发送" className="bg-neutral-900 p-3 text-white disabled:opacity-30"><Send className="h-4 w-4" /></button></div>
        </form>
      </section>
      <section className={`${mobile === "reading" ? "flex" : "hidden"} min-h-0 flex-col lg:flex`}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-300 px-4 py-3"><div role="tablist" aria-label="阅读内容" className="flex gap-1">{([{ id: "source", label: "原文", icon: BookOpen }, { id: "notes", label: "笔记", icon: NotebookPen }, { id: "practice", label: "练习", icon: MessageSquare }] as const).map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-2 px-3 py-2 text-sm ${tab === t.id ? "bg-neutral-900 text-white" : ""}`}><t.icon className="h-4 w-4" />{t.label}</button>)}</div>
          <label className="ml-auto flex items-center gap-2 text-sm">段落组<select aria-label="段落组" className="max-w-full border bg-white p-2" value={paragraphGroup} onChange={(e) => { const group = Number(e.target.value); setViewIdx(Math.min(group * 50, paragraphs.length - 1)); }}>{Array.from({ length: paragraphCount }, (_, group) => <option key={group} value={group}>第 {group + 1}/{paragraphCount} 组</option>)}</select></label>
          <select aria-label="查看段落" className="max-w-full border bg-white p-2 text-sm" value={viewIdx} onChange={(e) => setViewIdx(Number(e.target.value))}>{visibleParagraphs.map((_, local) => { const i = paragraphStart + local; return <option key={i} value={i}>第 {i + 1} 段{session.progress[String(i)] === "done" ? " · 已读" : i === session.currentIdx ? " · 当前" : ""}</option>; })}</select></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          {tab === "source" ? <article lang={reading.language} className="mx-auto max-w-3xl space-y-6 text-lg leading-9">{visibleParagraphs.map((p, local) => { const i = paragraphStart + local; return <div key={p.id} id={`paragraph-${i}`} className={`scroll-mt-8 border-l-2 pl-5 ${i === viewIdx ? "border-neutral-900 bg-white py-3" : "border-transparent"}`}><div className="mb-1 text-xs text-neutral-500">{i + 1}{i === session.currentIdx ? " · 当前段落" : ""}</div><Markdown className="md break-words" content={p.text} /><button disabled={busy} className="mt-2 text-xs text-neutral-500 underline" onClick={() => void jump(i)}>从此段阅读</button></div>; })}</article> : tab === "notes" ? <div className="mx-auto max-w-3xl space-y-5">{(session.notes[String(viewIdx)] ?? []).map((note, i) => <Markdown key={i} className="md break-words" content={note} />)}{!session.notes[String(viewIdx)]?.length && <p className="text-sm text-neutral-500">本段暂无笔记</p>}</div> : <div className="mx-auto max-w-3xl space-y-5">{exercises.map((m) => <div key={m.id} className="border-b border-neutral-300 pb-4"><div className="mb-2 text-xs text-neutral-500">{m.role === "user" ? "你的回答" : m.kind === "feedback" ? "导师反馈" : "练习"}</div><Markdown className="md break-words" content={m.content} /></div>)}{!exercises.length && <p className="text-sm text-neutral-500">本段暂无练习记录</p>}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-neutral-300 p-4"><div className="flex items-center gap-2"><button title="上一段" aria-label="上一段" disabled={viewIdx === 0} className="p-2 disabled:opacity-30" onClick={() => setViewIdx(viewIdx - 1)}><ChevronLeft className="h-4 w-4" /></button><span className="text-sm">{viewIdx + 1} / {paragraphs.length}</span><button title="下一段" aria-label="下一段" disabled={viewIdx >= paragraphs.length - 1} className="p-2 disabled:opacity-30" onClick={() => setViewIdx(viewIdx + 1)}><ChevronRight className="h-4 w-4" /></button></div>
          <button disabled={busy || session.status === "completed" || !props.llmReady} onClick={() => enqueue({ text: "我已理解本段，可以继续。", intent: "next" })} className="flex items-center gap-2 bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-30">理解了，继续<ChevronRight className="h-4 w-4" /></button></div>
      </section>
    </div>
    {!entered && <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 p-4"><div className="w-full max-w-md bg-white p-6 text-center"><h1 className="break-words text-xl font-semibold">{reading.title}</h1><Image src={tutor.avatar} alt={tutor.name} width={96} height={96} unoptimized className="mx-auto my-5 h-24 w-24 object-cover" /><p className="text-sm">{tutor.name} · 第 {session.currentIdx + 1} 段</p>{!props.llmReady && <Link href="/settings" className="mt-4 block text-sm underline">配置讲解模型</Link>}<button className="ink-button mx-auto mt-6 px-6 py-3" onClick={enter}><Play className="h-4 w-4" />进入阅读课堂</button></div></div>}
  </div>;
}
