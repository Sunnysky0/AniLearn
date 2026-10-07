import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { FileUp } from "lucide-react";
import { db } from "@/db";
import { papers, problems } from "@/db/schema";
import { AppHeader } from "@/components/AppHeader";
import { PaperCard } from "@/components/PaperCard";
import { paperPageMimes, toPaperDTO } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function PapersPage() {
  const rows = await db
    .select({
      paper: papers,
      pageMimes: paperPageMimes(),
      total: sql<number>`(select count(*)::int from ${problems} where ${problems.paperId} = ${papers.id})`,
    })
    .from(papers)
    .orderBy(desc(papers.createdAt));

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[32px] font-bold text-neutral-900">试卷库</h1>
            <p className="mt-2 text-sm text-neutral-600">{rows.length} 份试卷</p>
          </div>
          <Link
            href="/papers/new"
            className="inline-flex items-center gap-2 bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
          >
            <FileUp className="h-4 w-4" /> 上传新试卷
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            href="/papers/new"
            className="flex min-h-[230px] flex-col items-center justify-center border-2 border-dashed border-neutral-300 bg-white/60 text-neutral-500 transition hover:border-neutral-900 hover:text-neutral-800"
          >
            <FileUp className="h-9 w-9" />
            <div className="mt-3 font-semibold">上传试卷</div>
            <div className="mt-1 text-xs">图片 / PDF / .md / .tex</div>
          </Link>
          {rows.map((r) => (
            <PaperCard key={r.paper.id} paper={toPaperDTO(r.paper, r.pageMimes)} problemCount={Number(r.total)} />
          ))}
        </div>
      </main>
    </div>
  );
}
