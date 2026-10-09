"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, PlugZap, Save, Trash2 } from "lucide-react";
import { PROVIDERS, type PublicSettings, type PublicConnection, type ConnectionProtocol, type ModelBinding } from "@/lib/types";

const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";
type EditConnection = PublicConnection & { apiKey: string | null };
export default function ModelSettings() {
  const [connections, setConnections] = useState<EditConnection[]>([]);
  const [models, setModels] = useState<{ chat: ModelBinding; analysis: ModelBinding } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  useEffect(() => {
    void fetch("/api/settings").then(async (r) => { if (!r.ok) throw new Error("无法加载连接"); return r.json() as Promise<PublicSettings>; })
      .then((s) => { setConnections(s.connections.map((c) => ({ ...c, apiKey: "" }))); setModels(s.models); })
      .catch((e) => setResult(String(e)));
  }, []);
  const edit = (id: string, patch: Partial<EditConnection>) => setConnections((all) => all.map((c) => c.id === id ? { ...c, ...patch } : c));
  async function save(purpose?: "chat" | "analysis") {
    setBusy(true); setResult("");
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connections: connections.map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, baseUrl: c.baseUrl,
          envProvider: c.envProvider, ...(c.apiKey === null || c.apiKey ? { apiKey: c.apiKey } : {}) })), models }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error);
      setConnections((data as PublicSettings).connections.map((c) => ({ ...c, apiKey: "" })));
      setResult("模型设置已保存");
      if (purpose) {
        const test = await fetch("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose }) });
        const reply = await test.json(); if (!reply.ok) throw new Error(reply.error);
        setResult(`${purpose === "chat" ? "讲解" : "分析"}模型 ${reply.model}：${reply.reply}`);
      }
    } catch (e) { setResult(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-5 border-t-2 border-neutral-900 py-6">
    <div className="flex items-center justify-between"><h2 className="font-bold">服务商连接</h2>
      <button type="button" title="添加连接" aria-label="添加连接" className="p-2" onClick={() => setConnections((all) => [...all, {
        id: crypto.randomUUID(), name: "新连接", protocol: "openai-compatible", baseUrl: "", apiKey: "", hasKey: false, keySource: "none", keyPreview: "",
      }])}><Plus className="h-5 w-5" /></button></div>
    {connections.map((c) => <div key={c.id} className="grid gap-3 border-b border-neutral-200 pb-5 sm:grid-cols-2">
      <label className="text-sm">连接名称<input aria-label="连接名称" className={`${input} mt-1`} value={c.name} onChange={(e) => edit(c.id, { name: e.target.value })} /></label>
      <label className="text-sm">接口类型<select aria-label="接口类型" className={`${input} mt-1`} value={c.protocol} onChange={(e) => edit(c.id, { protocol: e.target.value as ConnectionProtocol })}>
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="openai-compatible">OpenAI 兼容</option>
      </select></label>
      <label className="text-sm">接口地址<input aria-label="接口地址" className={`${input} mt-1`} value={c.baseUrl} placeholder={PROVIDERS.find((p) => p.id === c.protocol)?.defaultBaseUrl ?? "https://example.com/v1"} onChange={(e) => edit(c.id, { baseUrl: e.target.value })} /></label>
      <label className="text-sm">API Key<div className="mt-1 flex gap-2"><input type="password" autoComplete="off" aria-label={`${c.name} API Key`} className={input} value={c.apiKey ?? ""} placeholder={c.hasKey ? c.keyPreview : "未配置"} onChange={(e) => edit(c.id, { apiKey: e.target.value })} />
        <button title="清除密钥" aria-label="清除密钥" onClick={() => edit(c.id, { apiKey: null })}><Trash2 className="h-4 w-4" /></button></div></label>
      <div className="flex items-center justify-between sm:col-span-2"><span className="text-xs text-neutral-500">{c.keySource === "env" ? "环境变量" : c.hasKey ? "已配置" : "未配置"}</span>
        <button title="删除连接" aria-label={`删除 ${c.name}`} disabled={models?.chat.connectionId === c.id || models?.analysis.connectionId === c.id} className="p-2 disabled:opacity-30" onClick={() => setConnections((all) => all.filter((old) => old.id !== c.id))}><Trash2 className="h-4 w-4" /></button></div>
    </div>)}
    <h2 className="pt-2 font-bold">模型用途</h2>
    {models && (["chat", "analysis"] as const).map((purpose) => <div key={purpose} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <label className="text-sm">{purpose === "chat" ? "讲解模型连接" : "分析模型连接"}<select aria-label={`${purpose}连接`} value={models[purpose].connectionId} className={`${input} mt-1`} onChange={(e) => setModels({ ...models, [purpose]: { ...models[purpose], connectionId: e.target.value } })}>
        {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      <label className="text-sm">模型名称<input aria-label={`${purpose}模型名称`} value={models[purpose].model} className={`${input} mt-1`} onChange={(e) => setModels({ ...models, [purpose]: { ...models[purpose], model: e.target.value } })} /></label>
      <button disabled={busy} className="flex items-center gap-2 border border-neutral-300 px-3 py-2 text-sm" onClick={() => void save(purpose)}><PlugZap className="h-4 w-4" />测试</button>
    </div>)}
    <div className="flex flex-wrap items-center gap-3"><button disabled={busy || !models} className="flex items-center gap-2 bg-neutral-900 px-4 py-2 text-sm text-white" onClick={() => void save()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存模型设置</button>
      <p role="status" className="break-words text-sm">{result}</p></div>
  </section>;
}
