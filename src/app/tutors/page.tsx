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
            <h1 className="text-2xl font-bold text-slate-900">我的导师</h1>
            <p className="mt-1 text-sm text-slate-500">定制导师的形象、性格、教学风格与声音，打造只属于你的一对一老师。</p>
          </div>
          <Link
            href="/tutors/new"
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-500/30 hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> 创建新导师
          </Link>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((t) => (
            <div key={t.id} className="group relative overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-xl">
              <div className="h-24 bg-gradient-to-r from-[#13254d] via-[#1d3a7a] to-[#2563eb]" />
              <div className="-mt-12 px-6 pb-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.avatar} alt={t.name} className="h-24 w-24 rounded-full object-cover ring-4 ring-white shadow-lg" />
                <div className="mt-3 flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">AI导师 · {t.name}</h2>
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  {t.isPreset && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">预设</span>}
                </div>
                <div className="mt-0.5 text-sm text-blue-600">{t.tags.join(" | ")}</div>
                <p className="mt-2 line-clamp-2 text-sm text-slate-500">{t.tagline}</p>
                <div className="mt-3 space-y-1 text-xs text-slate-500">
                  <div className="line-clamp-1">
                    <span className="font-semibold text-slate-600">性格：</span>
                    {t.personality}
                  </div>
                  <div className="line-clamp-1">
                    <span className="font-semibold text-slate-600">风格：</span>
                    {t.teachingStyle}
                  </div>
                  <div className="flex items-center gap-1">
                    <Mic className="h-3 w-3" /> {t.voiceName || "自定义声音"} · {t.voiceStyle || "默认语气"}
                  </div>
                </div>
                <Link
                  href={`/tutors/${t.id}`}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition group-hover:bg-blue-600 group-hover:text-white"
                >
                  <Pencil className="h-4 w-4" /> 编辑导师
                </Link>
              </div>
            </div>
          ))}
          <Link
            href="/tutors/new"
            className="flex min-h-[320px] flex-col items-center justify-center rounded-3xl border-2 border-dashed border-slate-300 bg-white/60 text-slate-500 transition hover:border-blue-400 hover:text-blue-600"
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
