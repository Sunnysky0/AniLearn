"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import type { ReadingBookmarkDTO, ReadingReaderStateDTO } from "@/lib/types";
import { ReadingProgressController, type ReadingProgressView } from "./reading-progress";

export function useReadingProgress(document: ReaderDocument, sessionId: number, initial: ReadingReaderStateDTO) {
  const controller = useRef<ReadingProgressController | null>(null);
  const [view, setView] = useState<ReadingProgressView>({ position: initial.position, status: "saved", error: "" });
  const [ready, setReady] = useState(false);
  const [entryPosition, setEntryPosition] = useState(initial.position);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* Reading also works with disabled storage. */ }
    let ownerId: string | undefined;
    try {
      ownerId = window.sessionStorage.getItem("anilearn:reader-tab") ?? crypto.randomUUID();
      window.sessionStorage.setItem("anilearn:reader-tab", ownerId);
    } catch { /* Without session storage the controller creates a fresh identity. */ }
    const writer = new ReadingProgressController({ document, initial, url: `/api/reading-sessions/${sessionId}/reader-state`, storage, ownerId, changed: setView });
    controller.current = writer;
    const frame = requestAnimationFrame(() => {
      const restored = writer.snapshot();
      setEntryPosition(restored.position); setView(restored); setReady(true);
      if (restored.status === "saving") void writer.flush();
    });
    const hidden = () => { if (window.document.visibilityState === "hidden") void writer.flush(true); };
    const pagehide = () => { void writer.flush(true); };
    window.document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    return () => {
      cancelAnimationFrame(frame);
      window.document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide);
      writer.detach(); if (controller.current === writer) controller.current = null;
    };
  }, [document, initial, sessionId]);
  const update = useCallback((position: ReaderPosition) => controller.current?.update(position), []);
  const flush = useCallback(() => controller.current?.flush() ?? Promise.resolve(true), []);
  const retry = useCallback(() => controller.current?.retry() ?? Promise.resolve(false), []);
  return { ...view, ready, entryPosition, update, flush, retry };
}

export function useReadingBookmarks(sessionId: number, initial: ReadingBookmarkDTO[]) {
  const [bookmarks, setBookmarks] = useState(initial);
  const pending = useRef(new Map<string, string>());
  const base = `/api/reading-sessions/${sessionId}/bookmarks`;
  const request = useCallback(async (url: string, method: string, body: unknown) => {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409 || response.status === 404) {
        const refresh = await fetch(base, { cache: "no-store" });
        if (refresh.ok) setBookmarks(await refresh.json());
      }
      throw new Error(data.error || "书签保存失败，请重试。");
    }
    return data;
  }, [base]);
  const create = useCallback(async (position: ReaderPosition) => {
    const key = `${position.blockId}:${position.offset}`;
    const clientId = pending.current.get(key) ?? crypto.randomUUID(); pending.current.set(key, clientId);
    const saved = await request(base, "POST", { clientId, position }) as ReadingBookmarkDTO;
    pending.current.delete(key);
    setBookmarks(all => [...all.filter(item => item.id !== saved.id), saved].sort((a, b) => a.id - b.id));
  }, [base, request]);
  const rename = useCallback(async (bookmark: ReadingBookmarkDTO, title: string) => {
    const saved = await request(`${base}/${bookmark.id}`, "PATCH", { title, revision: bookmark.revision }) as ReadingBookmarkDTO;
    setBookmarks(all => all.map(item => item.id === saved.id ? saved : item));
  }, [base, request]);
  const remove = useCallback(async (bookmark: ReadingBookmarkDTO) => {
    await request(`${base}/${bookmark.id}`, "DELETE", { revision: bookmark.revision });
    setBookmarks(all => all.filter(item => item.id !== bookmark.id));
  }, [base, request]);
  return { bookmarks, create, rename, remove };
}
