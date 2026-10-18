import type { ReaderDocument, ReaderPosition } from "@/lib/book-types";
import type { ReadingPositionMutation, ReadingReaderStateDTO } from "@/lib/types";
import { validateReaderPosition } from "@/lib/reader/anchors";

type Pending = { documentKey: string; revision: number; inFlight: ReadingPositionMutation | null; latest: ReaderPosition; updatedAt?: number };
type Cache = { version: 1; entries: Record<string, Pending> };
export type ReadingSaveStatus = "saved" | "saving" | "failed" | "conflict";
export interface ReadingProgressView { position: ReaderPosition | null; status: ReadingSaveStatus; error: string }
interface Options {
  document: ReaderDocument; initial: ReadingReaderStateDTO; url: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  fetcher?: typeof fetch; id?: () => string;
  changed?: (view: ReadingProgressView) => void;
  delay?: (ms: number) => Promise<void>;
  ownerId?: string;
}
export function equalReadingPosition(a: ReaderPosition | null, b: ReaderPosition | null): boolean {
  return a === b || !!a && !!b && a.documentKey === b.documentKey && a.unitId === b.unitId && a.blockId === b.blockId && a.offset === b.offset && a.viewportOffset === b.viewportOffset;
}

/** One writer per mounted classroom. Persist intent before I/O and reuse its
 * mutation ID after ambiguous responses; a server revision is never rebased
 * automatically across another window's write. */
export class ReadingProgressController {
  readonly storageKey: string;
  private revision: number;
  private inFlight: ReadingPositionMutation | null = null;
  private latest: ReaderPosition | null = null;
  private view: ReadingProgressView;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive = false;
  private detached = false;
  private fetcher: typeof fetch;
  private id: () => string;
  private delay: (ms: number) => Promise<void>;
  private ownerId: string;
  private adopted: { id: string; value: string } | null = null;

  constructor(private options: Options) {
    this.storageKey = `anilearn:reading-progress:${options.document.key}`;
    this.revision = options.initial.revision;
    this.view = { position: validateReaderPosition(options.document, options.initial.position), status: "saved", error: "" };
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.id = options.id ?? (() => crypto.randomUUID());
    this.ownerId = options.ownerId ?? this.id();
    this.delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.restore();
  }
  private cache(): Cache {
    try {
      const value = JSON.parse(this.options.storage?.getItem(this.storageKey) ?? "null");
      if (value?.version === 1 && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries)) return value;
      return { version: 1, entries: value?.documentKey ? { legacy: value } : {} };
    } catch { return { version: 1, entries: {} }; }
  }
  snapshot(): ReadingProgressView { return { ...this.view }; }
  private publish(status: ReadingSaveStatus, error = "") {
    this.view = { ...this.view, status, error };
    if (!this.detached) this.options.changed?.(this.snapshot());
  }
  private restore() {
    try {
      const entries = Object.entries(this.cache().entries);
      const selected = entries.find(([id]) => id === this.ownerId) ?? entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))[0];
      const raw = selected?.[1];
      if (!raw || raw.documentKey !== this.options.document.key || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return;
      const position = validateReaderPosition(this.options.document, raw.latest); if (!position) return;
      const flight = raw.inFlight;
      if (flight && (!validateReaderPosition(this.options.document, flight.position) || flight.revision !== raw.revision ||
        typeof flight.mutationId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(flight.mutationId))) return;
      if (selected[0] !== this.ownerId) this.adopted = { id: selected[0], value: JSON.stringify(raw) };
      this.latest = position; this.view.position = position;
      if (flight && this.options.initial.mutationId === flight.mutationId) {
        if (equalReadingPosition(position, this.options.initial.position)) this.latest = null;
      } else {
        this.inFlight = flight;
        if (raw.revision !== this.revision) this.view = { ...this.view, status: "conflict", error: "阅读位置已在其他窗口更新，本地位置已保留。" };
      }
      if (this.latest && this.view.status !== "conflict") this.view.status = "saving";
      this.persist();
    } catch { /* An unavailable or malformed cache must not prevent reading. */ }
  }
  private persist() {
    try {
      const cache = this.cache();
      if (this.adopted) {
        if (JSON.stringify(cache.entries[this.adopted.id]) === this.adopted.value) delete cache.entries[this.adopted.id];
        this.adopted = null;
      }
      if (!this.latest) delete cache.entries[this.ownerId];
      else cache.entries[this.ownerId] = { documentKey: this.options.document.key,
        revision: this.revision, inFlight: this.inFlight, latest: this.latest, updatedAt: Date.now() } satisfies Pending;
      if (Object.keys(cache.entries).length) this.options.storage?.setItem(this.storageKey, JSON.stringify(cache));
      else this.options.storage?.removeItem(this.storageKey);
    } catch { /* Keep the pending position in memory even if storage is full. */ }
  }
  update(position: ReaderPosition) {
    const valid = validateReaderPosition(this.options.document, position); if (!valid) return;
    if (!this.detached) this.keepalive = false;
    this.latest = valid; this.view.position = valid; this.persist();
    if (this.view.status === "conflict") { this.publish("conflict", this.view.error); return; }
    this.publish("saving");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 350);
  }
  async flush(keepalive = false): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.keepalive ||= keepalive;
    if (this.view.status === "conflict") return false;
    if (this.running) return this.running;
    this.running = this.drain();
    try { return await this.running; } finally { this.running = null; }
  }
  private async drain(): Promise<boolean> {
    while (this.latest) {
      this.inFlight ??= { position: this.latest, revision: this.revision, mutationId: this.id() };
      const payload = this.inFlight; this.persist(); this.publish("saving");
      let saved: ReadingReaderStateDTO | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.fetcher(this.options.url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: this.keepalive });
          const data = await response.json() as ReadingReaderStateDTO & { error?: string; state?: ReadingReaderStateDTO };
          if (response.status === 409) { this.publish("conflict", data.error || "阅读位置已在其他窗口更新，本地位置已保留。"); return false; }
          if (!response.ok) {
            if (response.status < 500) { this.publish("failed", data.error || "阅读位置保存失败。"); return false; }
            throw new Error(data.error || "阅读位置保存失败。");
          }
          if (data.documentKey !== this.options.document.key || data.revision !== payload.revision + 1 || data.mutationId !== payload.mutationId ||
            !equalReadingPosition(data.position, payload.position)) throw new Error("保存结果无法确认，本地位置已保留。");
          saved = data; break;
        } catch (cause) {
          if (attempt === 2 || this.keepalive) { this.publish("failed", cause instanceof Error ? cause.message : "网络不可用，本地位置已保留。"); return false; }
          await this.delay(250 * (attempt + 1));
        }
      }
      if (!saved) return false;
      this.revision = saved.revision; this.inFlight = null;
      if (equalReadingPosition(this.latest, payload.position)) this.latest = null;
      this.persist();
    }
    this.publish("saved"); return true;
  }
  async retry(): Promise<boolean> {
    if (this.running) await this.running;
    if (this.view.status === "conflict") {
      try {
        const response = await this.fetcher(this.options.url, { cache: "no-store" });
        if (!response.ok) throw new Error("无法同步阅读位置，请稍后重试。");
        const data = await response.json() as ReadingReaderStateDTO;
        if (data.documentKey !== this.options.document.key || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("阅读位置记录无效。");
        this.revision = data.revision; this.inFlight = null;
      } catch (cause) { this.publish("conflict", cause instanceof Error ? cause.message : "同步失败。"); return false; }
    }
    this.keepalive = false; this.publish("saving"); this.persist(); return this.flush();
  }
  detach() {
    this.detached = true;
    void this.flush(true);
  }
}
