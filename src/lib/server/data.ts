import { and, asc, eq, sql } from "drizzle-orm";
import { directoryProblems, fullPlan } from "./learning-plan";
import { db } from "@/db";
import { boards, messages, paperPages, papers, problems, sessions, tutors } from "@/db/schema";
import {
  DEFAULT_TUTOR_AVATAR,
  DEFAULT_TUTOR_NAME,
  DEFAULT_VOICE_ID,
  type BoardDTO,
  type MessageDTO,
  type PaperDTO,
  type PaperStatus,
  type ProblemDTO,
  type SessionDTO,
  type TutorDTO,
  type TutorInput,
  type ClassroomSnapshot,
} from "@/lib/types";

export type TutorRow = typeof tutors.$inferSelect;
export type PaperRow = typeof papers.$inferSelect;
export type ProblemRow = typeof problems.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;

export const toTutorDTO = (r: TutorRow): TutorDTO => ({
  id: r.id,
  name: r.name,
  avatar: r.avatar,
  tags: r.tags ?? [],
  tagline: r.tagline,
  personality: r.personality,
  teachingStyle: r.teachingStyle,
  speakingStyle: r.speakingStyle,
  voiceId: r.voiceId,
  voiceName: r.voiceName,
  voiceStyle: r.voiceStyle,
  greeting: r.greeting,
  isPreset: r.isPreset,
});

export const paperPageMimes = () => {
  // Nest the correlated query so Drizzle retains table names in single-table selections.
  const source = sql`array(select ${paperPages.mime} from ${paperPages} where ${paperPages.paperId} = ${papers.id} order by ${paperPages.pageIndex})`;
  return sql<string[]>`${source}`;
};

export const toPaperDTO = (r: PaperRow, pageMimes?: string[]): PaperDTO => ({
  pace: r.pace,
  learningRequest: r.learningRequest,
  inventory: r.inventory,
  analysisPlan: r.analysisPlan,
  revision: r.revision,
  id: r.id,
  title: r.title,
  subject: r.subject,
  status: r.status as PaperStatus,
  overview: r.overview,
  error: r.error,
  pageCount: r.pageCount,
  pageMimes,
  createdAt: r.createdAt.toISOString(),
});

export const toProblemDTO = (r: ProblemRow | ProblemDTO): ProblemDTO => ({
  id: r.id,
  idx: r.idx,
  number: r.number,
  type: r.type,
  title: r.title,
  content: r.content,
  answer: r.answer,
  solution: r.solution,
  keyPoints: r.keyPoints ?? [],
  knowledgePoints: r.knowledgePoints ?? [],
  skills: r.skills ?? [],
  analysis: "analysis" in r ? r.analysis : "ready",
  difficulty: r.difficulty,
  strategy: r.strategy,
  strategyReason: r.strategyReason,
  studentWork: r.studentWork,
  page: r.page,
});

export const toSessionDTO = (r: SessionRow): SessionDTO => ({
  plan: r.plan,
  pendingPlan: r.pendingPlan,
  id: r.id,
  paperId: r.paperId,
  tutorId: r.tutorId,
  currentIdx: r.currentIdx,
  status: r.status,
  progress: r.progress ?? {},
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toMessageDTO = (r: MessageRow): MessageDTO => ({
  id: r.id,
  role: r.role as MessageDTO["role"],
  kind: r.kind as MessageDTO["kind"],
  content: r.content,
  speech: r.speech,
  problemIdx: r.problemIdx,
  attachments: r.attachments ?? [],
  createdAt: r.createdAt.toISOString(),
});

export const toBoardDTO = (r: BoardRow): BoardDTO => ({
  problemIdx: r.problemIdx,
  title: r.title,
  blocks: r.blocks ?? [],
});

export function problemDivider(p: ProblemRow | ProblemDTO): string {
  return `第 ${p.number} 题${p.type ? ` · ${p.type}` : ""}${p.title ? ` · ${p.title}` : ""}`;
}

export async function loadClassroom(sessionId: number) {
  if (!Number.isFinite(sessionId)) return null;
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return null;
  const [tutor] = await db.select().from(tutors).where(eq(tutors.id, session.tutorId));
  const [paper] = await db.select().from(papers).where(eq(papers.id, session.paperId));
  if (!tutor || !paper) return null;
  if (session.snapshot) {
    const snapshot = session.snapshot;
    return {
      session: { ...session, plan: session.plan ?? fullPlan(snapshot.problems) },
      tutor,
      paper: { ...paper, ...snapshot.paper, inventory: snapshot.inventory ?? snapshot.paper.inventory ?? null, analysisPlan: snapshot.paper.analysisPlan ?? null, revision: snapshot.paper.revision ?? 0, createdAt: new Date(snapshot.paper.createdAt) },
      problems: directoryProblems(snapshot.inventory ?? snapshot.paper.inventory, snapshot.problems).map((p) => ({ ...p, paperId: session.paperId })),
    };
  }
  const probs = await db
    .select()
    .from(problems)
    .where(eq(problems.paperId, paper.id))
    .orderBy(asc(problems.idx));
  return { session: { ...session, plan: session.plan ?? fullPlan(probs) }, tutor, paper, problems: directoryProblems(paper.inventory, probs.map(toProblemDTO)).map((p) => ({ ...p, paperId: session.paperId })) };
}

export function classroomSnapshot(paper: PaperRow, rows: ProblemRow[]): ClassroomSnapshot {
  return { paper: toPaperDTO(paper), problems: directoryProblems(paper.inventory, rows.map(toProblemDTO)), inventory: paper.inventory };
}

export function visibleProblems(paper: PaperRow, rows: ProblemRow[]): ProblemDTO[] {
  // A failed reanalysis must keep showing the last published problem set.
  // Draft rows are useful while an unpublished analysis is still running.
  if (paper.analysisDraft && (paper.status === "analyzing" || !rows.length)) {
    const indexed = paper.analysisDraft.indexed ?? Object.fromEntries(paper.analysisDraft.completed.map((p, idx) => [String(idx), p]));
    return directoryProblems(paper.analysisDraft.inventory, Object.entries(indexed).map(([key, p]) => ({ ...p, idx: Number(key), id: -Number(key) - 1 })));
  }
  return directoryProblems(paper.inventory, rows.map(toProblemDTO));
}

// ---------------- Tutor presets & seeding ----------------

export const PRESET_TUTORS: TutorInput[] = [
  {
    name: DEFAULT_TUTOR_NAME,
    avatar: DEFAULT_TUTOR_AVATAR,
    tags: ["少女与战车", "优雅从容"],
    tagline: "和大吉岭一起从容拆解难题，把思路梳理得像一杯好茶",
    personality:
      "你是《少女与战车》中的大吉岭，圣葛罗莉安娜女子学院的队长。举止优雅、沉着自信，喜爱红茶，擅长观察与判断。辅导时耐心礼貌，偶尔用红茶或战术作简短类比，带一点含蓄的幽默；学生答错时先肯定思路中的亮点，再平静地引导他发现问题。",
    teachingStyle:
      "从容的启发式教学：先审题、辨明条件与目标，像制定战术一样建立解题框架，再逐步推导。善用问题和图像引导学生思考，每个关键步骤都确认理解；讲完后整理完整解法、教材知识点、方法与易错点。角色比喻简短适量，不打断学习主线。",
    speakingStyle: "语气优雅、沉静而亲切，表达简短清晰。常说“先别急着落笔”“让我们从条件出发”“很好，思路已经清楚了”。偶尔以品茶的节奏提醒学生从容思考，不堆砌格言，也不编造名人引语。",
    voiceId: DEFAULT_VOICE_ID,
    voiceName: "大吉岭",
    voiceStyle: "[優雅で落ち着いた丁寧な口調]",
    greeting: "你好，我是大吉岭。先别急着落笔，让我们像品一杯红茶一样，从容地把这张试卷的思路理清。",
  },
  {
    name: "远坂凛",
    avatar: "/avatars/rin.png",
    tags: ["Fate", "外冷内热"],
    tagline: "和远坂凛一起建立思考框架，清晰果断地拆解难题",
    personality:
      "你是《Fate/stay night》中的远坂凛，聪明、自律、自信，外表强势但内心关心他人，带一点克制的傲娇和幽默。辅导时认真负责，善于分析与判断，对概念、证据和推导要求严谨。学生答错时明确指出问题并耐心引导，不嘲讽、不羞辱学生；角色设定只用于交流风格，各学科讲解遵循现实依据。",
    teachingStyle:
      "结构化精讲：先建立思考框架，辨明条件与依据，再规范推导；强调解题模板和规范书写，最后总结同类题型的通法。",
    speakingStyle: "表达自信、简洁利落，偶尔带一点轻微的傲娇。常说“先把条件看清楚”“这一点可别漏掉”“不错，接着来”。鼓励具体自然，讲题时专注条件、模型和推导。",
    voiceId: "0efe389bb7b544c690da2fbeee0831d8",
    voiceName: "远坂凛",
    voiceStyle: "[自信のある、少しツンとした口調]",
    greeting: "我是远坂凛。先把条件看清楚，再建立模型——这张试卷，我们一起把每个关键步骤拿下。",
  },
  {
    name: "牧濑红莉栖",
    avatar: "/avatars/kurisu.png",
    tags: ["Steins;Gate", "天才科学家", "傲娇"],
    tagline: "和牧濑红莉栖一起，用清晰严谨的科学思维拆解难题",
    personality:
      "你是《命运石之门》中的牧濑红莉栖，年轻而才华出众的脑科学研究者。聪明理性、自信敏锐，偶尔会因害羞而表现出轻微傲娇，但内心认真关心学生。辅导时重视事实、逻辑和证据；指出错误时清楚直接，不挖苦、不羞辱学生。角色设定只影响交流风格，各学科讲解遵循现实依据。",
    teachingStyle:
      "科学探究式教学：先辨明已知条件、目标与证据，再提出可检验的思路并逐步推导；帮助学生理解结论为何成立，而不只记住答案。用简短问题确认理解，最后归纳知识、方法和易错点。",
    speakingStyle: "冷静知性、自信简洁，偶尔露出克制的傲娇和害羞，但始终认真耐心。常说“先别急着下结论”“把证据和推理链条摆出来”“这一步倒是做得不错”。鼓励具体自然，不卖弄术语，不让玩笑打断讲解。",
    voiceId: "8750a78673b44b568c08e23eebcea67e",
    voiceName: "牧濑红莉栖",
    voiceStyle: "[知的で冷静、少しツンとした口調]",
    greeting: "我是牧濑红莉栖。别被题目表面迷惑，先把条件和逻辑关系理清楚，再开始推导。",
  },
  {
    name: "阿尔托莉雅",
    avatar: "/avatars/artoria.png",
    tags: ["Fate", "沉稳认真", "责任感"],
    tagline: "与你并肩求索，认真面对每一次挑战",
    personality: "你是《Fate/stay night》中的阿尔托莉雅·潘德拉贡（Saber）。沉稳、诚实、认真，有强烈的责任感，尊重学生的努力。对错误明确指出但不苛责，用耐心与严谨陪伴学生。角色仅影响交流风格，所有学科知识遵循现实依据。",
    teachingStyle:
      "先明确目标与依据，再逐步推理；重视理解、实践与反馈。按学生选择的学习计划调整深度，在阅读时关注语境和表达，在解题时关注结构与迁移。",
    speakingStyle: "沉稳、礼貌、简短直接。鼓励具体，不夸张赞美。",
    voiceId: "4aa42286f3844a29a243e2ebd29f815f",
    voiceName: "阿尔托莉雅",
    voiceStyle: "[落ち着いた誠実で凛とした口調]",
    greeting: "你好，我是阿尔托莉雅。让我们明确今天的目标，一步一步完成。",
  },
];

let seeding: Promise<void> | null = null;

export function ensureSeed(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(tutors);
      if (Number(count) === 0) {
        await db.insert(tutors).values(PRESET_TUTORS.map((t) => ({ ...t, isPreset: true })));
        return;
      }
      const [defaultTutor] = await db
        .select({ id: tutors.id })
        .from(tutors)
        .where(and(eq(tutors.isPreset, true), eq(tutors.name, DEFAULT_TUTOR_NAME)))
        .limit(1);
      if (!defaultTutor) {
        const [legacyTutor] = await db
          .select({ id: tutors.id })
          .from(tutors)
          .where(and(eq(tutors.isPreset, true), eq(tutors.name, "艾琳"), eq(tutors.avatar, "/avatars/airin.png")))
          .limit(1);
        const values = { ...PRESET_TUTORS[0], isPreset: true };
        if (legacyTutor) {
          // Preserve the tutor ID used by existing classroom sessions.
          await db.update(tutors).set(values).where(eq(tutors.id, legacyTutor.id));
        } else {
          await db.insert(tutors).values(values);
        }
      }
      await db
        .update(tutors)
        .set(PRESET_TUTORS[1])
        .where(and(eq(tutors.isPreset, true), eq(tutors.name, "凛"), eq(tutors.avatar, "/avatars/rin.png")));
      await db
        .update(tutors)
        .set(PRESET_TUTORS[2])
        .where(and(eq(tutors.isPreset, true), eq(tutors.name, "晴人")));
      await db.update(tutors).set(PRESET_TUTORS[3]).where(and(eq(tutors.isPreset, true), eq(tutors.name, "小樱")));
      for (const preset of PRESET_TUTORS.slice(0, 3)) {
        const [row] = await db.select().from(tutors).where(and(eq(tutors.isPreset, true), eq(tutors.name, preset.name))).limit(1);
        if (!row) continue;
        const personality = row.personality.replace("对物理概念和推导要求严谨", "对概念、证据和推导要求严谨").replace("物理讲解遵循现实科学", "各学科讲解遵循现实依据");
        const teachingStyle = row.teachingStyle.replace("不打断数学讲解", "不打断学习主线").replace("先建立物理模型，做受力/运动/能量分析，再规范推导", "先建立思考框架，辨明条件与依据，再规范推导");
        await db.update(tutors).set({ tags: row.tags.filter((tag) => !["数学", "物理", "化学", "英语", "语文"].includes(tag)), tagline: preset.tagline, personality, teachingStyle }).where(eq(tutors.id, row.id));
      }
    })().catch((e) => {
      seeding = null;
      throw e;
    });
  }
  return seeding;
}

export async function listTutors(): Promise<TutorDTO[]> {
  await ensureSeed();
  const rows = await db
    .select()
    .from(tutors)
    .orderBy(sql`case when ${tutors.isPreset} and ${tutors.name} = ${DEFAULT_TUTOR_NAME} then 0 else 1 end`, asc(tutors.id));
  return rows.map(toTutorDTO);
}

export function sanitizeTutorInput(body: unknown): TutorInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 2000) => (typeof b[k] === "string" ? (b[k] as string).trim().slice(0, max) : "");
  const tags = Array.isArray(b.tags)
    ? (b.tags as unknown[]).filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 12)).slice(0, 6)
    : [];
  const avatar = typeof b.avatar === "string" && b.avatar ? b.avatar.slice(0, 1_500_000) : DEFAULT_TUTOR_AVATAR;
  return {
    name: str("name", 30) || "未命名导师",
    avatar,
    tags,
    tagline: str("tagline", 80),
    personality: str("personality"),
    teachingStyle: str("teachingStyle"),
    speakingStyle: str("speakingStyle"),
    voiceId: str("voiceId", 80),
    voiceName: str("voiceName", 80),
    voiceStyle: str("voiceStyle", 80),
    greeting: str("greeting", 300),
  };
}
