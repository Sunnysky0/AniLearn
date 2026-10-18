"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BookReaderStateDTO, ReaderDocument, ReaderPosition } from "@/lib/book-types";
import { validateReaderPosition } from "@/lib/reader/anchors";
import { pendingReadingPositions, ReadingProgressController, type ReadingProgressView } from "./reading-progress";

/** One version writer survives every chapter change and temporary inspection. */
export function useBookProgress(initialDocument: ReaderDocument, sessionId: number, initial: BookReaderStateDTO) {
  const documents = useRef(new Map([[initialDocument.unitId, initialDocument]]));
  const chapterPositions = useRef({ ...initial.chapterPositions });
  const controller = useRef<ReadingProgressController | null>(null);
  const [view, setView] = useState<ReadingProgressView>({ position: initial.position, status: "saved", error: "" });
  const [entryPosition, setEntryPosition] = useState(initial.position);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadDocument = useCallback(async (unitId: string) => {
    const cached = documents.current.get(unitId); if (cached) return cached;
    if (!initialDocument.units.some(unit => unit.id === unitId)) throw new Error("章节不存在。");
    const response = await fetch(`/api/book-sessions/${sessionId}?chapterId=${encodeURIComponent(unitId)}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.document?.key !== initialDocument.key || data.document?.unitId !== unitId) throw new Error(data.error || "无法恢复章节，请重试。");
    documents.current.set(unitId, data.document); return data.document as ReaderDocument;
  }, [initialDocument, sessionId]);
  const validate = useCallback((value: unknown) => {
    const unitId = value && typeof value === "object" && "unitId" in value ? value.unitId : null;
    const document = typeof unitId === "string" ? documents.current.get(unitId) : null;
    return document ? validateReaderPosition(document, value) : null;
  }, []);
  useEffect(() => {
    let active = true; let writer: ReadingProgressController | null = null;
    let storage: Storage | null = null; let ownerId: string | undefined;
    try { storage = window.localStorage; } catch { /* In-memory reading still works. */ }
    try {
      ownerId = window.sessionStorage.getItem("anilearn:reader-tab") ?? crypto.randomUUID();
      window.sessionStorage.setItem("anilearn:reader-tab", ownerId);
    } catch { /* The writer generates an identity when unavailable. */ }
    const storageKey = `anilearn:book-progress:${initial.documentKey}`;
    const setup = async () => {
      try {
        const positions = [initial.position, ...pendingReadingPositions(storage, storageKey, ownerId)];
        for (const position of positions) {
          if (position?.documentKey === initial.documentKey && initialDocument.units.some(unit => unit.id === position.unitId)) await loadDocument(position.unitId);
        }
        if (!active) return;
        writer = new ReadingProgressController({ document: initialDocument, initial, storage, storageKey, ownerId, validatePosition: validate, preserveUnits: true,
          url: `/api/book-sessions/${sessionId}/reader-state`, changed: setView });
        controller.current = writer;
        for (const position of positions) {
          const valid = validate(position); if (valid) chapterPositions.current[valid.unitId] = valid;
        }
        const restored = writer.snapshot();
        if (restored.position) chapterPositions.current[restored.position.unitId] = restored.position;
        setEntryPosition(restored.position); setView(restored); setReady(true);
        if (restored.status === "saving") void writer.flush();
      } catch (cause) {
        if (active) setView(previous => ({ ...previous, status: "failed", error: cause instanceof Error ? cause.message : "续读恢复失败，请重试。" }));
      }
    };
    void setup();
    const hidden = () => { if (window.document.visibilityState === "hidden") void writer?.flush(true); };
    const pagehide = () => { void writer?.flush(true); };
    window.document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    return () => {
      active = false; writer?.detach(); if (controller.current === writer) controller.current = null;
      window.document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide);
    };
  }, [initial, initialDocument, sessionId, attempt, loadDocument, validate]);
  const update = useCallback((position: ReaderPosition) => {
    const valid = validate(position); if (!valid) return;
    chapterPositions.current[valid.unitId] = valid; controller.current?.update(valid);
  }, [validate]);
  const flush = useCallback(() => controller.current?.flush() ?? Promise.resolve(false), []);
  const retry = useCallback(() => {
    if (!controller.current) { setAttempt(value => value + 1); return Promise.resolve(false); }
    return controller.current.retry();
  }, []);
  return { ...view, ready, entryPosition, chapterPositions, documents, loadDocument, update, flush, retry };
}
