import Link from "next/link";
import { desc } from "drizzle-orm";
import { Plus, BookOpen } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { db } from "@/db";
import { readings } from "@/db/schema";
export const dynamic = "force-dynamic";
const labels: Record<string, string> = { uploaded: "待识别", analyzing: "识别中", review: "待校对", ready: "可开始阅读", failed: "识别失败" };
export default async function ReadingsPage() {
  const rows = await db.select().from(readings).orderBy(desc(readings.createdAt));
  return <div className="min-h-screen"><AppHeader /><main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-[32px] font-bold">外刊导读</h1><Link href="/readings/new" className="ink-button px-4 py-2"><Plus className="h-4 w-4" />上传外刊</Link></div>
    <div className="mt-8 divide-y divide-neutral-300 border-t-2 border-neutral-900">{rows.map((r) => <Link key={r.id} href={`/readings/${r.id}`} className="flex items-center gap-4 py-5 hover:bg-neutral-100">
      <BookOpen className="h-6 w-6 shrink-0" /><div className="min-w-0 flex-1"><h2 className="break-words text-lg font-semibold">{r.title}</h2><div className="mt-1 text-sm text-neutral-500">{r.language === "ja" ? "日语" : "英语"} · {r.paragraphs.length} 段</div></div><span className="shrink-0 text-sm">{labels[r.status] ?? r.status}</span>
    </Link>)}{!rows.length && <p className="py-12 text-neutral-500">暂无外刊材料</p>}</div>
  </main></div>;
}
