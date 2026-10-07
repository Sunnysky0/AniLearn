import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { AlertTriangle, ArrowRight, BookOpen, Check, FileUp } from "lucide-react";
import { db } from "@/db";
import { papers, problems, sessions, tutors } from "@/db/schema";
import { AppHeader } from "@/components/AppHeader";
import { PaperCard } from "@/components/PaperCard";
import { listTutors, paperPageMimes, toPaperDTO } from "@/lib/server/data";
import { getSettings, isTTSReady, providerMeta, resolveProviderKey } from "@/lib/server/settings";
import { formatDate } from "@/lib/text";

export const dynamic = "force-dynamic";

const problemCount = () =>
  sql<number>`(select count(*)::int from ${problems} where ${problems.paperId} = ${papers.id})`;

function SectionTitle({ title, href, linkLabel }: { title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-[#171717] pb-3">
      <h2 className="text-2xl font-semibold">{title}</h2>
      {href && (
        <Link href={href} className="inline-flex items-center gap-2 text-sm hover:underline">
          {linkLabel ?? "查看全部"} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

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
    .select({ paper: papers, pageMimes: paperPageMimes(), total: problemCount() })
    .from(papers)
    .orderBy(desc(papers.createdAt))
    .limit(8);
  const llmReady = !!resolveProviderKey(settings, settings.provider).key;
  const ttsReady = isTTSReady(settings);
  const meta = providerMeta(settings.provider);

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 pb-14 pt-7 sm:px-6 sm:pt-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="mb-2 text-sm text-[#626262]">试卷驱动学习</p>
            <h1 className="text-[32px] font-bold leading-tight">学习工作台</h1>
          </div>
          <Link href="/papers/new" className="ink-button text-sm">
            <FileUp className="h-4 w-4" /> 上传新试卷
          </Link>
        </div>
        <figure className="mb-6 overflow-hidden border-y-2 border-[#171717]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/hero.jpg"
            alt="大吉岭在课堂中讲解数学"
            className="h-40 w-full object-cover object-[center_14%] sm:h-48 lg:h-52"
          />
        </figure>
        <div className="mb-9 flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-[#c8c8c8] pb-4 text-xs text-[#626262]">
          <span className="inline-flex min-w-0 items-center gap-2 break-all">
            {llmReady ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            {llmReady
              ? `${meta.name} · ${settings.providers[settings.provider].chatModel}`
              : `模型未配置 · ${meta.name}`}
          </span>
          <span>{ttsReady ? "日语语音已配置" : "纯文字模式"}</span>
          {!llmReady && (
            <Link href="/settings" className="ml-auto text-[#171717] underline">
              前往设置
            </Link>
          )}
        </div>
        <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-10">
            <section>
              <SectionTitle title="继续学习" />
              {recent.length > 0 ? (
                <div className="divide-y divide-[#c8c8c8]">
                  {recent.map((r) => {
                    const done = Object.values(r.progress ?? {}).filter((v) => v === "done").length;
                    const total = Number(r.total) || 1;
                    return (
                      <Link
                        key={r.id}
                        href={`/classroom/${r.id}`}
                        className="group flex items-center gap-4 py-4 transition-colors hover:bg-[#eeeeee]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.tutorAvatar}
                          alt={r.tutorName}
                          className="h-14 w-14 shrink-0 border border-[#c8c8c8] object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <h3 className="line-clamp-2 text-lg font-semibold leading-relaxed">{r.paperTitle}</h3>
                          <p className="mt-1 text-xs text-[#626262]">
                            {r.subject} · {r.tutorName} ·{" "}
                            {r.status === "completed" ? "已完成" : `第 ${r.currentIdx + 1} 题`}
                          </p>
                        </div>
                        <div className="hidden shrink-0 text-right text-xs text-[#626262] sm:block">
                          <p className="tabular-nums">
                            已完成 {done} / {total}
                          </p>
                          <p className="mt-1">{formatDate(r.updatedAt.toISOString()).slice(5)}</p>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0" />
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="border-b border-[#c8c8c8] py-7">
                  <BookOpen className="mb-3 h-6 w-6 text-[#626262]" />
                  <p className="text-lg font-medium">尚无课堂记录</p>
                  <Link href="/papers/new" className="mt-3 inline-flex items-center gap-2 text-sm underline">
                    上传第一份试卷 <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              )}
            </section>
            <section>
              <SectionTitle title="最近试卷" href="/papers" linkLabel="全部试卷" />
              {paperRows.length ? (
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  {paperRows.map((r) => (
                    <PaperCard key={r.paper.id} paper={toPaperDTO(r.paper, r.pageMimes)} problemCount={Number(r.total)} />
                  ))}
                </div>
              ) : (
                <div className="border-b border-[#c8c8c8] py-7 text-sm text-[#626262]">试卷库为空</div>
              )}
            </section>
          </div>
          <aside className="min-w-0 lg:border-l lg:border-[#c8c8c8] lg:pl-7">
            <SectionTitle title="我的导师" href="/tutors" linkLabel="管理" />
            <div className="divide-y divide-[#c8c8c8]">
              {tutorList.slice(0, 4).map((t) => (
                <Link key={t.id} href={`/tutors/${t.id}`} className="flex items-start gap-3 py-4 hover:bg-[#eeeeee]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.avatar}
                    alt={t.name}
                    className="h-14 w-14 shrink-0 border border-[#c8c8c8] object-cover"
                  />
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold">{t.name}</h3>
                    <p className="mt-1 text-xs text-[#626262]">{t.subject}</p>
                    <p className="mt-2 text-xs leading-relaxed text-[#626262]">{t.tagline}</p>
                  </div>
                </Link>
              ))}
            </div>
          </aside>
        </div>
      </main>
      <footer className="mx-auto flex max-w-7xl flex-wrap justify-between gap-2 border-t-2 border-[#171717] px-4 py-5 text-xs text-[#626262] sm:px-6">
        <span className="font-serif font-semibold text-[#171717]">AniLearn</span>
        <span>试卷 · 课堂 · 笔记</span>
      </footer>
    </div>
  );
}
