import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import {
  PROVIDERS,
  type KeySource,
  type ProviderId,
  type PublicSettings,
  type SettingsData,
  type ProviderConnection,
} from "@/lib/types";
import type { LLMConfig } from "./llm";
import { fishProxyPreview } from "./fish";

export const FISH_ENV = ["FISH_API_KEY", "FISH_AUDIO_API_KEY"];

function envFirst(names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

export function providerMeta(id: ProviderId) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function defaultSettings(): SettingsData {
  const providers = {} as SettingsData["providers"];
  for (const p of PROVIDERS) {
    providers[p.id] = {
      apiKey: "",
      baseUrl: "",
      chatModel: p.defaultChatModel,
      analysisModel: p.defaultAnalysisModel,
    };
  }
  const withEnv = PROVIDERS.find((p) => envFirst(p.envKeys));
  return {
    connections: PROVIDERS.map((p) => ({ id: p.id, name: p.name, protocol: p.id, baseUrl: "", apiKey: "", envProvider: p.id })),
    models: {
      chat: { connectionId: withEnv?.id ?? "openai", model: providers[withEnv?.id ?? "openai"].chatModel },
      analysis: { connectionId: withEnv?.id ?? "openai", model: providers[withEnv?.id ?? "openai"].analysisModel },
    },
    provider: withEnv?.id ?? "openai",
    providers,
    fish: { apiKey: "", model: "s2.1-pro", enabled: true, proxyUrl: "" },
    autoContinue: true,
  };
}

export async function getSettings(): Promise<SettingsData> {
  const def = defaultSettings();
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (!row) return def;
  const d = row.data ?? {};
  const providers = { ...def.providers };
  for (const p of PROVIDERS) {
    providers[p.id] = { ...def.providers[p.id], ...(d.providers?.[p.id] ?? {}) };
  }
  const provider =
    d.provider && PROVIDERS.some((p) => p.id === d.provider) ? d.provider : def.provider;
  return {
    connections: d.connections ?? PROVIDERS.map((p) => ({
      id: p.id, name: p.name, protocol: p.id, baseUrl: providers[p.id].baseUrl,
      apiKey: providers[p.id].apiKey, envProvider: p.id,
    })),
    models: d.models ?? {
      chat: { connectionId: provider, model: providers[provider].chatModel },
      analysis: { connectionId: provider, model: providers[provider].analysisModel },
    },
    provider,
    providers,
    fish: { ...def.fish, ...(d.fish ?? {}) },
    autoContinue: typeof d.autoContinue === "boolean" ? d.autoContinue : def.autoContinue,
  };
}

export async function saveSettings(data: SettingsData) {
  await db
    .insert(appSettings)
    .values({ id: 1, data })
    .onConflictDoUpdate({ target: appSettings.id, set: { data, updatedAt: new Date() } });
}

export function resolveProviderKey(
  s: SettingsData,
  id: ProviderId,
): { key: string; source: KeySource } {
  const k = (s.providers[id]?.apiKey ?? "").trim();
  if (k) return { key: k, source: "db" };
  const e = envFirst(providerMeta(id).envKeys);
  if (e) return { key: e, source: "env" };
  return { key: "", source: "none" };
}

export function resolveFishKey(s: SettingsData): { key: string; source: KeySource } {
  const k = (s.fish.apiKey ?? "").trim();
  if (k) return { key: k, source: "db" };
  const e = envFirst(FISH_ENV);
  if (e) return { key: e, source: "env" };
  return { key: "", source: "none" };
}

function mask(k: string) {
  if (!k) return "";
  if (k.length <= 10) return "••••••";
  return `${k.slice(0, 4)}••••••${k.slice(-4)}`;
}

export function resolveConnectionKey(c: ProviderConnection): { key: string; source: KeySource } {
  if (c.apiKey.trim()) return { key: c.apiKey.trim(), source: "db" };
  const key = c.envProvider ? envFirst(providerMeta(c.envProvider).envKeys) : "";
  return { key, source: key ? "env" : "none" };
}
export function isLLMReady(s: SettingsData, purpose: "chat" | "analysis") {
  const c = s.connections.find((connection) => connection.id === s.models[purpose].connectionId);
  return !!c && !!resolveConnectionKey(c).key;
}

export function toPublicSettings(s: SettingsData): PublicSettings {
  const providers = {} as PublicSettings["providers"];
  for (const p of PROVIDERS) {
    const { key, source } = resolveProviderKey(s, p.id);
    const ps = s.providers[p.id];
    providers[p.id] = {
      baseUrl: ps.baseUrl,
      chatModel: ps.chatModel,
      analysisModel: ps.analysisModel,
      hasKey: !!key,
      keySource: source,
      keyPreview: mask(key),
    };
  }
  const fish = resolveFishKey(s);
  return {
    connections: s.connections.map((c) => {
      const { apiKey: _key, ...publicConnection } = c;
      void _key;
      const { key, source } = resolveConnectionKey(c);
      return { ...publicConnection, hasKey: !!key, keySource: source, keyPreview: mask(key) };
    }),
    models: s.models,
    provider: s.provider,
    providers,
    fish: {
      model: s.fish.model,
      enabled: s.fish.enabled,
      hasProxy: !!s.fish.proxyUrl,
      proxyPreview: fishProxyPreview(s.fish.proxyUrl),
      hasKey: !!fish.key,
      keySource: fish.source,
      keyPreview: mask(fish.key),
    },
    autoContinue: s.autoContinue,
  };
}

export function getLLMConfig(s: SettingsData, purpose: "chat" | "analysis"): LLMConfig {
  const binding = s.models[purpose];
  const connection = s.connections.find((c) => c.id === binding.connectionId);
  if (!connection) throw new Error("模型绑定的服务商连接不存在，请检查设置。");
  const id = connection.protocol === "openai-compatible" ? "openai" : connection.protocol;
  const meta = providerMeta(id);
  const { key } = resolveConnectionKey(connection);
  if (!key) {
    throw new Error(`尚未配置 ${meta.name} 的 API Key，请先前往「设置」页面填写（或切换到已配置的模型服务商）。`);
  }
  const model = binding.model.trim() ||
    (purpose === "chat" ? meta.defaultChatModel : meta.defaultAnalysisModel);
  return { provider: id, apiKey: key, baseUrl: connection.baseUrl.trim() || undefined, model };
}

export function isTTSReady(s: SettingsData) {
  return s.fish.enabled && !!resolveFishKey(s).key;
}
