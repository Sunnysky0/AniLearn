"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Loader2, Play, Save, School, Volume2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import ModelSettings from "@/components/ModelSettings";
import { type PublicSettings, type TTSRequest } from "@/lib/types";

const inputCls = "w-full  border border-neutral-200 bg-white px-3.5 py-2.5 text-sm outline-none transition   ";

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`flex h-6 w-6 shrink-0 items-center justify-center border border-neutral-900 ${on ? "bg-neutral-900 text-white" : "bg-white"}`}
      role="checkbox"
      aria-label={label}
      aria-checked={on}
    >
      {on && <Check className="h-4 w-4" />}
    </button>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [fishKey, setFishKey] = useState("");
  const [fishModel, setFishModel] = useState("s2.1-pro");
  const [fishEnabled, setFishEnabled] = useState(true);
  const [fishProxy, setFishProxy] = useState("");
  const [autoContinue, setAutoContinue] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ttsTest, setTtsTest] = useState<{ loading: boolean; ok?: boolean; text?: string }>({ loading: false });
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const ttsRequest = useRef<AbortController | null>(null);
  const ttsAudio = useRef<HTMLAudioElement | null>(null);
  const ttsUrl = useRef<string | null>(null);

  function load(d: PublicSettings) {
    setS(d);
    setFishKey("");
    setFishModel(d.fish.model);
    setFishEnabled(d.fish.enabled);
    setFishProxy("");
    setAutoContinue(d.autoContinue);
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: PublicSettings) => load(d))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => () => {
    ttsRequest.current?.abort();
    if (ttsAudio.current) {
      ttsAudio.current.onended = null;
      ttsAudio.current.onerror = null;
      ttsAudio.current.pause();
    }
    if (ttsUrl.current) URL.revokeObjectURL(ttsUrl.current);
    ttsAudio.current = null;
    ttsUrl.current = null;
  }, []);

  async function save(extra: Record<string, unknown> = {}) {
    if (!s) return false;
    setSaving(true);
    setError(null);
    try {
      const body = {
        autoContinue,
        ...extra,
        fish: {
          model: fishModel, enabled: fishEnabled,
          ...(fishKey.trim() ? { apiKey: fishKey.trim() } : {}),
          ...(fishProxy.trim() ? { proxyUrl: fishProxy.trim() } : {}),
          ...(extra.fish as Record<string, unknown> | undefined),
        },
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

  async function testTTS() {
    ttsRequest.current?.abort();
    stopTTS();
    const request = new AbortController();
    ttsRequest.current = request;
    setTtsTest({ loading: true });
    if (!(await save())) {
      if (!request.signal.aborted) setTtsTest({ loading: false, ok: false, text: "保存失败，尚未试听。" });
      return;
    }
    if (request.signal.aborted) return;
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "[優しく穏やかな口調] こんにちは！AniLearnへようこそ。一緒に一問ずつ頑張りましょうね。",
          fresh: true,
        } satisfies TTSRequest),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error || "语音合成失败");
      }
      const blob = await r.blob();
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      ttsUrl.current = url;
      const audio = new Audio(url);
      ttsAudio.current = audio;
      audio.onended = () => {
        stopTTS();
        setTtsTest({ loading: false, ok: true, text: "设置已保存，试听完成。" });
      };
      audio.onerror = () => {
        stopTTS();
        setTtsTest({ loading: false, ok: false, text: "设置已保存，但返回的音频无法播放，请重试。" });
      };
      await playTTS();
    } catch (e) {
      if (!request.signal.aborted) setTtsTest({ loading: false, ok: false,
        text: `设置已保存，试听失败：${e instanceof Error && e.name === "TimeoutError" ? "语音等待超时，请稍后重试。" : e instanceof Error ? e.message : "无法请求语音，请检查网络。"}` });
    }
  }

  function stopTTS() {
    if (ttsAudio.current) {
      ttsAudio.current.onended = null;
      ttsAudio.current.onerror = null;
      ttsAudio.current.pause();
      ttsAudio.current = null;
    }
    if (ttsUrl.current) URL.revokeObjectURL(ttsUrl.current);
    ttsUrl.current = null;
    setPlaybackBlocked(false);
  }

  async function playTTS() {
    const audio = ttsAudio.current;
    if (!audio) return;
    try {
      await audio.play();
      if (ttsAudio.current !== audio) return;
      setPlaybackBlocked(false);
      setTtsTest({ loading: false, ok: true, text: "设置已保存，语音合成成功，正在播放。" });
    } catch (e) {
      if (ttsAudio.current !== audio) return;
      if (e instanceof Error && e.name === "NotAllowedError") {
        setPlaybackBlocked(true);
        setTtsTest({ loading: false, ok: true, text: "设置已保存，语音合成成功，请点击播放。" });
      } else {
        stopTTS();
        setTtsTest({ loading: false, ok: false, text: "设置已保存，但音频播放失败，请重试。" });
      }
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-[32px] font-bold text-neutral-900">设置</h1>
          <p className="mt-1 text-sm text-neutral-500">
            API Key 仅保存在服务器端数据库中（也可通过环境变量配置），不会暴露给浏览器。
          </p>
        </div>
        {!s && (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}

        <ModelSettings />
        <section className="space-y-5 border-t-2 border-neutral-900 py-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold text-neutral-800">
              <Volume2 className="h-5 w-5 text-neutral-800" /> 语音（Fish Audio TTS）
            </h2>
            <Toggle on={fishEnabled} onChange={setFishEnabled} label="启用日语语音" />
          </div>
          <p className="text-xs leading-relaxed text-neutral-500">
            导师的语音固定使用<b>日语</b>
            播报（文字消息与板书为中文），语音与文字同步出现。每位导师的声音（reference_id）在「我的导师」中单独设置。
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="fish-key" className="text-sm font-semibold text-neutral-700">
                Fish Audio API Key
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="fish-key"
                  type="password"
                  value={fishKey}
                  onChange={(e) => setFishKey(e.target.value)}
                  placeholder={s?.fish.hasKey ? `已配置：${s.fish.keyPreview}` : "粘贴 Fish Audio API Key"}
                  className={inputCls}
                  autoComplete="off"
                />
                {s?.fish.keySource === "db" && (
                  <button
                    onClick={() => void save({ fish: { apiKey: null } })}
                    className="shrink-0 px-3 text-sm text-neutral-500 border border-neutral-200 hover:text-neutral-800"
                  >
                    清除
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                {s?.fish.keySource === "env"
                  ? "当前使用环境变量 FISH_API_KEY。"
                  : "也可以通过环境变量 FISH_API_KEY 配置。"}
              </p>
            </div>
            <div>
              <label htmlFor="fish-model" className="text-sm font-semibold text-neutral-700">
                TTS 模型
              </label>
              <input
                id="fish-model"
                list="fish-models"
                value={fishModel}
                onChange={(e) => setFishModel(e.target.value)}
                className={`${inputCls} mt-2`}
              />
              <datalist id="fish-models">
                <option value="s2.1-pro" />
                <option value="s2.1-pro-free" />
                <option value="s2-pro" />
                <option value="s1" />
                <option value="speech-1.6" />
              </datalist>
            </div>
          </div>
          <div>
            <label htmlFor="fish-proxy" className="text-sm font-semibold text-neutral-700">代理地址（可选）</label>
            <div className="mt-2 flex gap-2">
              <input
                id="fish-proxy"
                type="password"
                value={fishProxy}
                onChange={(e) => setFishProxy(e.target.value)}
                placeholder={s?.fish.hasProxy ? `已配置：${s.fish.proxyPreview}` : "http://127.0.0.1:18081"}
                className={inputCls}
                autoComplete="off"
              />
              {s?.fish.hasProxy && (
                <button onClick={() => void save({ fish: { proxyUrl: null } })} disabled={saving || ttsTest.loading}
                  className="shrink-0 border border-neutral-200 px-3 text-sm text-neutral-500 hover:text-neutral-800"
                  aria-label="清除 Fish Audio 代理">清除</button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void testTTS()}
              disabled={!s || ttsTest.loading || saving}
              className="inline-flex items-center gap-2 bg-neutral-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {ttsTest.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}{" "}
              保存并试听
            </button>
            {playbackBlocked && (
              <button onClick={() => void playTTS()} title="播放试听" aria-label="播放试听"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-300">
                <Play className="h-4 w-4" />
              </button>
            )}
            {ttsTest.text && (
              <span className={`text-sm ${ttsTest.ok ? "text-neutral-800" : "text-neutral-800"} break-all`}>
                {ttsTest.text}
              </span>
            )}
          </div>
        </section>

        <section className="border-t-2 border-neutral-900 py-6">
          <h2 className="flex items-center gap-2 font-bold text-neutral-800">
            <School className="h-5 w-5 text-neutral-800" /> 课堂
          </h2>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-neutral-700">允许导师连续讲解</div>
              <div className="text-xs text-neutral-500">
                开启后导师可以自主地连续发送多轮消息、自动进入下一题；关闭后每轮讲完都会等待你的回复。
              </div>
            </div>
            <Toggle on={autoContinue} onChange={setAutoContinue} label="允许导师连续讲解" />
          </div>
        </section>

        {error && <div className="bg-neutral-100 p-3 text-sm text-neutral-800">{error}</div>}
        <div className="flex justify-end border-t-2 border-neutral-900 pt-6">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-2 bg-neutral-900 px-6 py-3 font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : saved ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <Save className="h-5 w-5" />
            )}
            {saved ? "已保存" : "保存设置"}
          </button>
        </div>
      </main>
    </div>
  );
}
