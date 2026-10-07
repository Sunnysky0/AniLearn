import { createHash } from "node:crypto";
import { getSettings, resolveFishKey } from "@/lib/server/settings";
import { DEFAULT_VOICE_ID, type TTSRequest } from "@/lib/types";
import { isJapaneseSpeech } from "@/lib/text";
import { fishErrorResponse, fishRequest, FishRequestError } from "@/lib/server/fish";

export const dynamic = "force-dynamic";

// Small in-memory cache so replays don't cost extra API calls.
const globalCache = globalThis as typeof globalThis & { __anilearnTTS?: Map<string, ArrayBuffer> };
const cache = (globalCache.__anilearnTTS ??= new Map<string, ArrayBuffer>());

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<TTSRequest> | null;
  const text = (typeof body?.text === "string" ? body.text : "").trim().slice(0, 1500);
  if (!text) return Response.json({ error: "缺少语音文本" }, { status: 400 });
  if (!isJapaneseSpeech(text)) return Response.json({ error: "语音文本必须为日语，不得包含中文、Markdown 或 LaTeX。" }, { status: 400 });

  const s = await getSettings();
  const { key } = resolveFishKey(s);
  if (!key) return Response.json({ error: "尚未配置 Fish Audio API Key" }, { status: 400 });

  const model = s.fish.model || "s2.1-pro";
  const voiceId = (typeof body?.voiceId === "string" ? body.voiceId : "").trim() || DEFAULT_VOICE_ID;
  const hash = createHash("sha1").update(JSON.stringify([key, s.fish.proxyUrl, model, voiceId, text])).digest("hex");
  const hit = body?.fresh === true ? undefined : cache.get(hash);
  if (hit) {
    return new Response(hit.slice(0), { headers: { "Content-Type": "audio/mpeg", "X-TTS-Cache": "hit" } });
  }

  try {
    const audio = await fishRequest("/v1/tts", { key, proxyUrl: s.fish.proxyUrl }, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        model,
      },
      body: JSON.stringify({ text, reference_id: voiceId, format: "mp3" }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(12_000)]),
    }, async (response) => {
      const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream")
        throw new FishRequestError("Fish Audio 返回的内容不是音频，请稍后重试。", "FISH_INVALID_RESPONSE");
      const audio = await response.arrayBuffer();
      if (!audio.byteLength)
        throw new FishRequestError("Fish Audio 返回了空音频，请稍后重试。", "FISH_INVALID_RESPONSE");
      return audio;
    });
    cache.set(hash, audio);
    if (cache.size > 400) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return new Response(audio.slice(0), { headers: { "Content-Type": "audio/mpeg" } });
  } catch (e) {
    return fishErrorResponse(e);
  }
}
