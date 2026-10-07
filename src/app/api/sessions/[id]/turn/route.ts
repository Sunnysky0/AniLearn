import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { boards, messages, paperPages, sessions } from "@/db/schema";
import {
  loadClassroom,
  problemDivider,
  toMessageDTO,
  toSessionDTO,
  type SessionRow,
} from "@/lib/server/data";
import { complete, streamChat, type LLMConfig } from "@/lib/server/llm";
import { hasJapaneseText } from "@/lib/text";
import { buildTutorMessages, buildTutorSystem, normalizeAction } from "@/lib/server/prompts";
import { createTagParser, innerTag, stripTags, type TagBlock } from "@/lib/server/protocol";
import { getLLMConfig, getSettings } from "@/lib/server/settings";
import { tryOperationLock } from "@/lib/server/locks";
import { acceptCoverage, prepareTutorMessages } from "@/lib/server/tutor-output";
import { COVERAGE_TOPICS, type TeachingCoverage } from "@/lib/types";
import type { BoardBlock, ProblemProgress, TurnAction, TurnEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FIGURE_RE = /如图|图中|下图|右图|左图|图象|图像|示意图|图\s*\d|【图形描述/;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = Number((await ctx.params).id);
  if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 2147483647) return Response.json({ error: "无效的课堂 ID" }, { status: 400 });
  const release = await tryOperationLock("session", sessionId);
  if (!release) return Response.json({ error: "上一轮讲解仍在进行，请稍候再试。" }, { status: 409 });
  try {
    const response = await runTurn(req, sessionId, release);
    if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) await release();
    return response;
  } catch (e) {
    await release();
    throw e;
  }
}

async function runTurn(req: Request, sessionId: number, release: () => Promise<void>) {
  const body = (await req.json().catch(() => ({}))) as { text?: string; images?: string[] };
  const bundle = await loadClassroom(sessionId);
  if (!bundle) { await release(); return Response.json({ error: "课堂不存在" }, { status: 404 }); }
  const { session, tutor, paper, problems } = bundle;
  if (!problems.length) { await release(); return Response.json({ error: "该试卷还没有解析出题目" }, { status: 400 }); }

  let cfg: LLMConfig;
  try {
    cfg = getLLMConfig(await getSettings(), "chat");
  } catch (e) {
    await release();
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const idx = Math.min(Math.max(session.currentIdx, 0), problems.length - 1);
  const problem = problems[idx];
  const text = (body.text ?? "").trim().slice(0, 4000);
  const images = Array.isArray(body.images)
    ? body.images.filter((x) => typeof x === "string" && x.startsWith("data:image/")).slice(0, 4)
    : [];

  let userRow: typeof messages.$inferSelect | null = null;
  if (text || images.length) {
    [userRow] = await db
      .insert(messages)
      .values({ sessionId, role: "user", kind: "text", content: text, problemIdx: idx, attachments: images })
      .returning();
  }

  const history = (
    await db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(desc(messages.id)).limit(60)
  ).reverse();
  const [boardRow] = await db
    .select()
    .from(boards)
    .where(and(eq(boards.sessionId, sessionId), eq(boards.problemIdx, idx)));

  let pageImage: { mime: string; data: string } | null = null;
  if (FIGURE_RE.test(problem.content)) {
    const [pg] = await db
      .select()
      .from(paperPages)
      .where(and(eq(paperPages.paperId, paper.id), eq(paperPages.pageIndex, Math.max(0, problem.page - 1))));
    if (pg) pageImage = { mime: pg.mime, data: pg.data };
  }

  const state = {
    blocks: (boardRow?.blocks ?? []) as BoardBlock[],
    boardTitle: boardRow?.title ?? "",
    action: null as TurnAction | null,
    count: 0,
    coverage: { ...(session.coverage?.[String(idx)] ?? {}) } as TeachingCoverage,
    taught: [] as string[],
    actions: 0,
  };

  const system = buildTutorSystem({
    tutor,
    paper,
    problems,
    idx,
    blocks: state.blocks,
    boardTitle: state.boardTitle,
    progress: session.progress ?? {},
    history,
    coverage: state.coverage,
  });
  const llmMessages = buildTutorMessages({ history, pageImage, problemNumber: problem.number });

  const encoder = new TextEncoder();
  const upstream = new AbortController();
  const deadline = setTimeout(() => upstream.abort(new Error("讲解等待超时，请重试。")), 270_000);
  const abort = () => upstream.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) upstream.abort();
  const parser = createTagParser(["msg", "board", "covered", "action"]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (ev: TurnEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      if (userRow) send({ type: "user", message: toMessageDTO(userRow) });

      const insertTutorMessage = async (zh: string, ja: string) => {
        const [row] = await db
          .insert(messages)
          .values({ sessionId, role: "tutor", kind: "text", content: zh, speech: ja, problemIdx: idx })
          .returning();
        state.count++;
        state.taught.push(zh);
        send({ type: "message", message: toMessageDTO(row) });
      };

      const handle = async (list: TagBlock[]) => {
        for (const b of list) {
          if (upstream.signal.aborted) return;
          if (!b.closed) throw new Error("导师输出未完成，请重试。");
          if (b.tag === "msg") {
            let zh = innerTag(b.body, "zh") ?? stripTags(b.body);
            zh = zh.split(/<ja[\s>]/i)[0].trim();
            const ja = (innerTag(b.body, "ja") ?? "").replace(/<\/?[a-z]+>/gi, "").trim();
            if (zh) {
              const prepared = await prepareTutorMessages(cfg, zh, ja, upstream.signal);
              for (const m of prepared) {
                if (upstream.signal.aborted) return;
                await insertTutorMessage(m.zh, m.ja);
              }
            }
          } else if (b.tag === "board") {
            let md = b.body.trim();
            if (hasJapaneseText(md) || hasJapaneseText(b.attrs.title || "")) {
              const raw = await complete(cfg, {
                system: "[BOARD_REPAIR] 将板书及标题翻译为简体中文，保留 Markdown、LaTeX 与数学含义。只输出 <board title=\"中文标题\">中文板书</board>。",
                messages: [{ role: "user", content: `<board title="${b.attrs.title || ""}">${md}</board>` }],
                maxTokens: 4096, signal: upstream.signal,
              });
              const repairParser = createTagParser(["board"]);
              const repaired = [...repairParser.push(raw), ...repairParser.end()];
              if (repaired.length !== 1 || !repaired[0].closed || hasJapaneseText(repaired[0].body) || hasJapaneseText(repaired[0].attrs.title || "")) {
                throw new Error("板书语言修复失败，请重试。");
              }
              md = repaired[0].body.trim();
              b.attrs.title = repaired[0].attrs.title || "";
            }
            const mode = (b.attrs.mode || "append").toLowerCase();
            if (b.attrs.title) state.boardTitle = b.attrs.title.trim().slice(0, 60);
            if (!state.boardTitle) {
              state.boardTitle = `第${problem.number}题${problem.title ? ` · ${problem.title}` : ""}`;
            }
            if (mode === "clear") state.blocks = [];
            let blockId = "";
            if (md) {
              state.taught.push(md);
              const block: BoardBlock = { id: crypto.randomUUID().slice(0, 8), md, at: Date.now() };
              blockId = block.id;
              state.blocks = mode === "replace" ? [block] : [...state.blocks, block];
            }
            await db
              .insert(boards)
              .values({ sessionId, problemIdx: idx, title: state.boardTitle, blocks: state.blocks })
              .onConflictDoUpdate({
                target: [boards.sessionId, boards.problemIdx],
                set: { title: state.boardTitle, blocks: state.blocks, updatedAt: new Date() },
              });
            const [row] = await db
              .insert(messages)
              .values({
                sessionId,
                role: "tutor",
                kind: "board",
                content: md,
                speech: mode === "replace" ? "replace" : "append",
                problemIdx: idx,
              })
              .returning();
            send({
              type: "board",
              board: { problemIdx: idx, title: state.boardTitle, blocks: state.blocks },
              blockId,
              message: toMessageDTO(row),
            });
          } else if (b.tag === "covered") {
            acceptCoverage(state.coverage, b.attrs.topic || "", b.body.trim(), state.taught);
          } else if (b.tag === "action") {
            state.actions++;
            state.action = normalizeAction(b.body || b.attrs.type || b.attrs.value);
          }
        }
      };

      try {
        for await (const delta of streamChat(cfg, {
          system,
          messages: llmMessages,
          maxTokens: 8192,
          signal: upstream.signal,
        })) {
          await handle(parser.push(delta));
        }
        await handle(parser.end());

        if (!state.count && !upstream.signal.aborted) {
          // Fallback: the model ignored the tag format – split plain text into short messages.
          const stray = stripTags(parser.stray()).trim();
          if (!stray) throw new Error("模型没有返回有效内容，请重试。");
          const prepared = await prepareTutorMessages(cfg, stray, "", upstream.signal);
          for (const m of prepared) await insertTutorMessage(m.zh, m.ja);
          state.action = "wait";
        }
        if (upstream.signal.aborted) throw upstream.signal.reason;
        if (state.actions > 1) throw new Error("导师返回了多个课程动作，请重试。");

        let finalAction: TurnAction = state.action ?? "wait";
        const coverage = { ...(session.coverage ?? {}), [String(idx)]: state.coverage };
        if ((finalAction === "next" || finalAction === "finish") && !COVERAGE_TOPICS.every((topic) => state.coverage[topic])) {
          finalAction = "wait";
          await insertTutorMessage("这题的讲解还没有完整覆盖。我们先补齐解法、知识点、方法和易错点，再继续。", "[優しく穏やかな口調] この問題の解説を最後まで確認してから、次へ進みましょう。");
        }
        let updated: SessionRow = session;
        if (finalAction === "next" || finalAction === "finish") {
          const progress: Record<string, ProblemProgress> = { ...(session.progress ?? {}), [String(idx)]: "done" };
          const remaining = problems.map((_, i) => i).filter((i) => progress[String(i)] !== "done");
          if (remaining.length) {
            finalAction = "next";
            const ni = remaining.find((i) => i > idx) ?? remaining[0];
            if (progress[String(ni)] !== "done") progress[String(ni)] = "active";
            [updated] = await db
              .update(sessions)
              .set({ currentIdx: ni, progress, coverage, updatedAt: new Date() })
              .where(eq(sessions.id, sessionId))
              .returning();
            const [div] = await db
              .insert(messages)
              .values({ sessionId, role: "system", kind: "problem", content: problemDivider(problems[ni]), problemIdx: ni })
              .returning();
            send({ type: "problem", message: toMessageDTO(div), session: toSessionDTO(updated) });
          } else {
            finalAction = "finish";
            [updated] = await db
              .update(sessions)
              .set({ status: "completed", progress, coverage, updatedAt: new Date() })
              .where(eq(sessions.id, sessionId))
              .returning();
          }
        } else {
          [updated] = await db
            .update(sessions)
            .set({ coverage, updatedAt: new Date() })
            .where(eq(sessions.id, sessionId))
            .returning();
        }
        send({ type: "done", action: finalAction, session: toSessionDTO(updated) });
      } catch (e) {
        if (!req.signal.aborted) {
          send({ type: "error", error: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        clearTimeout(deadline);
        req.signal.removeEventListener("abort", abort);
        await release();
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
