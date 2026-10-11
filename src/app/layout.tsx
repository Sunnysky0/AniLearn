import type { Metadata } from "next";
import type { ReactNode } from "react";
import "katex/dist/katex.min.css";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "./globals.css";

export const metadata: Metadata = {
  title: "AniLearn · AI 一对一学习导师",
  description:
    "AniLearn：试卷学习、外刊导读与自由提问，一对一 AI 导师配有中文讲解、日语语音与板书。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
