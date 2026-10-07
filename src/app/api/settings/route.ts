import { getSettings, saveSettings, toPublicSettings } from "@/lib/server/settings";
import { PROVIDERS, type ProviderId } from "@/lib/types";

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
  const body = (await req.json().catch(() => ({}))) as {
    provider?: ProviderId;
    providers?: Partial<Record<ProviderId, ProviderPatch>>;
    fish?: { apiKey?: string | null; model?: string; enabled?: boolean };
    autoContinue?: boolean;
  };
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
  }
  if (body.fish) {
    if (body.fish.apiKey === null) s.fish.apiKey = "";
    else if (typeof body.fish.apiKey === "string" && body.fish.apiKey.trim()) s.fish.apiKey = body.fish.apiKey.trim();
    if (typeof body.fish.model === "string") s.fish.model = body.fish.model.trim() || "s2.1-pro";
    if (typeof body.fish.enabled === "boolean") s.fish.enabled = body.fish.enabled;
  }
  if (typeof body.autoContinue === "boolean") s.autoContinue = body.autoContinue;
  await saveSettings(s);
  return Response.json(toPublicSettings(s));
}
