import { getSettings, saveSettings, toPublicSettings } from "@/lib/server/settings";
import { PROVIDERS, type ProviderId, type ProviderConnection, type ModelBinding } from "@/lib/types";
import { normalizeFishProxy } from "@/lib/server/fish";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  return Response.json(toPublicSettings(s));
}

interface ProviderPatch {
  apiKey?: string | null;
  baseUrl?: string;
  chatModel?: string;
  analysisModel?: string;
}

export async function PUT(req: Request) {
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input))
    return Response.json({ error: "设置必须为 JSON 对象。" }, { status: 400 });
  const body = input as {
    provider?: ProviderId;
    providers?: Partial<Record<ProviderId, ProviderPatch>>;
    fish?: { apiKey?: string | null; model?: string; enabled?: boolean; proxyUrl?: string | null };
    autoContinue?: boolean;
    connections?: (Omit<ProviderConnection, "apiKey"> & { apiKey?: string | null })[];
    models?: { chat: ModelBinding; analysis: ModelBinding };
  };
  if (body.fish !== undefined && (!body.fish || typeof body.fish !== "object" || Array.isArray(body.fish)))
    return Response.json({ error: "Fish Audio 设置必须为对象。" }, { status: 400 });
  let proxyUrl: string | undefined;
  if (body.fish && "proxyUrl" in body.fish) {
    if (body.fish.proxyUrl === null) proxyUrl = "";
    else if (typeof body.fish.proxyUrl !== "string")
      return Response.json({ error: "代理地址必须为字符串或 null。" }, { status: 400 });
    else {
      try { proxyUrl = normalizeFishProxy(body.fish.proxyUrl); }
      catch (e) { return Response.json({ error: e instanceof Error ? e.message : "代理地址无效。" }, { status: 400 }); }
    }
  }
  const s = await getSettings();
  if (body.provider && PROVIDERS.some((p) => p.id === body.provider)) s.provider = body.provider;
  for (const p of PROVIDERS) {
    const inc = body.providers?.[p.id];
    if (!inc) continue;
    const cur = s.providers[p.id];
    if (typeof inc.baseUrl === "string") cur.baseUrl = inc.baseUrl.trim();
    if (typeof inc.chatModel === "string") cur.chatModel = inc.chatModel.trim();
    if (typeof inc.analysisModel === "string") cur.analysisModel = inc.analysisModel.trim();
    if (inc.apiKey === null) cur.apiKey = "";
    else if (typeof inc.apiKey === "string" && inc.apiKey.trim()) cur.apiKey = inc.apiKey.trim();
    const connection = s.connections.find((c) => c.id === p.id);
    if (connection) { connection.baseUrl = cur.baseUrl; connection.apiKey = cur.apiKey; }
  }
  if (body.provider || body.providers) {
    const id = body.provider ?? s.provider;
    if (body.provider || body.providers?.[id]?.chatModel !== undefined) s.models.chat = { connectionId: id, model: s.providers[id].chatModel };
    if (body.provider || body.providers?.[id]?.analysisModel !== undefined) s.models.analysis = { connectionId: id, model: s.providers[id].analysisModel };
  }
  if (body.connections !== undefined) {
    if (!Array.isArray(body.connections) || !body.connections.length || body.connections.length > 30) return Response.json({ error: "请保留 1 至 30 个连接。" }, { status: 400 });
    const protocols = ["openai", "anthropic", "xai", "gemini", "openai-compatible"];
    const connections: ProviderConnection[] = [];
    for (const c of body.connections) {
      if (!c || typeof c.id !== "string" || !/^[\w-]{1,80}$/.test(c.id) || !protocols.includes(c.protocol) || typeof c.name !== "string" || !c.name.trim() || typeof c.baseUrl !== "string") return Response.json({ error: "服务商连接无效。" }, { status: 400 });
      if (c.baseUrl) {
        try { const url = new URL(c.baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { return Response.json({ error: "连接地址必须是 HTTP/HTTPS 地址，不能包含密码。" }, { status: 400 }); }
      }
      if (c.protocol === "openai-compatible" && !c.baseUrl.trim()) return Response.json({ error: "自定义连接需要填写地址。" }, { status: 400 });
      if (c.envProvider !== undefined && !PROVIDERS.some((p) => p.id === c.envProvider)) return Response.json({ error: "环境变量来源无效。" }, { status: 400 });
      const previous = s.connections.find((old) => old.id === c.id);
      connections.push({ id: c.id, name: c.name.trim().slice(0, 80), protocol: c.protocol, baseUrl: c.baseUrl.trim(), envProvider: c.envProvider,
        apiKey: c.apiKey === null ? "" : typeof c.apiKey === "string" && c.apiKey.trim() ? c.apiKey.trim() : previous?.apiKey ?? "" });
    }
    if (new Set(connections.map((c) => c.id)).size !== connections.length) return Response.json({ error: "连接 ID 重复。" }, { status: 400 });
    s.connections = connections;
  }
  if (body.models !== undefined) s.models = body.models;
  for (const purpose of ["chat", "analysis"] as const) {
    const binding = s.models?.[purpose];
    if (!binding || typeof binding.model !== "string" || !binding.model.trim() || !s.connections.some((c) => c.id === binding.connectionId)) return Response.json({ error: "讲解和分析模型必须绑定有效连接及模型名称。" }, { status: 400 });
    binding.model = binding.model.trim().slice(0, 200);
  }
  if (body.fish) {
    if (proxyUrl !== undefined) s.fish.proxyUrl = proxyUrl;
    if (body.fish.apiKey === null) s.fish.apiKey = "";
    else if (typeof body.fish.apiKey === "string" && body.fish.apiKey.trim()) s.fish.apiKey = body.fish.apiKey.trim();
    if (typeof body.fish.model === "string") s.fish.model = body.fish.model.trim() || "s2.1-pro";
    if (typeof body.fish.enabled === "boolean") s.fish.enabled = body.fish.enabled;
  }
  if (typeof body.autoContinue === "boolean") s.autoContinue = body.autoContinue;
  await saveSettings(s);
  return Response.json(toPublicSettings(s));
}
