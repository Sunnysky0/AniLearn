"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload } from "lucide-react";

export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <defs>
        <linearGradient id="anilearn-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="0.55" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <path
        d="M24 2.5 42.6 13.25v21.5L24 45.5 5.4 34.75v-21.5Z"
        fill="url(#anilearn-logo)"
        stroke="#dbeafe"
        strokeOpacity=".55"
        strokeWidth="1.2"
      />
      <path
        d="M13.5 31.8c3.7-1.7 7.2-1.7 10.5.4 3.3-2.1 6.8-2.1 10.5-.4V17.1c-3.7-1.7-7.2-1.7-10.5.4-3.3-2.1-6.8-2.1-10.5-.4Z"
        fill="#fff"
        fillOpacity=".96"
      />
      <path d="M24 17.5v14.7" stroke="#2563eb" strokeWidth="1.6" />
      <path d="M16.5 21.5h4.5M16.5 25h4.5M27 21.5h4.5M27 25h4.5" stroke="#93c5fd" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M36 8.2l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1Z" fill="#fde68a" />
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
    <header className="sticky top-0 z-40 bg-gradient-to-r from-[#10204a] via-[#1a3166] to-[#10204a] text-white shadow-lg shadow-blue-950/20">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Logo className="h-9 w-9" />
          <div className="leading-tight">
            <div className="text-lg font-bold tracking-wide">AniLearn</div>
            <div className="text-[10px] tracking-[0.2em] text-blue-200/80">你的专属AI导师</div>
          </div>
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3.5 py-2 transition ${
                active(n.href) ? "bg-white/15 text-white" : "text-blue-100/80 hover:bg-white/10 hover:text-white"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/papers/new"
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-400 to-blue-500 px-4 py-2 text-sm font-semibold shadow-md shadow-blue-900/30 transition hover:brightness-110"
          >
            <Upload className="h-4 w-4" />
            上传试卷
          </Link>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-4 pb-2 text-sm md:hidden">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 ${active(n.href) ? "bg-white/15" : "text-blue-100/80"}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
