"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";

export function StartFreeSession({ tutorId, label = "开始提问", className = "ink-button" }: { tutorId: number; label?: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef<string | null>(null);
  const start = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      requestIdRef.current ??= crypto.randomUUID();
      const response = await fetch("/api/free-sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tutorId, requestId: requestIdRef.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法创建自由提问课堂。");
      router.push(`/free-classroom/${data.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建自由提问课堂。");
      setBusy(false);
    }
  };
  return <div className="flex flex-col items-start gap-1">
    <button type="button" onClick={() => void start()} disabled={busy} className={`${className} disabled:cursor-wait disabled:opacity-60`}>
      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{busy ? "正在进入…" : label}
    </button>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}
