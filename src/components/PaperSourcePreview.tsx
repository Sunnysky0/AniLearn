"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { decodePaperText, paperTextFormat } from "@/lib/paper-source";

export function PaperSourcePreview({ src, mime, page, onClose }: {
  src: string;
  mime?: string;
  page: number;
  onClose: () => void;
}) {
  const format = paperTextFormat(mime ?? "");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (format) {
      void fetch(src, { signal: controller.signal }).then(async (res) => {
        if (!res.ok) throw new Error("无法加载试卷原文，请重试。");
        const content = decodePaperText(new Uint8Array(await res.arrayBuffer()));
        if (!controller.signal.aborted) setText(content);
      }).catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    }
    return () => controller.abort();
  }, [src, format]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/80 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`第 ${page} 页原文`} className="flex max-h-[92vh] w-full max-w-4xl flex-col bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
          <span className="text-sm font-semibold">第 {page} 页{format ? ` · ${format}` : ""}</span>
          <button autoFocus onClick={onClose} title="关闭预览" aria-label="关闭预览" className="p-1.5 text-neutral-500 hover:bg-neutral-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="min-h-0 overflow-auto p-4 sm:p-6">
          {format ? (
            error ? <p className="text-sm text-neutral-700">{error}</p> : text === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /> 正在读取原文</div>
            ) : format === "Markdown" ? (
              <Markdown content={text} className="md break-words" />
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-sm leading-relaxed text-neutral-800">{text}</pre>
            )
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={`第 ${page} 页`} className="mx-auto max-w-full" />
          )}
        </div>
      </div>
    </div>
  );
}
