import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { freeMessages, freeSessions, freeTopics, freeTurns } from "@/db/schema";
import { getLLMConfig, getSettings } from "@/lib/server/settings";
import { tryOperationLock } from "@/lib/server/locks";
import { streamChat } from "@/lib/server/llm";
import { createTagParser, type TagBlock } from "@/lib/server/protocol";
import { FreeTurnProtocolGuard } from "@/lib/server/free-protocol";
import { prepareTutorMessages } from "@/lib/server/tutor-output";
import { buildFreeTutorMessages, buildFreeTutorSystem, prepareFreeBoard } from "@/lib/server/free-prompts";
import { loadFreeSession, toFreeMessageDTO, toFreeTopicDTO, validFreeId, withRecentAttachments } from "@/lib/server/free-data";
import { freeTurnHash, initialFreeTitle, readFreeTurnRequest } from "@/lib/server/free-input";
import type { FreeTurnAction, FreeTurnEvent, FreeTurnIntent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = validFreeId((await ctx.params).id);
  if (!id) return Response.json({ error: "自由提问课堂编号无效。" }, { status: 400 });
  let body;
  try { body = await readFreeTurnRequest(req); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "请求格式不正确。" }, { status: 400 }); }
  const release = await tryOperationLock("freeSession", id);
  if (!release) return Response.json({ error: "导师正在回复，请稍候重试。" }, { status: 409 });
  let handedOff = false;
  try {
    const bundle = await loadFreeSession(id);
    if (!bundle) { await release(); return Response.json({ error: "自由提问课堂不存在。" }, { status: 404 }); }
    const intent = body.intent;
    if (intent === "greeting" && body.requestId !== bundle.session.welcomeRequestId) { await release(); return Response.json({ error: "欢迎请求编号无效。" }, { status: 409 }); }
    if (body.requestId === bundle.session.welcomeRequestId && intent !== "greeting") { await release(); return Response.json({ error: "欢迎请求编号不能用于普通提问。" }, { status: 409 }); }
    const requestedTopicId = body.topicId ?? null;
    const hash = freeTurnHash(body);
    let [turn] = await db.select().from(freeTurns).where(and(eq(freeTurns.sessionId, id), eq(freeTurns.requestId, body.requestId)));
    if (turn && turn.inputHash !== hash) { await release(); return Response.json({ error: "此请求编号已用于另一条消息，请使用新请求编号。" }, { status: 409 }); }
    if (intent === "greeting" && turn?.status === "success") {
      await release();
      return replaySuccessfulTurn(id, body.requestId, turn.id, turn.action === "continue" ? "continue" : "wait");
    }
    if (turn?.status === "success") {
      await release();
      return replaySuccessfulTurn(id, body.requestId, turn.id, turn.action === "continue" ? "continue" : "wait");
    }
    const expectedTopicId = turn?.topicId ?? turn?.requestedTopicId ?? requestedTopicId;
    if (intent !== "greeting" && expectedTopicId !== bundle.session.currentTopicId) { await release(); return Response.json({ error: "当前话题已变化，请同步课堂后重试。" }, { status: 409 }); }
    let recovering = false;
    if (!turn) {
      const [created] = await db.insert(freeTurns).values({ sessionId: id, requestId: body.requestId, intent: intent ?? null, inputHash: hash, requestedTopicId, status: "running" }).returning();
      turn = created;
    } else {
      recovering = turn.status === "running" || turn.status === "failed" || turn.status === "cancelled";
      await db.update(freeTurns).set({ status: "running", updatedAt: new Date() }).where(eq(freeTurns.id, turn.id));
      turn = { ...turn, status: "running" };
    }

    const currentTopic = bundle.topics.find((topic) => topic.id === expectedTopicId) ?? null;
    if (intent === "continue" && !currentTopic) return failBeforeStream(turn.id, "还没有可以继续的话题，请先提出一个问题。", release);
    const settings = await getSettings();
    let cfg;
    try { cfg = getLLMConfig(settings, "chat"); }
    catch (error) { return failBeforeStream(turn.id, error instanceof Error ? error.message : "讲解模型尚未配置。", release); }

    const selectMessagePage = {
      id: freeMessages.id, sessionId: freeMessages.sessionId, turnId: freeMessages.turnId, topicId: freeMessages.topicId,
      role: freeMessages.role, kind: freeMessages.kind, language: freeMessages.language, content: freeMessages.content,
      speech: freeMessages.speech, boardMode: freeMessages.boardMode, createdAt: freeMessages.createdAt,
      attachmentCount: sql<number>`jsonb_array_length(${freeMessages.attachments})::int`,
    };
    const recentMessages = await db.select(selectMessagePage).from(freeMessages).where(eq(freeMessages.sessionId, id)).orderBy(desc(freeMessages.id)).limit(60);
    const topicMessages = currentTopic ? await db.select(selectMessagePage).from(freeMessages)
      .where(and(eq(freeMessages.sessionId, id), eq(freeMessages.topicId, currentTopic.id))).orderBy(desc(freeMessages.id)).limit(60) : [];
    const historyRows = [...new Map([...recentMessages, ...topicMessages].map((message) => [message.id, message])).values()].sort((a, b) => a.id - b.id);
    const oldMessages = await withRecentAttachments(historyRows, currentTopic?.id);
    const [savedUser] = await db.select().from(freeMessages).where(and(eq(freeMessages.sessionId, id), eq(freeMessages.turnId, turn.id), eq(freeMessages.role, "user"))).limit(1);
    let userRow = savedUser ?? oldMessages.find((message) => message.turnId === turn.id && message.role === "user");
    if (userRow && userRow.topicId !== expectedTopicId) {
      const [moved] = await db.update(freeMessages).set({ topicId: expectedTopicId }).where(eq(freeMessages.id, userRow.id)).returning();
      userRow = moved;
    }
    if (!userRow && intent !== "greeting" && intent !== "goodbye" && (body.text || body.images?.length)) {
      userRow = (await db.insert(freeMessages).values({
        sessionId: id, turnId: turn.id, topicId: currentTopic?.id ?? null,
        role: "user", kind: "text", language: "zh-CN", content: body.text ?? "", attachments: body.images ?? [],
      }).returning())[0];
      const title = bundle.session.title || initialFreeTitle(body.text ?? "", body.images ?? []);
      await db.update(freeSessions).set({ title, updatedAt: new Date() }).where(eq(freeSessions.id, id));
    }
    const contextTurnIds = [...new Set([...historyRows.map((message) => message.turnId).filter((turnId): turnId is number => turnId !== null), turn.id])];
    const allTurns = await db.select().from(freeTurns).where(inArray(freeTurns.id, contextTurnIds)).orderBy(asc(freeTurns.id));
    const system = buildFreeTutorSystem(bundle.tutor, {
      intent, title: bundle.session.title || initialFreeTitle(body.text ?? "", body.images ?? []),
      topicTitle: recovering && turn.topicId ? bundle.topics.find((topic) => topic.id === turn.topicId)?.title : currentTopic?.title,
      topicCount: bundle.topics.length, recovery: recovering,
    });
    const history = userRow
      ? oldMessages.some((message) => message.id === userRow!.id)
        ? oldMessages.map((message) => message.id === userRow!.id ? userRow! : message)
        : [...oldMessages, userRow]
      : oldMessages;
    const llmMessages = buildFreeTutorMessages(history, allTurns, {
      intent, recovering: recovering && !!history.at(-1) && history.at(-1)!.role === "tutor", currentImages: [],
      currentTopicId: turn.topicId ?? currentTopic?.id ?? null,
    });

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("讲解超过 270 秒，请重试。")), 270_000);
    const abort = () => controller.abort();
    req.signal.addEventListener("abort", abort, { once: true });
    if (req.signal.aborted) controller.abort();
    handedOff = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        let closed = false, tutorTextCount = 0;
        let action: FreeTurnAction = "wait";
        const protocol = new FreeTurnProtocolGuard(intent);
        let topicId = turn!.topicId ?? currentTopic?.id ?? null;
        let turnTopic = topicId ? bundle.topics.find((topic) => topic.id === topicId) ?? null : null;
        let topicReady = !!turnTopic;
        let initialTopicSent = false;
        const send = (event: FreeTurnEvent) => {
          if (closed) return;
          try { output.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
          catch { closed = true; controller.abort(); }
        };
        const persistTutorText = async (zh: string, ja: string, kind: "text" | "feedback" = "text") => {
          controller.signal.throwIfAborted();
          const [row] = await db.insert(freeMessages).values({
            sessionId: id, turnId: turn!.id, topicId: intent === "greeting" || intent === "goodbye" ? null : topicId,
            role: "tutor", kind, language: "zh-CN", content: zh,
            speech: ja, attachments: [],
          }).returning();
          tutorTextCount++;
          send({ type: "message", requestId: body.requestId, message: toFreeMessageDTO(row) });
        };
        const ensureTopic = async (mode: string, title: string) => {
          if (intent === "greeting" || intent === "goodbye") throw new Error("欢迎与告别回复不能修改话题。");
          if (!topicReady) {
            if (mode !== "new" || !title.trim()) throw new Error("导师需要为本轮教学建立话题。");
            let existing = turn!.topicId ? bundle.topics.find((topic) => topic.id === turn!.topicId) : undefined;
            if (!existing) {
              const nextIdx = bundle.topics.reduce((max, topic) => Math.max(max, topic.idx), -1) + 1;
              existing = await db.transaction(async (tx) => {
                const [row] = await tx.insert(freeTopics).values({ sessionId: id, idx: nextIdx, title: title.trim().slice(0, 80) }).returning();
                await tx.update(freeSessions).set({ currentTopicId: row.id, updatedAt: new Date() }).where(eq(freeSessions.id, id));
                await tx.update(freeTurns).set({ topicId: row.id, updatedAt: new Date() }).where(eq(freeTurns.id, turn!.id));
                if (userRow) await tx.update(freeMessages).set({ topicId: row.id }).where(eq(freeMessages.id, userRow!.id));
                return row;
              });
            }
            turnTopic = existing;
            topicId = existing.id;
            topicReady = true;
            if (!initialTopicSent) {
              send({ type: "topic", requestId: body.requestId, topic: toFreeTopicDTO(existing), current: true });
              initialTopicSent = true;
            }
            return;
          }
          if (mode === "new") {
            if (turn!.topicId) throw new Error("恢复同一请求时不能重复创建话题，请继续原话题。");
            if (!title.trim()) throw new Error("新话题需要一个标题。");
            const nextIdx = bundle.topics.reduce((max, topic) => Math.max(max, topic.idx), -1) + 1;
            const created = await db.transaction(async (tx) => {
              const [row] = await tx.insert(freeTopics).values({ sessionId: id, idx: nextIdx, title: title.trim().slice(0, 80) }).returning();
              await tx.update(freeSessions).set({ currentTopicId: row.id, updatedAt: new Date() }).where(eq(freeSessions.id, id));
              await tx.update(freeTurns).set({ topicId: row.id, updatedAt: new Date() }).where(eq(freeTurns.id, turn!.id));
              if (userRow) await tx.update(freeMessages).set({ topicId: row.id }).where(eq(freeMessages.id, userRow!.id));
              return row;
            });
            turnTopic = created;
            topicId = created.id;
            send({ type: "topic", requestId: body.requestId, topic: toFreeTopicDTO(created), current: true });
          } else if (mode === "keep") {
            if (!topicReady || !topicId || !turnTopic) throw new Error("当前还没有可以沿用的话题。");
            if (!turn!.topicId) {
              await db.update(freeTurns).set({ topicId, updatedAt: new Date() }).where(eq(freeTurns.id, turn!.id));
              turn = { ...turn!, topicId };
            }
          } else throw new Error("导师输出的话题类型无效。");
        };
        const parser = createTagParser(["topic", "msg", "board", "quote", "example", "exercise", "action"]);
        const handle = async (blocks: TagBlock[]) => {
          for (const block of blocks) {
            const parsedAction = protocol.accept(block);
            if ((intent === "greeting" || intent === "goodbye") && block.tag !== "msg" && block.tag !== "action") {
              throw new Error("欢迎或告别只能包含简短中文消息和结束动作。");
            }
            if (block.tag === "action") {
              action = parsedAction ?? "wait";
              continue;
            }
            if (block.tag === "topic") {
              const mode = block.attrs.mode ?? "";
              const title = block.attrs.title ?? "";
              if (Object.keys(block.attrs).some((key) => key !== "mode" && key !== "title")) throw new Error("话题标签包含未知属性。");
              await ensureTopic(mode, title);
              continue;
            }
            if (["greeting", "goodbye"].includes(intent ?? "") && block.tag === "board") throw new Error("欢迎与告别回复不能修改黑板。");
            if (block.tag === "msg") {
              const zh = /<zh(?:\s[^>]*)?>([\s\S]*?)<\/zh\s*>/i.exec(block.body)?.[1]?.trim() ?? "";
              const ja = /<ja(?:\s[^>]*)?>([\s\S]*?)<\/ja\s*>/i.exec(block.body)?.[1]?.trim() ?? "";
              if (!zh || /<(?!\/?(?:zh|ja)(?:\s|>))[^>]+>/i.test(block.body)) throw new Error("导师消息内容不完整。");
              const prepared = await prepareTutorMessages(cfg, zh, ja, controller.signal, bundle.tutor.voiceStyle);
              for (const message of prepared) await persistTutorText(message.zh, message.ja);
            } else if (block.tag === "board") {
              if (!topicReady || !turnTopic || !topicId) throw new Error("板书必须先属于一个话题。");
              const mode = block.attrs.mode === "replace" ? "replace" : block.attrs.mode === undefined || block.attrs.mode === "append" ? "append" : "invalid";
              if (mode === "invalid" || Object.keys(block.attrs).some((key) => !["mode", "title"].includes(key))) throw new Error("板书格式无效。");
              const translation = await prepareFreeBoard(cfg, block.body, block.attrs.title ?? turnTopic.title, controller.signal);
              const markdown = translation.markdown.trim();
              if (!markdown || markdown.length > 12000) throw new Error("板书内容为空或超过 12,000 字。");
              const updated = await db.transaction(async (tx) => {
                const [latest] = await tx.select().from(freeTopics).where(and(eq(freeTopics.id, topicId!), eq(freeTopics.sessionId, id)));
                if (!latest) throw new Error("话题已经删除。");
                const nextBlock = { id: crypto.randomUUID().slice(0, 8), md: markdown, at: Date.now() };
                const blocks = mode === "replace" ? [nextBlock] : [...latest.blocks, nextBlock];
                const [row] = await tx.update(freeTopics).set({ title: translation.title.slice(0, 80) || latest.title, blocks, updatedAt: new Date() }).where(eq(freeTopics.id, latest.id)).returning();
                const [message] = await tx.insert(freeMessages).values({
                  sessionId: id, turnId: turn!.id, topicId: latest.id, role: "tutor", kind: "board", content: markdown,
                  language: "zh-CN", boardMode: mode, attachments: [],
                }).returning();
                return { row, message, block: nextBlock };
              });
              turnTopic = updated.row;
              send({ type: "board", requestId: body.requestId, topic: toFreeTopicDTO(updated.row), blockId: updated.block.id, message: toFreeMessageDTO(updated.message) });
            } else if (block.tag === "quote" || block.tag === "example" || block.tag === "exercise") {
              const language = block.attrs.lang;
              const content = block.body.trim();
              if (!topicId || !topicReady) throw new Error("外语示例必须先属于一个话题。");
              if ((language !== "en" && language !== "ja") || !content || content.length > 6000 || Object.keys(block.attrs).some((key) => key !== "lang")) throw new Error("外语内容或语言标记无效。");
              if (block.tag === "quote") {
                const supplied = new Set([body.text ?? "", ...history.filter((message) => message.role === "user").map((message) => message.content)]);
                const suppliedImage = (body.images?.length ?? 0) > 0 || history.some((message) => message.role === "user" && message.attachments.length > 0);
                if (![...supplied].some((source) => source.includes(content)) && !suppliedImage) throw new Error("外语引用必须来自学生提供的文字或图片。");
              }
              const [row] = await db.insert(freeMessages).values({
                sessionId: id, turnId: turn!.id, topicId, role: "tutor", kind: block.tag,
                language, content, speech: "", attachments: [],
              }).returning();
              send({ type: "message", requestId: body.requestId, message: toFreeMessageDTO(row) });
            } else throw new Error("导师回复包含未知标签。");
          }
        };
        try {
          if (userRow) send({ type: "user", requestId: body.requestId, message: toFreeMessageDTO(userRow) });
          const removeActive = () => { clearTimeout(deadline); req.signal.removeEventListener("abort", abort); };
          const contextMessages = llmMessages;
          for await (const delta of streamChat(cfg, { system, messages: contextMessages, maxTokens: 8192, signal: controller.signal })) await handle(parser.push(delta));
          await handle(parser.end());
          controller.signal.throwIfAborted();
          protocol.finish(parser.stray());
          if (!tutorTextCount) throw new Error("导师回复缺少中文讲解消息，请重试。");
          if ((intent === "greeting" || intent === "goodbye") && tutorTextCount > 2) throw new Error("欢迎或告别消息不能超过两条。");
          if (intent === "greeting" || intent === "goodbye") {
            const forbidden = await db.select({ id: freeMessages.id }).from(freeMessages).where(and(eq(freeMessages.turnId, turn!.id), eq(freeMessages.kind, "board")));
            if (forbidden.length) throw new Error("欢迎与告别回复不能修改黑板。");
          }
          await db.update(freeTurns).set({ status: "success", action, updatedAt: new Date() }).where(eq(freeTurns.id, turn!.id));
          await db.update(freeSessions).set({ updatedAt: new Date() }).where(eq(freeSessions.id, id));
          send({ type: "done", requestId: body.requestId, action });
          removeActive();
        } catch (error) {
          const cancelled = controller.signal.aborted;
          await db.update(freeTurns).set({ status: cancelled ? "cancelled" : "failed", updatedAt: new Date() }).where(eq(freeTurns.id, turn!.id)).catch(() => undefined);
          if (!cancelled) send({ type: "error", requestId: body.requestId, error: error instanceof Error ? error.message : "导师回复失败，请重试。" });
          clearTimeout(deadline);
          req.signal.removeEventListener("abort", abort);
        } finally {
          await release();
          try { output.close(); } catch { /* The browser closed the classroom. */ }
          closed = true;
        }
      },
      cancel() { controller.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    if (!handedOff) await release();
    return Response.json({ error: error instanceof Error ? error.message : "课堂生成失败，请重试。" }, { status: 400 });
  }
}

async function failBeforeStream(turnId: number, error: string, release: () => Promise<void>) {
  await db.update(freeTurns).set({ status: "failed", updatedAt: new Date() }).where(eq(freeTurns.id, turnId));
  await release();
  return Response.json({ error }, { status: 400 });
}

async function replaySuccessfulTurn(sessionId: number, requestId: string, turnId: number, action: FreeTurnAction) {
  const messages = await db.select().from(freeMessages).where(eq(freeMessages.turnId, turnId)).orderBy(asc(freeMessages.id));
  const topicId = messages.find((message) => message.topicId)?.topicId;
  const [topic] = topicId ? await db.select().from(freeTopics).where(eq(freeTopics.id, topicId)) : [];
  const [session] = await db.select({ currentTopicId: freeSessions.currentTopicId }).from(freeSessions).where(eq(freeSessions.id, sessionId));
  const enc = new TextEncoder();
  const events: FreeTurnEvent[] = [];
  const user = messages.find((message) => message.role === "user");
  if (user) events.push({ type: "user", requestId, message: toFreeMessageDTO(user) });
  if (topic) events.push({ type: "topic", requestId, topic: toFreeTopicDTO(topic), current: session?.currentTopicId === topic.id });
  for (const row of messages.filter((message) => message.role === "tutor")) {
    if (row.kind === "board" && topic) events.push({ type: "board", requestId, topic: toFreeTopicDTO(topic), blockId: crypto.randomUUID().slice(0, 8), message: toFreeMessageDTO(row) });
    else events.push({ type: "message", requestId, message: toFreeMessageDTO(row) });
  }
  events.push({ type: "done", requestId, action });
  const stream = new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(enc.encode(JSON.stringify(event) + "\n")); controller.close(); } });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
