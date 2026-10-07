import Link from "next/link";
import { Mic, Pencil, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { listTutors } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function TutorsPage() {
  const list = await listTutors();
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[32px] font-bold text-neutral-900">我的导师</h1>
            <p className="mt-2 text-sm text-neutral-600">{list.length} 位导师</p>
          </div>
          <Link
            href="/tutors/new"
            className="inline-flex items-center gap-2 bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> 创建新导师
          </Link>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((t) => (
            <div key={t.id} className="group border-t-2 border-neutral-900 py-6">
              <div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.avatar} alt={t.name} className="h-28 w-28 border border-neutral-300 object-cover" />
                <div className="mt-3 flex items-center gap-2">
                  <h2 className="text-2xl font-semibold text-neutral-900">{t.name}</h2>
                  {t.isPreset && <span className="bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">预设</span>}
                </div>
                <div className="mt-0.5 text-sm text-neutral-800">{t.tags.join(" | ")}</div>
                <p className="mt-3 min-h-10 text-sm leading-relaxed text-neutral-600">{t.tagline}</p>
                <div className="mt-4 space-y-2 border-t border-neutral-300 pt-4 text-sm text-neutral-600">
                  <div className="line-clamp-1">
                    <span className="font-semibold text-neutral-600">性格：</span>
                    {t.personality}
                  </div>
                  <div className="line-clamp-1">
                    <span className="font-semibold text-neutral-600">风格：</span>
                    {t.teachingStyle}
                  </div>
                  <div className="flex items-center gap-1">
                    <Mic className="h-3 w-3" /> {t.voiceName || "自定义声音"} · {t.voiceStyle || "默认语气"}
                  </div>
                </div>
                <Link href={`/tutors/${t.id}`} className="paper-button mt-5 text-sm">
                  <Pencil className="h-4 w-4" /> 编辑导师
                </Link>
              </div>
            </div>
          ))}
          <Link
            href="/tutors/new"
            className="flex min-h-[320px] flex-col items-center justify-center border-2 border-dashed border-neutral-300 bg-white/60 text-neutral-500 transition hover:border-neutral-900 hover:text-neutral-800"
          >
            <Plus className="h-10 w-10" />
            <div className="mt-3 font-semibold">创建新导师</div>
            <div className="mt-1 text-xs">自定义形象、性格、教学风格、声音</div>
          </Link>
        </div>
      </main>
    </div>
  );
}
