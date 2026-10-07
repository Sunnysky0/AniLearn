import { complete } from "@/lib/server/llm";
import { getLLMConfig, getSettings } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const s = await getSettings();
    const cfg = getLLMConfig(s, "chat");
    const started = Date.now();
    const reply = await complete(cfg, {
      system: "你是连接测试助手。",
      messages: [{ role: "user", content: "请只回复四个字：连接成功" }],
      maxTokens: 512,
    });
    return Response.json({
      ok: true,
      provider: cfg.provider,
      model: cfg.model,
      reply: reply.trim().slice(0, 200),
      ms: Date.now() - started,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
