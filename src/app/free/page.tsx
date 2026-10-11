import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Clock3, MessageCircle, Settings2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { StartFreeSession } from "@/components/free/StartFreeSession";
import { getSettings, isLLMReady, isTTSReady } from "@/lib/server/settings";
import { listTutors } from "@/lib/server/data";
import { listFreeSessions } from "@/lib/server/free-data";
import { formatDate } from "@/lib/text";

export const dynamic = "force-dynamic";

export default async function FreePage({ searchParams }: { searchParams: Promise<{ tutor?: string }> }) {
  const [settings, tutors, recent, params] = await Promise.all([getSettings(), listTutors(), listFreeSessions(20), searchParams]);
  const ready = isLLMReady(settings, "chat");
  const preferredId = Number(params.tutor);
  const selectedTutor = tutors.find((tutor) => tutor.id === preferredId);
  return <div className="min-h-dvh">
    <AppHeader />
    <main className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 sm:pt-11">
      <div className="grid gap-8 border-b-2 border-[#171717] pb-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] lg:items-end">
        <div>
          <p className="mb-2 text-sm text-[#626262]">不必准备材料，想到什么就问什么</p>
          <h1 className="text-4xl font-bold sm:text-5xl">自由提问</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#626262]">选一位导师直接开始。你可以追问、换话题或附上图片；每段交流都会留下对话和可复习的黑板笔记。</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#c8c8c8] pt-4 text-xs text-[#626262] lg:justify-end lg:border-0 lg:pt-0">
          <span>{ready ? "讲解模型已就绪" : "需要先配置讲解模型"}</span><span>{isTTSReady(settings) ? "可使用日语语音" : "可先使用文字课堂"}</span>
          {!ready && <Link href="/settings" className="inline-flex items-center gap-1 underline"><Settings2 className="h-3.5 w-3.5" />设置模型</Link>}
        </div>
      </div>
      {selectedTutor && <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-l-2 border-[#171717] bg-[#eeeeee] px-4 py-3">
        <p className="text-sm">已为你选中 <strong>{selectedTutor.name}</strong></p><Link href="#tutors" className="text-sm underline">更换导师</Link>
      </div>}
      <div className="grid gap-10 pt-9 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section id="tutors" className="min-w-0">
          <div className="mb-5 flex items-baseline justify-between border-b border-[#c8c8c8] pb-3"><h2 className="text-2xl font-semibold">选择导师</h2><span className="text-xs text-[#626262]">{tutors.length} 位</span></div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {tutors.map((tutor) => <article key={tutor.id} className={`flex min-h-64 flex-col border-t-2 p-4 ${tutor.id === preferredId ? "border-[#171717] bg-[#f0f0ec]" : "border-[#c8c8c8] bg-white"}`}>
              <div className="flex gap-3">
                <Image src={tutor.avatar} width={64} height={64} alt={tutor.name} className="h-16 w-16 shrink-0 border border-[#c8c8c8] object-cover" />
                <div className="min-w-0"><h3 className="text-xl font-semibold">{tutor.name}</h3><p className="mt-1 text-xs text-[#626262]">{tutor.tags.join(" · ") || "一对一导师"}</p></div>
              </div>
              <p className="mt-3 min-h-10 text-sm leading-6 text-[#626262]">{tutor.tagline || tutor.teachingStyle}</p>
              <div className="mt-auto flex flex-wrap items-end justify-between gap-3 border-t border-[#e5e5e5] pt-4">
                <span className="text-[11px] text-[#777]">{tutor.voiceName || "自定义声音"} · {tutor.voiceStyle || "日语语音"}</span>
                <StartFreeSession tutorId={tutor.id} label="开始提问" className="ink-button !px-3 !py-2 text-sm" />
              </div>
            </article>)}
          </div>
        </section>
        <aside className="min-w-0 lg:border-l lg:border-[#c8c8c8] lg:pl-7">
          <div className="mb-5 flex items-baseline justify-between border-b border-[#c8c8c8] pb-3"><h2 className="text-2xl font-semibold">最近交流</h2><span className="text-xs text-[#626262]">自动保存</span></div>
          {recent.sessions.length ? <div className="divide-y divide-[#c8c8c8]">
            {recent.sessions.map(({ session, tutor, currentTopicTitle, topicCount }) => <Link key={session.id} href={`/free-classroom/${session.id}`} className="group flex gap-3 py-4 hover:bg-[#eeeeee]">
              <Image src={tutor.avatar} width={44} height={44} alt={tutor.name} className="h-11 w-11 shrink-0 border border-[#c8c8c8] object-cover" />
              <div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{session.title || `与${tutor.name}自由提问`}</h3><p className="mt-1 truncate text-xs text-[#626262]">{currentTopicTitle || "还没有话题"} · {tutor.name}</p><p className="mt-1 flex items-center gap-1 text-[10px] text-[#888]"><Clock3 className="h-3 w-3" />{formatDate(session.updatedAt)} · {topicCount} 个话题</p></div><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[#777] group-hover:text-black" />
            </Link>)}
            {recent.hasMore && <Link href="/free/history" className="mt-3 inline-flex items-center gap-2 text-sm underline">查看全部历史<ArrowRight className="h-4 w-4" /></Link>}
          </div> : <div className="border-b border-[#c8c8c8] py-8 text-center text-sm text-[#777]"><MessageCircle className="mx-auto mb-3 h-6 w-6" /><p>还没有自由提问记录</p><p className="mt-1 text-xs">选择导师后，课堂会自动保存在这里。</p></div>}
          <div className="mt-8 border-t border-[#c8c8c8] pt-4 text-xs leading-6 text-[#777]">自由提问不需要试卷、外刊或学科设置。导师会根据你的问题调整讲解深度；板书按话题保存，之后可以继续同一段交流。</div>
        </aside>
      </div>
    </main>
  </div>;
}
