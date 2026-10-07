import type { Metadata } from "next";
import type { ReactNode } from "react";
import "katex/dist/katex.min.css";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "./globals.css";

export const metadata: Metadata = {
  title: "AniLearn · 试卷驱动的 AI 一对一导师",
  description:
    "AniLearn：上传试卷，AI 导师全面解析考点与教材知识点，逐题一对一讲解，配有真人语音与板书。专为高考设计。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
