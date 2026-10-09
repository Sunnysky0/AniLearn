import Link from "next/link";
import { FileText } from "lucide-react";
import type { PaperDTO } from "@/lib/types";
import { formatDate } from "@/lib/text";
import { PaperPageThumbnail } from "@/components/PaperPageThumbnail";

export const PAPER_STATUS: Record<string, { label: string; cls: string }> = {
  uploaded: { label: "待解析", cls: "bg-neutral-100 text-neutral-600" },
  analyzing: { label: "解析中", cls: "bg-neutral-100 text-neutral-800" },
  ready: { label: "就绪", cls: "bg-neutral-100 text-neutral-800" },
  failed: { label: "解析失败", cls: "bg-neutral-100 text-neutral-800" },
};

export function PaperCard({ paper, problemCount }: { paper: PaperDTO; problemCount: number }) {
  const st = PAPER_STATUS[paper.status] ?? PAPER_STATUS.uploaded;
  return (
    <Link
      href={`/papers/${paper.id}`}
      className="group overflow-hidden border border-neutral-300 bg-white transition hover:border-neutral-900"
    >
      <div className="relative h-40 overflow-hidden bg-neutral-100">
        {paper.pageCount > 0 ? (
          <PaperPageThumbnail
            src={`/api/papers/${paper.id}/pages/0`}
            mime={paper.pageMimes?.[0]}
            alt=""
            className="h-full w-full object-cover object-top transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-300">
            <FileText className="h-10 w-10" />
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2 text-xs text-neutral-600">
          <span className={`border border-neutral-300 px-2 py-0.5 ${st.cls}`}>{st.label}</span>
          <span>{formatDate(paper.createdAt).slice(5)}</span>
        </div>
        <h3 className="line-clamp-2 text-lg font-semibold text-neutral-900">{paper.title}</h3>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500">
          <span className="bg-neutral-100 px-1.5 py-0.5 text-neutral-800">{paper.subject}</span>
          <span>{paper.pageCount} 页</span>
          <span>·</span>
          <span>已解析 {problemCount} / {paper.inventory?.items.length ?? problemCount} 题</span>
        </div>
      </div>
    </Link>
  );
}
