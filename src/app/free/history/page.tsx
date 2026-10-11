import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Clock3, MessageCircle } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { listFreeSessions } from "@/lib/server/free-data";
import { formatDate } from "@/lib/text";

export const dynamic = "force-dynamic";

export default async function FreeHistoryPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  let before: { updatedAt: Date; id: number } | undefined;
  if (cursor) {
    const split = cursor.lastIndexOf("|");
    const updatedAt = new Date(cursor.slice(0, split));
    const id = Number(cursor.slice(split + 1));
    if (split > 0 && Number.isFinite(updatedAt.getTime()) && Number.isSafeInteger(id) && id > 0) before = { updatedAt, id };
  }
  const page = await listFreeSessions(20, before);
  return <div className="min-h-dvh"><AppHeader /><main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
    <Link href="/free" className="inline-flex items-center gap-2 text-sm text-[#626262] hover:text-black"><ArrowLeft className="h-4 w-4" />返回自由提问</Link>
    <div className="mt-5 flex items-end justify-between border-b-2 border-[#171717] pb-4"><div><p className="text-sm text-[#626262]">可随时继续之前的交流</p><h1 className="mt-1 text-3xl font-bold">自由提问历史</h1></div><span className="text-xs text-[#626262]">第 {cursor ? "后续" : "1"} 页</span></div>
    {page.sessions.length ? <div className="divide-y divide-[#c8c8c8]">
      {page.sessions.map(({ session, tutor, currentTopicTitle, topicCount }) => <Link key={session.id} href={`/free-classroom/${session.id}`} className="group flex items-center gap-4 py-5 hover:bg-[#eeeeee]">
        <Image src={tutor.avatar} width={56} height={56} alt={tutor.name} className="h-14 w-14 shrink-0 border border-[#c8c8c8] object-cover" />
        <div className="min-w-0 flex-1"><h2 className="truncate text-lg font-semibold">{session.title || `与${tutor.name}自由提问`}</h2><p className="mt-1 flex items-center gap-1 text-xs text-[#626262]"><MessageCircle className="h-3.5 w-3.5" />{tutor.name} · {currentTopicTitle || "尚无话题"} · {topicCount} 个话题</p><p className="mt-1 flex items-center gap-1 text-[10px] text-[#888]"><Clock3 className="h-3 w-3" />{formatDate(session.updatedAt)}</p></div>
        <ArrowRight className="h-4 w-4 shrink-0 text-[#777] group-hover:text-black" />
      </Link>)}
    </div> : <div className="py-14 text-center text-sm text-[#777]">这里还没有自由提问记录。</div>}
    {page.hasMore && page.nextCursor && <div className="mt-6 flex justify-center"><Link href={`/free/history?cursor=${encodeURIComponent(page.nextCursor)}`} className="paper-button">查看更早的交流 <ArrowRight className="h-4 w-4" /></Link></div>}
  </main></div>;
}
