"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, Loader2, PlugZap, Save, School, Volume2, XCircle } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { PROVIDERS, type ProviderId, type PublicSettings } from "@/lib/types";

interface Edit {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  analysisModel: string;
}

const inputCls =
  "w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100";

function initialEdits(): Record<ProviderId, Edit> {
  const out = {} as Record<ProviderId, Edit>;
  for (const p of PROVIDERS) out[p.id] = { apiKey: "", baseUrl: "", chatModel: p.defaultChatModel, analysisModel: p.defaultAnalysisModel };
  return out;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-blue-600" : "bg-slate-300"}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [edits, setEdits] = useState<Record<ProviderId, Edit>>(initialEdits);
  const [fishKey, setFishKey] = useState("");
  const [fishModel, setFishModel] = useState("s2.1-pro");
  const [fishEnabled, setFishEnabled] = useState(true);
  const [autoContinue, setAutoContinue] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmTest, setLlmTest] = useState<{ loading: boolean; ok?: boolean; text?: string }>({ loading: false });
  const [ttsTest, setTtsTest] = useState<{ loading: boolean; ok?: boolean; text?: string }>({ loading: false });

  function load(d: PublicSettings) {
    setS(d);
    setProvider(d.provider);
    const e = initialEdits();
    for (const p of PROVIDERS) {
      e[p.id] = {
        apiKey: "",
        baseUrl: d.providers[p.id].baseUrl,
        chatModel: d.providers[p.id].chatModel,
        analysisModel: d.providers[p.id].analysisModel,
      };
    }
    setEdits(e);
    setFishKey("");
    setFishModel(d.fish.model);
    setFishEnabled(d.fish.enabled);
    setAutoContinue(d.autoContinue);
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: PublicSettings) => load(d))
      .catch((e) => setError(String(e)));
  }, []);

  async function save(extra: Record<string, unknown> = {}) {
    setSaving(true);
    setError(null);
    try {
      const providers: Record<string, Partial<Edit>> = {};
      for (const p of PROVIDERS) {
        const e = edits[p.id];
        providers[p.id] = {
          baseUrl: e.baseUrl,
          chatModel: e.chatModel,
          analysisModel: e.analysisModel,
          ...(e.apiKey.trim() ? { apiKey: e.apiKey.trim() } : {}),
        };
      }
      const body = {
        provider,
        providers,
        fish: { model: fishModel, enabled: fishEnabled, ...(fishKey.trim() ? { apiKey: fishKey.trim() } : {}) },
        autoContinue,
        ...extra,
      };
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      load(d as PublicSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function clearKey(target: ProviderId | "fish") {
    if (target === "fish") await save({ fish: { apiKey: null, model: fishModel, enabled: fishEnabled } });
    else await save({ providers: { [target]: { apiKey: null } } });
  }

  async function testLLM() {
    setLlmTest({ loading: true });
    if (!(await save())) return setLlmTest({ loading: false });
    const r = await fetch("/api/settings/test", { method: "POST" });
    const j = await r.json();
    setLlmTest({
      loading: false,
      ok: !!j.ok,
      text: j.ok ? `${j.model} 回复：「${j.reply}」（${(j.ms / 1000).toFixed(1)}s）` : j.error,
    });
  }

  async function testTTS() {
    setTtsTest({ loading: true });
    if (!(await save())) return setTtsTest({ loading: false });
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "[優しく穏やかな口調] こんにちは！AniLearnへようこそ。一緒に一問ずつ頑張りましょうね。" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error || "语音合成失败");
      }
      const url = URL.createObjectURL(await r.blob());
      await new Audio(url).play();
      setTtsTest({ loading: false, ok: true, text: "语音合成成功，正在播放 ♪" });
    } catch (e) {
      setTtsTest({ loading: false, ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  const meta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const pub = s?.providers[provider];
  const edit = edits[provider];
  const setEdit = (patch: Partial<Edit>) => setEdits((all) => ({ ...all, [provider]: { ...all[provider], ...patch } }));

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">设置</h1>
          <p className="mt-1 text-sm text-slate-500">
            API Key 仅保存在服务器端数据库中（也可通过环境变量配置），不会暴露给浏览器。
          </p>
        </div>
        {!s && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}

        <section className="space-y-5 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70">
          <h2 className="flex items-center gap-2 font-bold text-slate-800">
            <Cpu className="h-5 w-5 text-blue-600" /> AI 模型服务商
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {PROVIDERS.map((p) => {
              const has = s?.providers[p.id].hasKey;
              return (
                <button
                  key={p.id}
                  onClick={() => setProvider(p.id)}
                  className={`relative rounded-2xl p-4 text-left ring-2 transition ${
                    provider === p.id ? "bg-blue-50 ring-blue-500" : "bg-slate-50 ring-transparent hover:ring-slate-200"
                  }`}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ background: p.color }}>
                    {p.name[0]}
                  </div>
                  <div className="mt-2 font-semibold text-slate-800">{p.name}</div>
                  <div className="text-xs text-slate-500">{p.vendor}</div>
                  {has && <CheckCircle2 className="absolute right-3 top-3 h-5 w-5 text-emerald-500" />}
                </button>
              );
            })}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="text-sm font-semibold text-slate-700">{meta.name} API Key</label>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={edit.apiKey}
                  onChange={(e) => setEdit({ apiKey: e.target.value })}
                  placeholder={pub?.hasKey ? `已配置：${pub.keyPreview}（留空则保持不变）` : meta.keyHint}
                  className={inputCls}
                  autoComplete="off"
                />
                {pub?.keySource === "db" && (
                  <button onClick={() => void clearKey(provider)} className="shrink-0 rounded-xl px-3 text-sm text-slate-500 ring-1 ring-slate-200 hover:text-rose-600">
                    清除
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {pub?.keySource === "env"
                  ? `当前使用环境变量（${meta.envKeys.join(" / ")}）中的 Key。`
                  : `也可以通过环境变量 ${meta.envKeys[0]} 配置。`}
              </p>
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700">对话模型（讲课）</label>
              <input list={`chat-${provider}`} value={edit.chatModel} onChange={(e) => setEdit({ chatModel: e.target.value })} className={`${inputCls} mt-2`} />
              <datalist id={`chat-${provider}`}>
                {meta.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="mt-1.5 text-xs text-slate-400">建议选择响应快的模型，讲课更流畅。</p>
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700">解析模型（识别试卷）</label>
              <input list={`ana-${provider}`} value={edit.analysisModel} onChange={(e) => setEdit({ analysisModel: e.target.value })} className={`${inputCls} mt-2`} />
              <datalist id={`ana-${provider}`}>
                {meta.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="mt-1.5 text-xs text-slate-400">需支持图片输入，建议选择能力最强的模型。</p>
            </div>
            <div className="sm:col-span-2">
              <label className="text-sm font-semibold text-slate-700">自定义 Base URL（可选）</label>
              <input value={edit.baseUrl} onChange={(e) => setEdit({ baseUrl: e.target.value })} placeholder={meta.defaultBaseUrl} className={`${inputCls} mt-2`} />
              <p className="mt-1.5 text-xs text-slate-400">使用 API 中转/代理服务时填写，留空使用官方地址。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void testLLM()}
              disabled={llmTest.loading || saving}
              className="inline-flex items-center gap-2 rounded-full bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {llmTest.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} 保存并测试连接
            </button>
            {llmTest.text && (
              <span className={`flex items-center gap-1.5 text-sm ${llmTest.ok ? "text-emerald-600" : "text-rose-600"}`}>
                {llmTest.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                <span className="break-all">{llmTest.text}</span>
              </span>
            )}
          </div>
        </section>

        <section className="space-y-5 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold text-slate-800">
              <Volume2 className="h-5 w-5 text-blue-600" /> 语音（Fish Audio TTS）
            </h2>
            <Toggle on={fishEnabled} onChange={setFishEnabled} />
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            导师的语音固定使用<b>日语</b>播报（文字消息与板书为中文），语音与文字同步出现。每位导师的声音（reference_id）在「我的导师」中单独设置。
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="text-sm font-semibold text-slate-700">Fish Audio API Key</label>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={fishKey}
                  onChange={(e) => setFishKey(e.target.value)}
                  placeholder={s?.fish.hasKey ? `已配置：${s.fish.keyPreview}` : "粘贴 Fish Audio API Key"}
                  className={inputCls}
                  autoComplete="off"
                />
                {s?.fish.keySource === "db" && (
                  <button onClick={() => void clearKey("fish")} className="shrink-0 rounded-xl px-3 text-sm text-slate-500 ring-1 ring-slate-200 hover:text-rose-600">
                    清除
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {s?.fish.keySource === "env" ? "当前使用环境变量 FISH_API_KEY。" : "也可以通过环境变量 FISH_API_KEY 配置。"}
              </p>
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700">TTS 模型</label>
              <input list="fish-models" value={fishModel} onChange={(e) => setFishModel(e.target.value)} className={`${inputCls} mt-2`} />
              <datalist id="fish-models">
                <option value="s2.1-pro" />
                <option value="s1" />
                <option value="speech-1.6" />
              </datalist>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void testTTS()}
              disabled={ttsTest.loading || saving}
              className="inline-flex items-center gap-2 rounded-full bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {ttsTest.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />} 保存并试听
            </button>
            {ttsTest.text && (
              <span className={`text-sm ${ttsTest.ok ? "text-emerald-600" : "text-rose-600"} break-all`}>{ttsTest.text}</span>
            )}
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70">
          <h2 className="flex items-center gap-2 font-bold text-slate-800">
            <School className="h-5 w-5 text-blue-600" /> 课堂
          </h2>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-700">允许导师连续讲解</div>
              <div className="text-xs text-slate-500">开启后导师可以自主地连续发送多轮消息、自动进入下一题；关闭后每轮讲完都会等待你的回复。</div>
            </div>
            <Toggle on={autoContinue} onChange={setAutoContinue} />
          </div>
        </section>

        {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-600">{error}</div>}
        <div className="sticky bottom-4 flex justify-end">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-6 py-3 font-semibold text-white shadow-xl shadow-blue-500/30 hover:brightness-110 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : saved ? <CheckCircle2 className="h-5 w-5" /> : <Save className="h-5 w-5" />}
            {saved ? "已保存" : "保存设置"}
          </button>
        </div>
      </main>
    </div>
  );
}
