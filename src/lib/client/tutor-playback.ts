import { tokenizeForReveal } from "@/lib/text";

export async function revealTutorMessage(options: {
  text: string; speech: string; voiceId: string; muted: () => boolean; rate: () => number;
  signal: AbortSignal; onReveal: (shown: number | null) => void;
}) {
  const tokens = tokenizeForReveal(options.text); const full = () => options.onReveal(null);
  options.onReveal(0);
  let url: string | undefined; let audio: HTMLAudioElement | undefined;
  const pause = () => audio?.pause();
  options.signal.addEventListener("abort", pause, { once: true });
  try {
    if (options.signal.aborted) return;
    if (options.speech && !options.muted()) {
      try {
        const response = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: options.speech, voiceId: options.voiceId }), signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) });
        if (response.ok && !options.signal.aborted && !options.muted()) {
          url = URL.createObjectURL(await response.blob()); audio = new Audio(url); audio.playbackRate = options.rate();
          const playing = audio.play();
          await Promise.race([playing, new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Audio playback timed out")), 5000);
            playing.finally(() => clearTimeout(timer)).catch(() => undefined);
          })]);
        }
      } catch { audio?.pause(); audio = undefined; }
    }
    if (options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const start = performance.now(); let timer: ReturnType<typeof setTimeout>; let lastTime = 0; let progressed = start;
      const finish = () => { clearTimeout(timer); audio?.pause(); options.signal.removeEventListener("abort", finish); resolve(); };
      const tick = () => {
        if (options.signal.aborted) return finish();
        if (options.muted() && audio) { audio.pause(); audio = undefined; }
        if (audio && audio.currentTime > lastTime) { lastTime = audio.currentTime; progressed = performance.now(); }
        if (audio && performance.now() - progressed > 5000) { audio.pause(); audio = undefined; }
        const duration = Math.max(700, tokens.length * 32 / options.rate());
        const progress = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : (performance.now() - start) / duration;
        options.onReveal(Math.min(tokens.length, Math.floor(tokens.length * progress)));
        if (audio ? audio.ended || !!audio.error : progress >= 1) finish(); else timer = setTimeout(tick, 30);
      };
      options.signal.addEventListener("abort", finish, { once: true }); tick();
    });
  } finally { options.signal.removeEventListener("abort", pause); audio?.pause(); if (url) URL.revokeObjectURL(url); full(); }
}
