import { createHash } from "node:crypto";
import { getSettings, resolveFishKey } from "@/lib/server/settings";
import { DEFAULT_VOICE_ID } from "@/lib/types";
import { isJapaneseSpeech } from "@/lib/text";

export const dynamic = "force-dynamic";

// Small in-memory cache so replays don't cost extra API calls.
const globalCache = globalThis as typeof globalThis & { __anilearnTTS?: Map<string, ArrayBuffer> };
const cache = (globalCache.__anilearnTTS ??= new Map<string, ArrayBuffer>());

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: string; voiceId?: string };
  const text = (body.text ?? "").trim().slice(0, 1500);
  if (!text) return Response.json({ error: "缺少语音文本" }, { status: 400 });
  if (!isJapaneseSpeech(text)) return Response.json({ error: "语音文本必须为日语，不得包含中文、Markdown 或 LaTeX。" }, { status: 400 });

  const s = await getSettings();
  const { key } = resolveFishKey(s);
  if (!key) return Response.json({ error: "尚未配置 Fish Audio API Key" }, { status: 400 });

  const model = s.fish.model || "s2.1-pro";
  const voiceId = (body.voiceId ?? "").trim() || DEFAULT_VOICE_ID;
  const hash = createHash("sha1").update(`${model}|${voiceId}|${text}`).digest("hex");
  const hit = cache.get(hash);
  if (hit) {
    return new Response(hit.slice(0), { headers: { "Content-Type": "audio/mpeg", "X-TTS-Cache": "hit" } });
  }

  try {
    const response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        model,
      },
      body: JSON.stringify({ text, reference_id: voiceId, format: "mp3" }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      return Response.json(
        { error: `Fish Audio 语音合成失败 (${response.status})：${t.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const audio = await response.arrayBuffer();
    cache.set(hash, audio);
    if (cache.size > 400) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return new Response(audio.slice(0), { headers: { "Content-Type": "audio/mpeg" } });
  } catch (e) {
    const error = e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name)
      ? "语音请求超时或已取消，将使用文字显示。" : e instanceof Error ? e.message : String(e);
    return Response.json({ error }, { status: 502 });
  }
}
