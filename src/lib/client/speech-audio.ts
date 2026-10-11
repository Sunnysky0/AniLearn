"use client";

import { useCallback, useRef } from "react";
import type { TTSRequest } from "@/lib/types";

const BROWSER_TTS_TIMEOUT_MS = 15_000;

export interface SpeechClip extends TTSRequest {
  key: string;
}

export type SpeechAudioResult =
  | { status: "ready"; url: string }
  | { status: "error"; error: Error }
  | { status: "cancelled" };

type AudioEntry = {
  status: "pending" | "ready" | "error";
  controller: AbortController;
  promise: Promise<SpeechAudioResult>;
  url?: string;
};

export class SpeechAudioController {
  private enabled = true;
  private disposed = false;
  private entries = new Map<string, AudioEntry>();
  private clips = new Map<string, string>();
  private queued = new Map<string, { clip: SpeechClip; signal?: AbortSignal }>();

  prefetch(clip: SpeechClip, signal?: AbortSignal) {
    if (this.disposed || signal?.aborted) return;
    this.queued.set(clip.key, { clip, signal });
    if (this.enabled) void this.load(clip, signal);
  }

  forget(key: string) {
    this.queued.delete(key);
  }

  async acquire(clip: SpeechClip, signal?: AbortSignal): Promise<SpeechAudioResult> {
    this.queued.delete(clip.key);
    if (this.disposed || !this.enabled || signal?.aborted) return { status: "cancelled" };
    const promise = this.load(clip, signal);
    if (!signal) return promise;
    return new Promise((resolve) => {
      const aborted = () => resolve({ status: "cancelled" });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      void promise.then((result) => {
        signal.removeEventListener("abort", aborted);
        resolve(signal.aborted ? { status: "cancelled" } : result);
      });
    });
  }

  setEnabled(enabled: boolean) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const [key, entry] of this.entries) {
        if (entry.status === "pending") {
          entry.controller.abort();
          this.removeEntry(key, entry);
        }
      }
      return;
    }
    for (const [key, pending] of this.queued) {
      if (pending.signal?.aborted) this.queued.delete(key);
      else void this.load(pending.clip, pending.signal);
    }
  }

  cancelPending() {
    this.queued.clear();
    for (const [key, entry] of this.entries) {
      if (entry.status !== "ready") {
        entry.controller.abort();
        this.removeEntry(key, entry);
      }
    }
  }

  retryFailed(key: string) {
    const cacheKey = this.clips.get(key);
    const entry = cacheKey ? this.entries.get(cacheKey) : undefined;
    if (cacheKey && entry?.status === "error") this.removeEntry(cacheKey, entry);
  }

  release(key: string) {
    this.queued.delete(key);
    const cacheKey = this.clips.get(key);
    this.clips.delete(key);
    if (!cacheKey || [...this.clips.values()].includes(cacheKey)) return;
    const entry = this.entries.get(cacheKey);
    if (!entry) return;
    entry.controller.abort();
    this.removeEntry(cacheKey, entry);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queued.clear();
    for (const [key, entry] of this.entries) {
      entry.controller.abort();
      this.removeEntry(key, entry);
    }
    this.clips.clear();
  }

  private removeEntry(key: string, entry: AudioEntry) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    for (const [clipKey, cacheKey] of this.clips) {
      if (cacheKey === key) this.clips.delete(clipKey);
    }
    if (entry.url) URL.revokeObjectURL(entry.url);
  }

  private load(clip: SpeechClip, sourceSignal?: AbortSignal): Promise<SpeechAudioResult> {
    if (this.disposed || !this.enabled || sourceSignal?.aborted) return Promise.resolve({ status: "cancelled" });
    // Normal messages with the same voice and script share one request.
    // Fresh previews use their unique operation key to bypass completed cache entries.
    const cacheKey = JSON.stringify([clip.voiceId ?? "", clip.text, clip.fresh ? clip.key : null]);
    const oldCacheKey = this.clips.get(clip.key);
    if (oldCacheKey && oldCacheKey !== cacheKey) this.release(clip.key);
    this.clips.set(clip.key, cacheKey);
    const cached = this.entries.get(cacheKey);
    if (cached) return cached.promise;

    const controller = new AbortController();
    const requestSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(BROWSER_TTS_TIMEOUT_MS),
      ...(sourceSignal ? [sourceSignal] : []),
    ]);
    const entry: AudioEntry = {
      status: "pending",
      controller,
      promise: Promise.resolve({ status: "cancelled" }),
    };
    this.entries.set(cacheKey, entry);
    entry.promise = (async (): Promise<SpeechAudioResult> => {
      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: clip.text,
            ...(clip.voiceId ? { voiceId: clip.voiceId } : {}),
            ...(clip.fresh ? { fresh: true } : {}),
          }),
          signal: requestSignal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error || "语音合成失败 (" + response.status + ")");
        }
        const blob = await response.blob();
        if (requestSignal.aborted) throw requestSignal.reason;
        if (this.disposed || this.entries.get(cacheKey) !== entry) return { status: "cancelled" };
        entry.url = URL.createObjectURL(blob);
        entry.status = "ready";
        return { status: "ready", url: entry.url };
      } catch (cause) {
        if (this.disposed || controller.signal.aborted || sourceSignal?.aborted || this.entries.get(cacheKey) !== entry) {
          this.removeEntry(cacheKey, entry);
          return { status: "cancelled" };
        }
        entry.status = "error";
        return { status: "error", error: cause instanceof Error ? cause : new Error("语音合成失败") };
      }
    })();
    return entry.promise;
  }
}

export function useSpeechAudioController() {
  const controllerRef = useRef<SpeechAudioController | null>(null);
  const getController = useCallback(() => {
    if (!controllerRef.current) controllerRef.current = new SpeechAudioController();
    return controllerRef.current;
  }, []);
  return { controllerRef, getController };
}
