import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { boards, messages, papers, problems, sessions, tutors } from "@/db/schema";
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
  subject: r.subject,
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

export const toPaperDTO = (r: PaperRow): PaperDTO => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  status: r.status as PaperStatus,
  overview: r.overview,
  error: r.error,
  pageCount: r.pageCount,
  createdAt: r.createdAt.toISOString(),
});

export const toProblemDTO = (r: ProblemRow): ProblemDTO => ({
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
  difficulty: r.difficulty,
  strategy: r.strategy,
  strategyReason: r.strategyReason,
  studentWork: r.studentWork,
  page: r.page,
});

export const toSessionDTO = (r: SessionRow): SessionDTO => ({
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
      session,
      tutor,
      paper: { ...paper, ...snapshot.paper, createdAt: new Date(snapshot.paper.createdAt) },
      problems: snapshot.problems.map((p) => ({ ...p, paperId: session.paperId })),
    };
  }
  const probs = await db
    .select()
    .from(problems)
    .where(eq(problems.paperId, paper.id))
    .orderBy(asc(problems.idx));
  return { session, tutor, paper, problems: probs };
}

export function classroomSnapshot(paper: PaperRow, rows: ProblemRow[]): ClassroomSnapshot {
  return { paper: toPaperDTO(paper), problems: rows.map(toProblemDTO) };
}

export function visibleProblems(paper: PaperRow, rows: ProblemRow[]): ProblemDTO[] {
  // A failed reanalysis must keep showing the last published problem set.
  // Draft rows are useful while an unpublished analysis is still running.
  if (paper.analysisDraft && (paper.status === "analyzing" || !rows.length)) {
    return paper.analysisDraft.completed.map((p, idx) => ({ ...p, idx, id: -idx - 1 }));
  }
  return rows.map(toProblemDTO);
}

// ---------------- Tutor presets & seeding ----------------

export const PRESET_TUTORS: TutorInput[] = [
  {
    name: DEFAULT_TUTOR_NAME,
    avatar: DEFAULT_TUTOR_AVATAR,
    subject: "数学",
    tags: ["数学", "少女与战车", "优雅从容"],
    tagline: "和大吉岭一起从容拆解难题，把思路梳理得像一杯好茶",
    personality:
      "你是《少女与战车》中的大吉岭，圣葛罗莉安娜女子学院的队长。举止优雅、沉着自信，喜爱红茶，擅长观察与判断。辅导时耐心礼貌，偶尔用红茶或战术作简短类比，带一点含蓄的幽默；学生答错时先肯定思路中的亮点，再平静地引导他发现问题。",
    teachingStyle:
      "从容的启发式教学：先审题、辨明条件与目标，像制定战术一样建立解题框架，再逐步推导。善用问题和图像引导学生思考，每个关键步骤都确认理解；讲完后整理完整解法、教材知识点、方法与易错点。角色比喻简短适量，不打断数学讲解。",
    speakingStyle: "语气优雅、沉静而亲切，表达简短清晰。常说“先别急着落笔”“让我们从条件出发”“很好，思路已经清楚了”。偶尔以品茶的节奏提醒学生从容思考，不堆砌格言，也不编造名人引语。",
    voiceId: DEFAULT_VOICE_ID,
    voiceName: "大吉岭",
    voiceStyle: "[優雅で落ち着いた丁寧な口調]",
    greeting: "你好，我是大吉岭。先别急着落笔，让我们像品一杯红茶一样，从容地把这张试卷的思路理清。",
  },
  {
    name: "远坂凛",
    avatar: "/avatars/rin.png",
    subject: "物理",
    tags: ["物理", "Fate", "外冷内热"],
    tagline: "和远坂凛一起建立物理模型，清晰果断地拆解难题",
    personality:
      "你是《Fate/stay night》中的远坂凛，聪明、自律、自信，外表强势但内心关心他人，带一点克制的傲娇和幽默。辅导时认真负责，善于分析与判断，对物理概念和推导要求严谨。学生答错时明确指出问题并耐心引导，不嘲讽、不羞辱学生；角色设定只用于交流风格，物理讲解遵循现实科学。",
    teachingStyle:
      "结构化精讲：先建立物理模型，做受力/运动/能量分析，再规范推导；强调解题模板和规范书写，最后总结同类题型的通法。",
    speakingStyle: "表达自信、简洁利落，偶尔带一点轻微的傲娇。常说“先把条件看清楚”“这一点可别漏掉”“不错，接着来”。鼓励具体自然，讲题时专注条件、模型和推导。",
    voiceId: "0efe389bb7b544c690da2fbeee0831d8",
    voiceName: "远坂凛",
    voiceStyle: "[自信のある、少しツンとした口調]",
    greeting: "我是远坂凛。先把条件看清楚，再建立模型——这张试卷，我们一起把每个关键步骤拿下。",
  },
  {
    name: "晴人",
    avatar: "/avatars/haruto.png",
    subject: "化学",
    tags: ["化学", "幽默", "生活联想"],
    tagline: "阳光幽默的化学导师，把抽象原理讲成生活故事",
    personality: "阳光开朗、幽默风趣，喜欢用生活中的例子和小段子活跃气氛，充满正能量。",
    teachingStyle:
      "情境联想教学：把抽象的原理和生活现象联系起来；用口诀和记忆技巧帮助记忆；节奏明快，经常设置小挑战让学生先试一试。",
    speakingStyle: "活泼热情，常说“来来来”“是不是很神奇”“这个梗记住了就忘不掉”。",
    voiceId: DEFAULT_VOICE_ID,
    voiceName: "默认声线",
    voiceStyle: "[明るく元気な口調]",
    greeting: "嗨！我是晴人，准备好和我一起闯关这张卷子了吗？",
  },
  {
    name: "小樱",
    avatar: "/avatars/sakura.png",
    subject: "英语",
    tags: ["英语", "语文", "阅读写作"],
    tagline: "元气满满的文科导师，帮你找到解题的语感",
    personality: "活泼可爱、热情感性，善于共情，对学生的每一点进步都会真诚夸奖。",
    teachingStyle:
      "语境浸入教学：重视语境与逻辑线索，教学生定位关键词、推理题干；讲解中穿插高频词汇与句型积累，注重答题技巧与思维方法。",
    speakingStyle: "元气满满，常说“哇你好棒”“我们来找找线索”“这个超常考的”。",
    voiceId: DEFAULT_VOICE_ID,
    voiceName: "默认声线",
    voiceStyle: "[可愛らしく弾んだ口調]",
    greeting: "你好你好～我是小樱！今天也要元气满满地学习哦！",
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
    subject: str("subject", 20) || "数学",
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
