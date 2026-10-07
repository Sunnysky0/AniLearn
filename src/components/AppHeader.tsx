"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload } from "lucide-react";

export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path d="M24 2.5 42.6 13.25v21.5L24 45.5 5.4 34.75v-21.5Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M13.5 31.8c3.7-1.7 7.2-1.7 10.5.4 3.3-2.1 6.8-2.1 10.5-.4V17.1c-3.7-1.7-7.2-1.7-10.5.4-3.3-2.1-6.8-2.1-10.5-.4Z"
        fill="currentColor"
      />
      <path d="M24 17.5v14.7" stroke="var(--paper, #fafafa)" strokeWidth="1.6" />
      <path d="M16.5 21.5h4.5M16.5 25h4.5M27 21.5h4.5M27 25h4.5" stroke="var(--paper, #fafafa)" strokeWidth="1.3" />
    </svg>
  );
}

const NAV = [
  { href: "/", label: "首页" },
  { href: "/papers", label: "试卷库" },
  { href: "/tutors", label: "我的导师" },
  { href: "/settings", label: "设置" },
];

export function AppHeader() {
  const pathname = usePathname() ?? "/";
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-40 border-b-2 border-black bg-[#fafafa] text-[#171717]">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Logo className="h-8 w-8" />
          <div className="leading-tight">
            <div className="font-serif text-xl font-bold">AniLearn</div>
            <div className="text-[10px] text-[#626262]">你的专属 AI 导师</div>
          </div>
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`border-b-2 px-3.5 py-2 text-sm transition ${
                active(n.href)
                  ? "border-black font-semibold"
                  : "border-transparent text-[#626262] hover:border-[#626262] hover:text-black"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/papers/new" className="ink-button px-4 py-2 text-sm">
            <Upload className="h-4 w-4" />
            上传试卷
          </Link>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-[#c8c8c8] px-4 pb-2 pt-2 text-sm md:hidden">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`whitespace-nowrap border-b-2 px-3 py-1.5 ${active(n.href) ? "border-black font-semibold" : "border-transparent text-[#626262]"}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
