import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, BookOpen, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { listBooks } from "@/lib/server/book-catalog";
import { SchemaNotReadyError } from "@/lib/server/schema-readiness";

export const dynamic = "force-dynamic";
const labels: Record<string, string> = { uploaded: "待整理", importing: "整理中", review: "待校对目录", ready: "开始阅读", failed: "可续接导入" };
export default async function BooksPage() {
  const books = await listBooks().catch(error => {
    if (error instanceof SchemaNotReadyError) return null;
    throw error;
  });
  if (!books) return <div className="min-h-screen"><AppHeader /><main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
    <div className="border-b-2 border-neutral-900 pb-6"><h1 className="text-[32px] font-bold">数据库需要升级</h1><p className="mt-3 text-sm leading-7 text-neutral-600">请先完成数据库升级，再刷新典籍书架。已有课堂和阅读记录会保留。</p><Link href="/" className="mt-5 inline-block text-sm underline">返回首页</Link></div>
  </main></div>;
  return <div className="min-h-screen"><AppHeader /><main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
    <div className="flex flex-wrap items-end justify-between gap-5 border-b-2 border-neutral-900 pb-6">
      <div><p className="mb-3 text-xs tracking-[.18em] text-neutral-500">READ · THINK · RETURN</p><h1 className="text-[32px] font-bold">典籍导读</h1><p className="mt-3 text-sm leading-7 text-neutral-600">从一章开始。安静地读，随时提问，再与导师一起梳理。</p></div>
      <Link href="/books/new" className="ink-button px-4 py-2 text-sm"><Plus className="h-4 w-4" />导入典籍</Link>
    </div>
    <div className="divide-y divide-neutral-300">{books.map(book => <Link key={book.id} href={`/books/${book.id}`} className="group grid grid-cols-[64px_1fr_auto] items-center gap-4 py-7 sm:grid-cols-[92px_1fr_auto] sm:gap-7">
      <div className="flex aspect-[2/3] items-center justify-center bg-neutral-100">{book.coverUrl ? <Image src={book.coverUrl} alt={book.title} width={92} height={138} unoptimized className="h-full w-full object-contain" /> : <BookOpen className="h-7 w-7 text-neutral-500" />}</div>
      <div className="min-w-0"><p className="mb-2 text-xs text-neutral-500">{book.builtinKey ? "内置典籍 · " : ""}{book.language === "zh" ? "中文" : book.language === "ja" ? "日文" : "英文"} · {book.kind === "thought" ? "思想论说" : book.kind === "classical" ? "文言典籍" : "文学作品"}</p><h2 className="break-words font-serif text-xl font-semibold sm:text-2xl">{book.title}</h2><p className="mt-3 text-sm text-neutral-600">{book.author || "作者未注明"}</p></div>
      <span className="flex items-center gap-2 self-end text-xs sm:self-center sm:text-sm">{labels[book.status]}<ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></span>
    </Link>)}</div>
  </main></div>;
}
