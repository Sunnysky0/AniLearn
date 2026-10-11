import { tokenizeForReveal } from "@/lib/text";
import type { SpeechAudioController } from "@/lib/client/speech-audio";

async function startAudio(audio: HTMLAudioElement, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(started);
    };
    const aborted = () => { audio.pause(); finish(false); };
    const timer = setTimeout(aborted, 5000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else void audio.play().then(() => finish(!signal.aborted), () => finish(false));
  });
}

export async function revealTutorMessage(options: {
  text: string; speech: string; voiceId: string; muted: () => boolean; rate: () => number;
  signal: AbortSignal; audio: SpeechAudioController; cacheKey: string;
  onReveal: (shown: number | null) => void; onSpeechError?: (error: string) => void;
}) {
  const tokens = tokenizeForReveal(options.text); const full = () => options.onReveal(null);
  options.onReveal(0);
  let revealed = 0;
  let url: string | undefined; let audio: HTMLAudioElement | undefined;
  const pause = () => audio?.pause();
  options.signal.addEventListener("abort", pause, { once: true });
  try {
    if (options.signal.aborted) return;
    if (options.speech && options.muted()) {
      options.audio.forget(options.cacheKey);
    } else if (options.speech) {
      const result = await options.audio.acquire({
        key: options.cacheKey, text: options.speech, voiceId: options.voiceId,
      }, options.signal);
      if (result.status === "ready" && !options.signal.aborted && !options.muted()) {
        url = result.url; audio = new Audio(url); audio.playbackRate = options.rate();
        if (!(await startAudio(audio, options.signal))) { audio.pause(); audio = undefined; }
      } else if (result.status === "error") options.onSpeechError?.(result.error.message);
    }
    if (options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const start = performance.now(); let timer: ReturnType<typeof setTimeout>; let lastTime = 0; let progressed = start;
      const finish = () => { clearTimeout(timer); audio?.pause(); options.signal.removeEventListener("abort", finish); resolve(); };
      const tick = () => {
        if (options.signal.aborted) return finish();
        if (audio) audio.playbackRate = options.rate();
        if (options.muted() && audio) { audio.pause(); audio = undefined; }
        if (audio && audio.currentTime > lastTime) { lastTime = audio.currentTime; progressed = performance.now(); }
        if (audio && performance.now() - progressed > 5000) { audio.pause(); audio = undefined; }
        const duration = Math.max(700, tokens.length * 32 / options.rate());
        const progress = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : (performance.now() - start) / duration;
        revealed = Math.max(revealed, Math.min(tokens.length, Math.floor(tokens.length * progress)));
        options.onReveal(revealed);
        if (audio ? audio.ended || !!audio.error : progress >= 1) finish(); else timer = setTimeout(tick, 30);
      };
      options.signal.addEventListener("abort", finish, { once: true }); tick();
    });
  } finally { options.signal.removeEventListener("abort", pause); audio?.pause(); full(); }
}
