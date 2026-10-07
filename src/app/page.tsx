import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Brain,
  CheckCircle2,
  FileUp,
  GraduationCap,
  MessagesSquare,
  PenLine,
  Sparkles,
} from "lucide-react";
import { db } from "@/db";
import { papers, problems, sessions, tutors } from "@/db/schema";
import { AppHeader } from "@/components/AppHeader";
import { PaperCard } from "@/components/PaperCard";
import { listTutors, toPaperDTO } from "@/lib/server/data";
import { getSettings, isTTSReady, providerMeta, resolveProviderKey } from "@/lib/server/settings";
import { formatDate } from "@/lib/text";

export const dynamic = "force-dynamic";

const problemCount = () =>
  sql<number>`(select count(*)::int from ${problems} where ${problems.paperId} = ${papers.id})`;

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 ring-1 ${
        ok ? "bg-emerald-400/15 text-emerald-100 ring-emerald-300/30" : "bg-amber-400/15 text-amber-100 ring-amber-300/30"
      }`}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function SectionTitle({ title, href, linkLabel }: { title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-5 flex items-end justify-between">
      <h2 className="flex items-center gap-2.5 text-xl font-bold text-slate-800">
        <span className="h-5 w-1.5 rounded-full bg-gradient-to-b from-sky-400 to-blue-600" />
        {title}
      </h2>
      {href && (
        <Link href={href} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
          {linkLabel ?? "查看全部"} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

const STEPS = [
  { icon: FileUp, title: "上传试卷", desc: "拍照或 PDF 均可，支持多页，自动排版成高清页面。" },
  { icon: Brain, title: "AI 全面解析", desc: "逐题识别题目，标注关键点、易错点和对应的教材章节知识点。" },
  { icon: MessagesSquare, title: "一对一讲题", desc: "导师判断先让你做还是直接讲，短消息+真人语音，随时可以打断提问。" },
  { icon: PenLine, title: "板书沉淀笔记", desc: "黑板同步书写精炼板书，可一键导出为笔记反复复习。" },
];

export default async function HomePage() {
  const [settings, tutorList] = await Promise.all([getSettings(), listTutors()]);
  const recent = await db
    .select({
      id: sessions.id,
      currentIdx: sessions.currentIdx,
      status: sessions.status,
      progress: sessions.progress,
      updatedAt: sessions.updatedAt,
      paperTitle: papers.title,
      subject: papers.subject,
      tutorName: tutors.name,
      tutorAvatar: tutors.avatar,
      total: problemCount(),
    })
    .from(sessions)
    .innerJoin(papers, eq(sessions.paperId, papers.id))
    .innerJoin(tutors, eq(sessions.tutorId, tutors.id))
    .orderBy(desc(sessions.updatedAt))
    .limit(6);
  const paperRows = await db
    .select({ paper: papers, total: problemCount() })
    .from(papers)
    .orderBy(desc(papers.createdAt))
    .limit(8);

  const llmReady = !!resolveProviderKey(settings, settings.provider).key;
  const ttsReady = isTTSReady(settings);
  const meta = providerMeta(settings.provider);
  const lead = tutorList[0];

  return (
    <div className="min-h-screen">
      <AppHeader />
      <section className="relative overflow-hidden bg-gradient-to-br from-[#10204a] via-[#18306a] to-[#1e4fc9] text-white">
        <div className="pointer-events-none absolute -right-40 -top-40 h-[520px] w-[520px] rounded-full bg-sky-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-52 left-10 h-[420px] w-[420px] rounded-full bg-indigo-400/20 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:py-20">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs tracking-wider text-sky-100 ring-1 ring-white/20">
              <Sparkles className="h-3.5 w-3.5" /> EPDL · 试卷驱动学习法 · 专为高考设计
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight sm:text-5xl">
              把每一张试卷，
              <br />
              变成一堂
              <span className="bg-gradient-to-r from-sky-300 to-amber-200 bg-clip-text text-transparent">专属的一对一课</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-blue-100/90">
              上传试卷照片或 PDF，AI 导师先全面解析每道题的考点、关键步骤与教材知识点，再像真人老师一样逐题陪你讲透——有温度的声音、同步的黑板板书，任何时候都可以打断提问。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/papers/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 font-semibold text-blue-700 shadow-lg shadow-blue-950/30 transition hover:bg-blue-50"
              >
                <FileUp className="h-5 w-5" />
                上传试卷开始学习
              </Link>
              <Link
                href="/tutors"
                className="inline-flex items-center gap-2 rounded-full bg-white/10 px-6 py-3 font-semibold text-white ring-1 ring-white/30 transition hover:bg-white/20"
              >
                <GraduationCap className="h-5 w-5" />
                定制我的导师
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-3 text-xs">
              <StatusChip
                ok={llmReady}
                label={
                  llmReady
                    ? `模型：${meta.name} · ${settings.providers[settings.provider].chatModel}`
                    : `模型未配置（当前：${meta.name}）`
                }
              />
              <StatusChip ok={ttsReady} label={ttsReady ? "语音：Fish Audio 已连接" : "语音：未配置 Fish Audio"} />
            </div>
          </div>
          <div className="relative">
            <div className="overflow-hidden rounded-3xl shadow-2xl ring-1 ring-white/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/hero.jpg" alt="AniLearn 课堂" className="aspect-[16/10] w-full object-cover" />
            </div>
            {lead && (
              <div className="absolute -bottom-6 -left-4 flex items-center gap-3 rounded-2xl bg-white/95 p-3 pr-5 text-slate-700 shadow-xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={lead.avatar} alt={lead.name} className="h-12 w-12 rounded-full object-cover ring-2 ring-blue-200" />
                <div>
                  <div className="text-sm font-bold">AI导师 · {lead.name}</div>
                  <div className="text-xs text-slate-500">“先别急着落笔，让我们从条件出发。”</div>
                </div>
              </div>
            )}
            <div className="absolute -right-3 top-6 hidden rounded-2xl bg-[#1f3a35] px-4 py-3 text-sm text-amber-200 shadow-xl ring-4 ring-[#3d4349] sm:block">
              ✓ 考点 · 步骤 · 易错点
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-7xl space-y-14 px-4 py-14 sm:px-6">
        {!llmReady && (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <AlertTriangle className="h-6 w-6 shrink-0 text-amber-500" />
            <div className="min-w-[240px] flex-1">
              <div className="font-semibold text-amber-800">还差一步：配置 AI 模型</div>
              <div className="text-sm text-amber-700">
                支持 OpenAI / Anthropic / Grok / Gemini，填写任意一家的 API Key 即可开始；语音由 Fish Audio 提供（可选）。
              </div>
            </div>
            <Link href="/settings" className="rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-600">
              前往设置
            </Link>
          </div>
        )}

        {recent.length > 0 && (
          <section>
            <SectionTitle title="继续学习" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((r) => {
                const done = Object.values(r.progress ?? {}).filter((v) => v === "done").length;
                const total = Number(r.total) || 1;
                const pct = Math.round((done / total) * 100);
                return (
                  <Link
                    key={r.id}
                    href={`/classroom/${r.id}`}
                    className="group flex gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-lg"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.tutorAvatar} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover ring-2 ring-blue-100" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-1 font-semibold text-slate-800">{r.paperTitle}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.subject} · 导师 {r.tutorName} · {r.status === "completed" ? "已完成" : `进行到第 ${r.currentIdx + 1} 题`}
                      </div>
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                        <span>
                          已完成 {done}/{total}
                        </span>
                        <span>{formatDate(r.updatedAt.toISOString()).slice(5)}</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <SectionTitle title="EPDL 学习流程" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <div key={s.title} className="relative rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
                <div className="absolute right-4 top-3 text-4xl font-black text-slate-100">0{i + 1}</div>
                <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-blue-500/30">
                  <s.icon className="h-5 w-5" />
                </div>
                <div className="relative mt-4 font-semibold text-slate-800">{s.title}</div>
                <p className="relative mt-1.5 text-sm leading-relaxed text-slate-500">{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle title="我的试卷" href="/papers" linkLabel="全部试卷" />
          {paperRows.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {paperRows.map((r) => (
                <PaperCard key={r.paper.id} paper={toPaperDTO(r.paper)} problemCount={Number(r.total)} />
              ))}
            </div>
          ) : (
            <Link
              href="/papers/new"
              className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 py-14 text-slate-500 transition hover:border-blue-400 hover:text-blue-600"
            >
              <BookOpenCheck className="h-10 w-10" />
              <div className="mt-3 font-semibold">还没有试卷，上传第一张开始学习吧</div>
              <div className="mt-1 text-sm">支持 JPG / PNG 图片和 PDF</div>
            </Link>
          )}
        </section>

        <section>
          <SectionTitle title="我的导师" href="/tutors" linkLabel="管理导师" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tutorList.slice(0, 4).map((t) => (
              <Link
                key={t.id}
                href={`/tutors/${t.id}`}
                className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-lg"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.avatar} alt={t.name} className="h-16 w-16 rounded-full object-cover ring-4 ring-blue-50" />
                <div className="min-w-0">
                  <div className="font-bold text-slate-800">AI导师 · {t.name}</div>
                  <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">{t.tags.join(" | ")}</div>
                  <div className="mt-1 line-clamp-1 text-xs text-slate-400">{t.tagline}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-400">
        AniLearn · Exam Paper Driven Learning · 为高考而生
      </footer>
    </div>
  );
}
