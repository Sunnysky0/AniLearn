import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookChapterStates, bookMessages, bookPersonalNotes, bookTurns, bookSessions } from "@/db/books-schema";
import type { BookChapterLearning, BookMessage, BookTurnEvent, BookTurnRequest } from "@/lib/types";
import { validateReaderAnchor } from "@/lib/reader/anchors";
import { validBookId } from "@/lib/server/book-catalog";
import { loadBookSession, bookMessageDTO, bookSessionDTO, bookStateDTO, bookNoteDTO, safeBookError } from "@/lib/server/book-sessions";
import { allowedPreviousMemories, bookFoci, bookQuestionEvidence, bookTurnHash } from "@/lib/server/book-learning";
import { bookTurnSystem, BOOK_TURN_TAGS, BookSelectionResponseError, validateBookSelectionAnswer, bookQuoteAnchor } from "@/lib/server/book-prompts";
import { tryOperationLock } from "@/lib/server/locks";
import { getSettings, getLLMConfig } from "@/lib/server/settings";
import { parseDataUrl, streamChat, type LLMMessage, type LLMPart } from "@/lib/server/llm";
import { readChatInputRequest } from "@/lib/server/chat-input";
import { createTagParser, innerTag, type TagBlock } from "@/lib/server/protocol";
import { prepareTutorMessages } from "@/lib/server/tutor-output";
import { hasJapaneseText } from "@/lib/text";
import { toTutorDTO } from "@/lib/server/data";
import { bookPreparationKey } from "@/lib/server/book-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

async function replay(id: number, turn: typeof bookTurns.$inferSelect) {
  const bundle = await loadBookSession(id); if (!bundle) throw new Error("课堂不存在。");
  const rows = await db.select().from(bookMessages).where(eq(bookMessages.turnId, turn.id)).orderBy(asc(bookMessages.id));
  const events: BookTurnEvent[] = rows.map(row => ({ type: "message", message: bookMessageDTO(row) }));
  const state = bundle.states.find(state => state.chapterId === turn.chapterId);
  if (state) events.push({ type: "analysis", chapter: bookStateDTO(state) });
  events.push({ type: "done", requestId: turn.requestId, session: bookSessionDTO(bundle.session, bundle.states), action: "wait", goodbye: turn.intent === "goodbye" });
  return new Response(events.map(event => JSON.stringify(event) + "\n").join(""), { headers });
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validBookId((await ctx.params).id); if (!id) return Response.json({ error: "课堂编号无效。" }, { status: 400 });
  const release = await tryOperationLock("bookSession", id); if (!release) return Response.json({ error: "上一轮仍在进行，请稍后重试。" }, { status: 409 });
  let handedOff = false;
  try {
    const parsed = await readChatInputRequest(req); const body = parsed.body as unknown as BookTurnRequest;
    if (typeof body.requestId !== "string" || !/^[\w-]{16,140}$/.test(body.requestId) || typeof body.chapterId !== "string" || !Number.isSafeInteger(body.versionId) || !Number.isSafeInteger(body.stateRevision) || !["free_reading", "chapter_analysis"].includes(body.phase)) throw new Error("课堂请求格式无效。");
    const bundle = await loadBookSession(id, body.chapterId);
    if (!bundle || body.versionId !== bundle.session.versionId) return Response.json({ error: "典籍版本或章节不匹配。" }, { status: 409 });
    const anchor = body.anchor == null ? null : validateReaderAnchor(bundle.document, body.anchor);
    if (body.anchor != null && !anchor) throw new Error("原文选区与当前章节不匹配。");
    if (body.selectionTask !== undefined && !["vocabulary", "grammar", "meaning"].includes(body.selectionTask)) throw new Error("划词操作无效。");
    if (body.selectionTask && (!anchor || parsed.images.length || body.intent)) throw new Error("划词操作需要原文选区，不能附带图片或其他课堂动作。");
    if (body.intent !== undefined && !["continue", "goodbye", "chapter_summary"].includes(body.intent)) throw new Error("课堂动作无效。");
    if (body.intent === "goodbye" && (parsed.text || parsed.images.length || anchor) || body.intent === "chapter_summary" && (parsed.images.length || anchor)) throw new Error("此课堂动作不能附带选区或图片。");
    if (!parsed.text && !parsed.images.length && !anchor && !body.intent) throw new Error("请输入问题或选择原文。");
    if (body.noteIds !== undefined && (!Array.isArray(body.noteIds) || body.noteIds.length > 8 || body.noteIds.some(value => !validBookId(value)) || new Set(body.noteIds).size !== body.noteIds.length)) throw new Error("附加笔记编号无效。");
    const request: BookTurnRequest = { ...body, anchor };
    const hash = bookTurnHash(request, parsed.text, parsed.images);
    let [turn] = await db.select().from(bookTurns).where(and(eq(bookTurns.sessionId, id), eq(bookTurns.requestId, body.requestId)));
    if (turn && turn.inputHash !== hash) return Response.json({ error: "此请求编号已用于其他内容。" }, { status: 409 });
    if (turn?.status === "success") return await replay(id, turn);
    const learning = bundle.state.learning;
    if (bundle.session.currentChapterId !== body.chapterId || learning.phase !== body.phase || learning.stateRevision !== body.stateRevision || body.focus !== undefined && body.focus !== learning.currentFocus) return Response.json({ error: "章节或导读状态已变化，请同步后重试。" }, { status: 409 });
    if (body.phase === "chapter_analysis" && (bundle.state.analysisDraft?.status !== "ready" || bundle.state.analysisDraft.sourceKey !== bookPreparationKey(bundle.document))) return Response.json({ error: "本章导读资料尚未准备完成，请续接准备。" }, { status: 409 });
    if (body.intent === "chapter_summary" && (body.phase !== "chapter_analysis" || !bookFoci(bundle.material.book.kind).every(focus => learning.focusStatus[focus] === "confirmed"))) return Response.json({ error: "请先确认本章全部导读角度。" }, { status: 409 });
    const allNotes = await db.select().from(bookPersonalNotes).where(eq(bookPersonalNotes.versionId, bundle.session.versionId));
    const requestedNotes = new Set(body.noteIds ?? []);
    if ([...requestedNotes].some(noteId => !allNotes.some(note => note.id === noteId && (note.kind === "book" || note.chapterId === body.chapterId)))) throw new Error("附加笔记不属于当前版本和章节。");
    const notes = allNotes.filter(note => note.chapterId === body.chapterId || note.kind === "book" && requestedNotes.has(note.id)).map(bookNoteDTO);
    const recovering = !!turn;
    if (!turn) [turn] = await db.insert(bookTurns).values({ sessionId: id, requestId: body.requestId, inputHash: hash, chapterId: body.chapterId, phase: body.phase, focus: body.focus ?? null, intent: body.intent ?? null }).returning();
    else [turn] = await db.update(bookTurns).set({ status: "running", updatedAt: new Date() }).where(eq(bookTurns.id, turn.id)).returning();
    const turnId = turn.id;
    const existingUser = await db.select({ id: bookMessages.id }).from(bookMessages).where(and(eq(bookMessages.turnId, turnId), eq(bookMessages.role, "user")));
    if (!existingUser.length && (parsed.text || parsed.images.length || anchor)) await db.insert(bookMessages).values({ sessionId: id, turnId, chapterId: body.chapterId, role: "user", content: parsed.text,
      attachments: parsed.images, phase: body.phase, focus: body.focus ?? null, anchor });
    const history = await db.select().from(bookMessages).where(and(eq(bookMessages.sessionId, id), eq(bookMessages.chapterId, body.chapterId))).orderBy(asc(bookMessages.id));
    const imageIds = new Set(history.filter(message => message.role === "user" && message.attachments.length).slice(-2).map(message => message.id));
    let remaining = 16000; const bounded = [] as typeof history;
    for (const message of history.slice(-24).reverse()) { if (remaining <= 0) break; bounded.unshift(message); remaining -= message.content.length; }
    const messages: LLMMessage[] = bounded.map(message => {
      const content = message.content + (message.anchor ? `\n[本轮原文选区]\n${message.anchor.segments.map(segment => segment.quote).join("\n")}` : "");
      if (!imageIds.has(message.id)) return { role: message.role === "user" ? "user" : "assistant", content };
      const parts: LLMPart[] = [{ type: "text", text: content || "学生发送了提问图片。" }];
      for (const image of message.attachments) { const parsed = parseDataUrl(image); if (parsed) parts.push({ type: "image", mime: parsed.mime, data: parsed.data }); }
      return { role: "user", content: parts };
    });
    if (!bounded.some(message => message.turnId === turnId && message.role === "user")) messages.push({ role: "user", content: parsed.text || (body.intent === "goodbye" ? "本次阅读到这里，再见。" : body.intent === "chapter_summary" ? "请生成本章总结。" : "请继续当前角度的讨论。") });
    const cfg = getLLMConfig(await getSettings(), "chat");
    const system = bookTurnSystem({ tutor: toTutorDTO(bundle.tutor), document: bundle.document, kind: bundle.material.book.kind, learning, request,
      evidence: bookQuestionEvidence(bundle.document, request, bundle.state.position), context: bundle.state.analysisDraft?.context ?? "",
      memories: allowedPreviousMemories(bundle.material.chapters, body.chapterId, bundle.states.map(state => ({ chapterId: state.chapterId, learning: state.learning, analysis: state.analysisDraft ?? undefined }))), notes, recovering });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("课堂回复超时。")), 270000);
    const abort = () => controller.abort(); req.signal.addEventListener("abort", abort, { once: true }); if (req.signal.aborted) abort();
    handedOff = true;
    return new Response(new ReadableStream<Uint8Array>({
      async start(output) {
        const send = (event: BookTurnEvent) => { try { output.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); } catch { controller.abort(); } };
        const base = { sessionId: id, turnId, chapterId: body.chapterId, role: "tutor", phase: body.phase, focus: learning.currentFocus };
        const pendingNotes: { focus: NonNullable<BookTurnRequest["focus"]>; content: string }[] = []; let summary = ""; let messageCount = 0; let action = 0; let committed = false;
        const answers: (typeof bookMessages.$inferInsert)[] = [];
        const prepare = async (block: TagBlock) => {
          if (!block.closed || action) throw new Error("导师输出没有完整结束，动作必须位于末尾。");
          if (block.tag === "action") { if (block.body.trim() !== "wait") throw new Error("课堂动作必须等待学生。"); action++; return; }
          if (block.tag === "msg") {
            const match = /^\s*<zh(?:\s[^>]*)?>([\s\S]*?)<\/zh\s*>\s*<ja(?:\s[^>]*)?>([\s\S]*?)<\/ja\s*>\s*$/i.exec(block.body);
            if (!match) throw new Error("导师短消息格式无效。");
            const prepared = await prepareTutorMessages(cfg, innerTag(block.body, "zh") ?? "", innerTag(block.body, "ja") ?? "", controller.signal, bundle.tutor.voiceStyle);
            for (const item of prepared) answers.push({ ...base, kind: "text", language: "zh-CN", content: item.zh, speech: item.ja });
          } else if (block.tag === "quote") {
            if (body.intent === "goodbye") throw new Error("道别时不应讲解新内容。");
            const quoteAnchor = bookQuoteAnchor(bundle.document, block);
            if (!quoteAnchor) throw new Error("原文引用与当前章节不符。");
            answers.push({ ...base, kind: "quote", language: bundle.material.book.language, content: block.body.trim(), speech: "", anchor: quoteAnchor });
          } else if (block.tag === "example" || block.tag === "exercise") {
            if (body.intent === "goodbye" || block.tag === "exercise" && body.phase === "free_reading" || block.attrs.lang !== bundle.document.language || !block.body.trim()) throw new Error("本轮例句或练习格式无效。");
            answers.push({ ...base, kind: block.tag, language: bundle.material.book.language, content: block.body.trim(), speech: "" });
          } else if (block.tag === "analysis-note") {
            if (body.intent === "goodbye" || body.phase !== "chapter_analysis" || !learning.currentFocus || block.attrs.focus !== learning.currentFocus || !block.body.trim() || hasJapaneseText(block.body.replace(/```(?:en|ja|zh)\s*\n[\s\S]*?```/g, ""))) throw new Error("本章分析笔记格式无效。");
            pendingNotes.push({ focus: learning.currentFocus, content: block.body.trim() });
          } else if (block.tag === "analysis-summary") {
            if (body.intent !== "chapter_summary" || !block.body.trim() || hasJapaneseText(block.body)) throw new Error("本章总结格式无效。");
            summary = block.body.trim();
          }
        };
        const persistAnswers = async () => {
          while (answers.length) { const value = answers.shift()!; const [row] = await db.insert(bookMessages).values(value).returning(); messageCount++; send({ type: "message", message: bookMessageDTO(row) }); }
        };
        try {
          const user = history.find(message => message.turnId === turnId && message.role === "user"); if (user) send({ type: "message", message: bookMessageDTO(user) });
          if (body.selectionTask && anchor) {
            let accepted: TagBlock[] = [];
            for (let attempt = 0; attempt < 2; attempt++) {
              const parser = createTagParser(BOOK_TURN_TAGS); const blocks: TagBlock[] = [];
              for await (const delta of streamChat(cfg, { system: system + (attempt ? "\n上一候选未展示，引用或输出形状不合格。重新按真实选区顺序逐字quote，然后中文msg和唯一wait。" : ""), messages, maxTokens: 8192, signal: controller.signal })) blocks.push(...parser.push(delta));
              blocks.push(...parser.end()); controller.signal.throwIfAborted();
              try { validateBookSelectionAnswer(blocks, parser.stray(), bundle.document, anchor); accepted = blocks; break; }
              catch (cause) { if (!(cause instanceof BookSelectionResponseError) || controller.signal.aborted || attempt) throw cause; }
            }
            for (const block of accepted) await prepare(block);
            controller.signal.throwIfAborted();
            const rows = await db.transaction(async tx => { const rows = await tx.insert(bookMessages).values(answers).returning(); controller.signal.throwIfAborted(); await tx.update(bookTurns).set({ status: "success", action: "wait", updatedAt: new Date() }).where(eq(bookTurns.id, turnId)); return rows; });
            committed = true;
            for (const row of rows) send({ type: "message", message: bookMessageDTO(row) });
          } else {
            const parser = createTagParser(BOOK_TURN_TAGS);
            for await (const delta of streamChat(cfg, { system, messages, maxTokens: 8192, signal: controller.signal })) for (const block of parser.push(delta)) { await prepare(block); await persistAnswers(); }
            for (const block of parser.end()) { await prepare(block); await persistAnswers(); }
            controller.signal.throwIfAborted();
            if (parser.stray().trim() || action !== 1 || !messageCount || body.intent === "chapter_summary" && !summary) throw new Error("导师回复没有完整结束，请重试。");
            const next: BookChapterLearning = { ...learning, analysisNotes: { ...learning.analysisNotes }, stateRevision: learning.stateRevision + (pendingNotes.length || summary ? 1 : 0) };
            for (const note of pendingNotes) next.analysisNotes[note.focus] = note.content;
            if (summary) { next.summary = summary; next.memory = summary.slice(0, 4000); }
            const state = await db.transaction(async tx => {
              const [saved] = await tx.update(bookChapterStates).set({ learning: next }).where(eq(bookChapterStates.id, bundle.state.id)).returning();
              await tx.update(bookTurns).set({ status: "success", action: "wait", updatedAt: new Date() }).where(eq(bookTurns.id, turnId));
              await tx.update(bookSessions).set({ updatedAt: new Date() }).where(eq(bookSessions.id, id));
              return saved;
            });
            committed = true;
            if (pendingNotes.length || summary) send({ type: "analysis", chapter: bookStateDTO(state) });
          }
          const latest = await loadBookSession(id); if (!latest) throw new Error("课堂不存在。");
          send({ type: "done", requestId: body.requestId, session: bookSessionDTO(latest.session, latest.states), action: "wait", goodbye: body.intent === "goodbye" });
        } catch (cause) {
          if (!committed) await db.update(bookTurns).set({ status: controller.signal.aborted ? "cancelled" : "failed", updatedAt: new Date() }).where(and(eq(bookTurns.id, turnId), eq(bookTurns.status, "running"))).catch(() => undefined);
          if (!req.signal.aborted) send({ type: "error", error: safeBookError(cause, "导师回复失败，请重试。") });
        } finally { clearTimeout(timeout); req.signal.removeEventListener("abort", abort); await release(); try { output.close(); } catch { /* Browser disconnected. */ } }
      }, cancel() { controller.abort(); },
    }), { headers });
  } catch (cause) { return Response.json({ error: safeBookError(cause, "课堂请求失败，请重试。") }, { status: 400 }); }
  finally { if (!handedOff) await release(); }
}
