// Shared types used by both server and client code.

export type ProviderId = "openai" | "anthropic" | "xai" | "gemini";
export type ConnectionProtocol = ProviderId | "openai-compatible";
export interface ProviderConnection {
  id: string;
  name: string;
  protocol: ConnectionProtocol;
  baseUrl: string;
  apiKey: string;
  envProvider?: ProviderId;
}
export interface ModelBinding { connectionId: string; model: string }
export type PublicConnection = Omit<ProviderConnection, "apiKey"> & {
  hasKey: boolean; keySource: KeySource; keyPreview: string;
};
export const PACES = [
  { id: "thorough", name: "条分缕析", description: "逐题完整讲解" },
  { id: "focused", name: "纲举目张", description: "全部重点，代表题去重" },
  { id: "essential", name: "由博返约", description: "核心主线与关键突破" },
  { id: "challenge", name: "游刃有余", description: "难题、陷阱与个人错题" },
  { id: "advanced", name: "羽登化境", description: "推广、迁移与拓展变式" },
] as const;
export type TeachingPace = (typeof PACES)[number]["id"];
export const DEFAULT_PACE: TeachingPace = "focused";
export function isTeachingPace(value: unknown): value is TeachingPace {
  return PACES.some((pace) => pace.id === value);
}
export interface LearningGoal { id: string; topic: CoverageTopic; description: string }
export interface LearningUnit { idx: number; related: number[]; reason: string; goals: LearningGoal[] }
export interface LearningPlan { version: number; pace: TeachingPace; request: string; units: LearningUnit[] }
export type PaperStatus = "uploaded" | "analyzing" | "ready" | "failed";
export type ProblemProgress = "pending" | "active" | "done";
export type TurnAction = "wait" | "continue" | "next" | "finish";
export type TurnIntent = "complete_problem" | "goodbye";
export interface TurnRequest {
  text?: string;
  images?: string[];
  intent?: TurnIntent;
  problemIdx?: number;
  planVersion?: number;
}
export const COMPLETE_PROBLEM_TEXT = "我懂了，下一题";
export const GOODBYE_TEXT = "就到这里吧，再见";
export function turnIntentForText(text: string): TurnIntent | undefined {
  if (text.trim() === COMPLETE_PROBLEM_TEXT) return "complete_problem";
  if (text.trim() === GOODBYE_TEXT) return "goodbye";
}
export const MAX_PAPER_PAGES = 12;
export const MAX_PAPER_TEXT_BYTES = 1_500_000;
export const CORE_COVERAGE_TOPICS = ["solution", "knowledge", "skills", "pitfalls"] as const;
export const COVERAGE_TOPICS = [...CORE_COVERAGE_TOPICS, "extension", "practice"] as const;
export type CoverageTopic = (typeof COVERAGE_TOPICS)[number];
export type TeachingCoverage = Record<string, string>;

export interface KnowledgePoint {
  name: string;
  source: string;
  detail: string;
}

export interface BoardBlock {
  id: string;
  md: string;
  at: number;
}

export interface ProviderSettings {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  analysisModel: string;
}

export interface SettingsData {
  connections: ProviderConnection[];
  models: { chat: ModelBinding; analysis: ModelBinding };
  provider: ProviderId;
  providers: Record<ProviderId, ProviderSettings>;
  fish: { apiKey: string; model: string; enabled: boolean; proxyUrl: string };
  autoContinue: boolean;
}

export type KeySource = "db" | "env" | "none";

export interface PublicProviderSettings {
  baseUrl: string;
  chatModel: string;
  analysisModel: string;
  hasKey: boolean;
  keySource: KeySource;
  keyPreview: string;
}

export interface PublicSettings {
  connections: PublicConnection[];
  models: SettingsData["models"];
  provider: ProviderId;
  providers: Record<ProviderId, PublicProviderSettings>;
  fish: {
    model: string;
    enabled: boolean;
    hasProxy: boolean;
    proxyPreview: string;
    hasKey: boolean;
    keySource: KeySource;
    keyPreview: string;
  };
  autoContinue: boolean;
}

export interface TTSRequest {
  text: string;
  voiceId?: string;
  fresh?: boolean;
}

export interface FishApiError {
  error: string;
  code: string;
  upstreamStatus?: number;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  vendor: string;
  color: string;
  envKeys: string[];
  defaultBaseUrl: string;
  defaultChatModel: string;
  defaultAnalysisModel: string;
  models: string[];
  keyHint: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    name: "OpenAI",
    vendor: "GPT 系列",
    color: "#10a37f",
    envKeys: ["OPENAI_API_KEY"],
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultChatModel: "gpt-4.1",
    defaultAnalysisModel: "gpt-4.1",
    models: ["gpt-5", "gpt-5-mini", "gpt-5-chat-latest", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o4-mini"],
    keyHint: "sk-...",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    vendor: "Claude 系列",
    color: "#d97757",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    defaultBaseUrl: "https://api.anthropic.com",
    defaultChatModel: "claude-sonnet-4-5",
    defaultAnalysisModel: "claude-sonnet-4-5",
    models: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-sonnet-4-0", "claude-3-7-sonnet-latest"],
    keyHint: "sk-ant-...",
  },
  {
    id: "xai",
    name: "Grok",
    vendor: "xAI",
    color: "#111827",
    envKeys: ["XAI_API_KEY", "GROK_API_KEY"],
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultChatModel: "grok-4-fast-non-reasoning",
    defaultAnalysisModel: "grok-4",
    models: ["grok-4", "grok-4-fast-reasoning", "grok-4-fast-non-reasoning", "grok-3", "grok-2-vision-1212"],
    keyHint: "xai-...",
  },
  {
    id: "gemini",
    name: "Gemini",
    vendor: "Google",
    color: "#4285f4",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultChatModel: "gemini-2.5-flash",
    defaultAnalysisModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro-preview"],
    keyHint: "AIza...",
  },
];

export const SUBJECTS = ["数学", "物理", "化学", "生物", "语文", "英语", "历史", "地理", "政治"];

export const DEFAULT_VOICE_ID = "db1553e441c84b49bf250912563ec8fc";
export const DEFAULT_TUTOR_NAME = "大吉岭";
export const DEFAULT_TUTOR_AVATAR = "/avatars/darjeeling.png";

// ---------- DTOs ----------

export interface TutorDTO {
  id: number;
  name: string;
  avatar: string;
  tags: string[];
  tagline: string;
  personality: string;
  teachingStyle: string;
  speakingStyle: string;
  voiceId: string;
  voiceName: string;
  voiceStyle: string;
  greeting: string;
  isPreset: boolean;
}

export type TutorInput = Omit<TutorDTO, "id" | "isPreset">;

export interface PaperDTO {
  id: number;
  title: string;
  subject: string;
  status: PaperStatus;
  overview: string;
  error: string | null;
  pageCount: number;
  /** MIME types in page order, when the caller has loaded page metadata. */
  pageMimes?: string[];
  createdAt: string;
  pace?: TeachingPace;
  learningRequest?: string;
  inventory?: PaperInventory | null;
  analysisPlan?: LearningPlan | null;
  revision?: number;
}

export interface ProblemDTO {
  id: number;
  idx: number;
  number: string;
  type: string;
  title: string;
  content: string;
  answer: string;
  solution: string;
  keyPoints: string[];
  knowledgePoints: KnowledgePoint[];
  skills: string[];
  difficulty: number;
  strategy: string;
  strategyReason: string;
  studentWork: string;
  page: number;
  analysis?: "ready" | "unparsed";
}

export interface ProblemDirectoryItem {
  idx: number; number: string; page: number; endPage: number; content: string;
  title?: string; difficulty?: number; topics?: string[]; methods?: string[];
  traps?: string[]; studentWork?: string; core?: boolean;
}
export interface DirectoryProblemDTO { item: ProblemDirectoryItem; analysis: ProblemDTO | null }

export interface PaperInventory {
  title: string;
  overview: string;
  items: ProblemDirectoryItem[];
}

export type AnalyzedProblem = Omit<ProblemDTO, "id" | "idx">;
export interface AnalysisDraft {
  inventory: PaperInventory | null;
  completed: AnalyzedProblem[];
  indexed?: Record<string, AnalyzedProblem>;
  plan?: LearningPlan;
  revision?: number;
}

export interface ClassroomSnapshot {
  paper: PaperDTO;
  problems: ProblemDTO[];
  inventory?: PaperInventory | null;
}

export interface SessionDTO {
  id: number;
  paperId: number;
  tutorId: number;
  currentIdx: number;
  status: string;
  progress: Record<string, ProblemProgress>;
  createdAt: string;
  updatedAt: string;
  plan?: LearningPlan | null;
  pendingPlan?: LearningPlan | null;
}

export interface MessageDTO {
  id: number;
  role: "tutor" | "user" | "system";
  kind: "text" | "problem" | "board" | "notice";
  content: string;
  speech: string;
  problemIdx: number;
  attachments: string[];
  createdAt: string;
}

export interface BoardDTO {
  problemIdx: number;
  title: string;
  blocks: BoardBlock[];
}

export type TurnEvent =
  | { type: "plan"; session: SessionDTO }
  | { type: "user"; message: MessageDTO }
  | { type: "message"; message: MessageDTO }
  | { type: "board"; board: BoardDTO; blockId: string; message: MessageDTO }
  | { type: "problem"; message: MessageDTO; session: SessionDTO }
  | { type: "done"; action: TurnAction; session: SessionDTO; intent?: TurnIntent }
  | { type: "error"; error: string };

export type AnalysisEvent =
  | { type: "inventory"; inventory: PaperInventory; plan: LearningPlan }
  | { type: "status"; status: PaperStatus }
  | { type: "paper"; paper: PaperDTO }
  | { type: "problem"; problem: ProblemDTO }
  | { type: "progress"; chars: number }
  | { type: "done"; paper: PaperDTO }
  | { type: "error"; error: string };

export type ReadingLanguage = "en" | "ja";
export interface ReadingParagraph { id: string; text: string; page: number }
export interface ReadingDTO {
  id: number; title: string; language: ReadingLanguage; status: string;
  paragraphs: ReadingParagraph[]; extracted: string; overview: string;
  error: string | null; revision: number; createdAt: string; pageCount: number; expectedPageCount?: number;
}
export interface ReadingAnalysisStatus {
  status: string;
  revision?: number;
  completedPages: number;
  totalPages: number;
  currentPage: number | null;
  sourcesComplete: boolean;
  running: boolean;
  resumable: boolean;
  error: string | null;
}
export interface ReadingAnalysisProgress { done: number; total: number; page: number }
export type ReadingAnalysisEvent =
  | ({ type: "progress" } & ReadingAnalysisProgress)
  | { type: "done"; reading: ReadingDTO }
  | { type: "error"; error: string };
export interface ReadingMessage {
  id: number; role: "user" | "tutor"; content: string; speech: string;
  paragraphIdx: number; kind: "text" | "quote" | "example" | "exercise" | "feedback";
  language: "zh-CN" | ReadingLanguage;
}
export interface ReadingSessionDTO {
  id: number; readingId: number; tutorId: number; currentIdx: number;
  status: string; progress: Record<string, ProblemProgress>;
  notes: Record<string, string[]>; updatedAt: string;
}
export type ReadingTurnEvent =
  | { type: "message"; message: ReadingMessage }
  | { type: "notes"; paragraphIdx: number; notes: string[] }
  | { type: "done"; session: ReadingSessionDTO; action: TurnAction; goodbye?: boolean }
  | { type: "error"; error: string };

export interface VoiceItem {
  id: string;
  title: string;
  description: string;
  cover: string;
  languages: string[];
  author: string;
  likes: number;
  uses: number;
  sample: string | null;
}
