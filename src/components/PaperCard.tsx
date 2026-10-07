import Link from "next/link";
import { FileText } from "lucide-react";
import type { PaperDTO } from "@/lib/types";
import { formatDate } from "@/lib/text";

export const PAPER_STATUS: Record<string, { label: string; cls: string }> = {
  uploaded: { label: "待解析", cls: "bg-slate-100 text-slate-600" },
  analyzing: { label: "解析中", cls: "bg-amber-100 text-amber-700" },
  ready: { label: "已解析", cls: "bg-emerald-100 text-emerald-700" },
  failed: { label: "解析失败", cls: "bg-rose-100 text-rose-700" },
};

export function PaperCard({ paper, problemCount }: { paper: PaperDTO; problemCount: number }) {
  const st = PAPER_STATUS[paper.status] ?? PAPER_STATUS.uploaded;
  return (
    <Link
      href={`/papers/${paper.id}`}
      className="group overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div className="relative h-40 overflow-hidden bg-slate-100">
        {paper.pageCount > 0 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/papers/${paper.id}/pages/0`}
            alt=""
            className="h-full w-full object-cover object-top transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-300">
            <FileText className="h-10 w-10" />
          </div>
        )}
        <span className={`absolute left-3 top-3 rounded-full px-2.5 py-0.5 text-xs font-medium shadow-sm ${st.cls}`}>
          {st.label}
        </span>
      </div>
      <div className="p-4">
        <div className="line-clamp-1 font-semibold text-slate-800">{paper.title}</div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600">{paper.subject}</span>
          <span>{paper.pageCount} 页</span>
          <span>·</span>
          <span>{problemCount} 题</span>
          <span className="ml-auto">{formatDate(paper.createdAt).slice(5)}</span>
        </div>
      </div>
    </Link>
  );
}
