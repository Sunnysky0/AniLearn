"use client";

import { Children, cloneElement, isValidElement, useId, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, Mic, Play, Save, Search, Square, Trash2, Upload, UserRound } from "lucide-react";
import { fileToJpegDataUrl } from "@/lib/client/media";
import {
  DEFAULT_TUTOR_AVATAR,
  DEFAULT_VOICE_ID,
  type TutorDTO,
  type TutorInput,
  type VoiceItem,
} from "@/lib/types";

const AVATARS = [DEFAULT_TUTOR_AVATAR, "/avatars/rin.png", "/avatars/kurisu.png", "/avatars/artoria.png"];

const PERSONALITY_PRESETS = [
  { label: "温柔耐心", text: "温柔耐心、亲切细腻，善于鼓励学生。学生答错时先肯定思路中的亮点，再温和地指出问题。" },
  { label: "严谨理性", text: "冷静理性、一丝不苟，说话简洁直接，对概念的严谨性要求很高，但内心非常关心学生。" },
  { label: "幽默风趣", text: "阳光开朗、幽默风趣，喜欢用生活中的例子和小段子活跃气氛，充满正能量。" },
  { label: "元气活泼", text: "元气满满、活泼可爱，热情感性，善于共情，对学生的每一点进步都真诚夸奖。" },
  { label: "傲娇毒舌", text: "有点傲娇、偶尔毒舌，嘴上嫌弃“这都不会”，但讲解时极其认真负责，学生进步时会别扭地夸奖。" },
  { label: "沉稳学者", text: "沉稳博学、温文尔雅，喜欢讲知识背后的来龙去脉与思想方法，引导学生体会学科之美。" },
];

const STYLE_PRESETS = [
  {
    label: "苏格拉底启发",
    text: "苏格拉底式启发教学：先提问引导学生思考，再逐步揭示解题思路；每讲完一个关键步骤都确认学生是否理解。",
  },
  {
    label: "结构化精讲",
    text: "结构化精讲：先建立解题框架与模型，再规范推导；强调解题模板与规范书写，总结同类题型的通法。",
  },
  { label: "情境联想", text: "情境联想教学：把抽象知识与生活现象联系起来，用口诀和记忆技巧帮助记忆，讲题节奏明快。" },
  {
    label: "实战提分",
    text: "实战提分导向：聚焦高考得分点与答题规范，讲完一道题立刻总结秒杀技巧和同类变式，强调考场策略。",
  },
  { label: "错因诊断", text: "错因诊断式：先让学生暴露思路，精准定位知识漏洞和思维误区，再对症下药、查漏补缺。" },
];

const VOICE_TAGS = [
  "[優しく穏やかな口調]",
  "[明るく元気な口調]",
  "[落ち着いたクールな口調]",
  "[可愛らしく弾んだ口調]",
  "[知的で丁寧な口調]",
  "[ツンデレっぽく]",
];

const EMPTY: TutorInput = {
  name: "",
  avatar: AVATARS[0],
  tags: [],
  tagline: "",
  personality: PERSONALITY_PRESETS[0].text,
  teachingStyle: STYLE_PRESETS[0].text,
  speakingStyle: "",
  voiceId: DEFAULT_VOICE_ID,
  voiceName: "默认声线",
  voiceStyle: VOICE_TAGS[0],
  greeting: "",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useId();
  const controls = Children.map(children, (child) => {
    if (!isValidElement(child) || !["input", "textarea", "select"].includes(String(child.type))) return child;
    return cloneElement(child as ReactElement<{ id?: string; "aria-describedby"?: string }>, {
      id,
      "aria-describedby": hint ? `${id}-hint` : undefined,
    });
  });
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold text-neutral-700">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-neutral-500">
          {hint}
        </p>
      )}
      <div className="mt-2">{controls}</div>
    </div>
  );
}

const inputCls = "w-full  border border-neutral-200 bg-white px-3.5 py-2.5 text-sm outline-none transition   ";

export default function TutorEditor({ initial, ttsReady }: { initial: TutorDTO | null; ttsReady: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState<TutorInput>(() => {
    if (!initial) return EMPTY;
    const { id: _id, isPreset: _p, ...rest } = initial;
    void _id;
    void _p;
    return rest;
  });
  const [tagsText, setTagsText] = useState((initial?.tags ?? EMPTY.tags).join("、"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState("ja");
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof TutorInput>(k: K, v: TutorInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  function parseTags(s: string) {
    return s
      .split(/[、,，|｜\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { ...form, tags: parseTags(tagsText) };
      const r = await fetch(initial ? `/api/tutors/${initial.id}` : "/api/tutors", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "保存失败");
      router.push("/tutors");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function remove() {
    if (!initial || !confirm(`确定删除导师「${initial.name}」吗？与其相关的课堂记录也会被删除。`)) return;
    await fetch(`/api/tutors/${initial.id}`, { method: "DELETE" });
    router.push("/tutors");
    router.refresh();
  }

  async function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      set("avatar", await fileToJpegDataUrl(f, 512, 0.9));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function searchVoices(mine = false) {
    setVoiceLoading(true);
    setVoiceError(null);
    try {
      const params = new URLSearchParams({ q: query, lang, ...(mine ? { mine: "1" } : {}) });
      const r = await fetch(`/api/voices?${params.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "搜索失败");
      setVoices(j.items as VoiceItem[]);
      if (!j.items.length) setVoiceError("没有找到匹配的声音，换个关键词试试。");
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoiceLoading(false);
    }
  }

  function stopAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  }

  async function preview(voiceId: string, key: string, sample?: string | null) {
    if (playing === key) return stopAudio();
    stopAudio();
    setPlaying(key);
    try {
      let src = sample ?? "";
      if (!src) {
        const text = `${form.voiceStyle || ""} こんにちは！${form.name || "先生"}です。今日も一緒に、一問ずつ丁寧に頑張りましょうね。`;
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          throw new Error(j?.error || "语音合成失败");
        }
        src = URL.createObjectURL(await r.blob());
      }
      const a = new Audio(src);
      audioRef.current = a;
      a.onended = () => setPlaying(null);
      await a.play();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : String(e));
      setPlaying(null);
    }
  }

  const tags = parseTags(tagsText);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Link href="/tutors" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800">
        <ArrowLeft className="h-4 w-4" /> 我的导师
      </Link>
      <h1 className="mt-2 text-[32px] font-bold text-neutral-900">
        {initial ? `编辑导师 · ${initial.name}` : "创建新导师"}
      </h1>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section className="space-y-5 border-t-2 border-neutral-900 py-6">
            <h2 className="font-bold text-neutral-800">基本信息</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="导师名字">
                <input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="如：艾琳"
                  className={inputCls}
                />
              </Field>
              <Field label="标签" hint="用顿号或逗号分隔，最多 6 个">
                <input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="数学、逻辑、你的学习伙伴"
                  className={inputCls}
                />
              </Field>
              <Field label="一句话简介">
                <input
                  value={form.tagline}
                  onChange={(e) => set("tagline", e.target.value)}
                  placeholder="温柔耐心的数学导师"
                  className={inputCls}
                />
              </Field>
            </div>
          </section>

          <section className="space-y-4 border-t-2 border-neutral-900 py-6">
            <h2 className="font-bold text-neutral-800">形象</h2>
            <div className="flex flex-wrap items-center gap-4">
              {AVATARS.map((a) => (
                <button
                  key={a}
                  onClick={() => set("avatar", a)}
                  className={`relative border-2 transition ${form.avatar === a ? "border-neutral-900" : "border-transparent hover:border-neutral-900"}`}
                  title={`选择导师形象 ${AVATARS.indexOf(a) + 1}`}
                  aria-pressed={form.avatar === a}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a} alt="" className="h-20 w-20 object-cover" />
                  {form.avatar === a && (
                    <span className="absolute -right-1 -top-1 bg-neutral-900 p-1 text-white">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              ))}
              <button
                onClick={() => fileRef.current?.click()}
                className="flex h-20 w-20 flex-col items-center justify-center border-2 border-dashed border-neutral-300 text-xs text-neutral-500 hover:border-neutral-900 hover:text-neutral-800"
              >
                <Upload className="h-5 w-5" />
                上传
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarFile} />
              {form.avatar.startsWith("data:") && (
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.avatar} alt="" className="h-20 w-20 object-cover border-2 border-neutral-900" />
                  自定义形象
                </div>
              )}
            </div>
          </section>

          <section className="space-y-5 border-t-2 border-neutral-900 py-6">
            <h2 className="font-bold text-neutral-800">性格与教学</h2>
            <Field label="性格" hint="决定导师和你交流时的态度与情绪">
              <div className="mb-2 flex flex-wrap gap-2">
                {PERSONALITY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => set("personality", p.text)}
                    className="bg-neutral-100 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <textarea
                value={form.personality}
                onChange={(e) => set("personality", e.target.value)}
                rows={3}
                className={inputCls}
              />
            </Field>
            <Field label="教学风格" hint="决定导师如何讲题、如何引导你思考">
              <div className="mb-2 flex flex-wrap gap-2">
                {STYLE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => set("teachingStyle", p.text)}
                    className="bg-neutral-100 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <textarea
                value={form.teachingStyle}
                onChange={(e) => set("teachingStyle", e.target.value)}
                rows={3}
                className={inputCls}
              />
            </Field>
            <Field label="说话风格 / 口头禅">
              <input
                value={form.speakingStyle}
                onChange={(e) => set("speakingStyle", e.target.value)}
                placeholder="如：常说“我们一起来看看”"
                className={inputCls}
              />
            </Field>
            <Field label="开场白">
              <input
                value={form.greeting}
                onChange={(e) => set("greeting", e.target.value)}
                placeholder="你好呀，今天我们一起把这张卷子吃透吧！"
                className={inputCls}
              />
            </Field>
          </section>

          <section className="space-y-5 border-t-2 border-neutral-900 py-6">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-bold text-neutral-800">
                <Mic className="h-5 w-5 text-neutral-800" /> 声音（Fish Audio · 日语播报）
              </h2>
              {!ttsReady && (
                <Link href="/settings" className="text-xs text-neutral-800 hover:underline">
                  未配置 Fish Audio API Key →
                </Link>
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="声音 ID（reference_id）">
                <input
                  value={form.voiceId}
                  onChange={(e) => set("voiceId", e.target.value)}
                  placeholder={DEFAULT_VOICE_ID}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <Field label="声音名称">
                <input value={form.voiceName} onChange={(e) => set("voiceName", e.target.value)} className={inputCls} />
              </Field>
            </div>
            <Field label="语气标签" hint="Fish Audio S2 支持用方括号描述语气，导师每句话都会以此为基调">
              <div className="mb-2 flex flex-wrap gap-2">
                {VOICE_TAGS.map((t) => (
                  <button
                    key={t}
                    onClick={() => set("voiceStyle", t)}
                    className={` px-3 py-1 text-xs ${form.voiceStyle === t ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-100"}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <input value={form.voiceStyle} onChange={(e) => set("voiceStyle", e.target.value)} className={inputCls} />
            </Field>
            <button
              onClick={() => void preview(form.voiceId || DEFAULT_VOICE_ID, "current")}
              disabled={!ttsReady}
              className="inline-flex items-center gap-2 bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {playing === "current" ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />} 试听当前声音
            </button>

            <div className="bg-neutral-50 p-4">
              <div className="text-sm font-semibold text-neutral-700">从 Fish Audio 声音库挑选</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void searchVoices()}
                  placeholder="关键词，如：お姉さん、少女、先生"
                  className={`${inputCls} min-w-[180px] flex-1`}
                />
                <select value={lang} onChange={(e) => setLang(e.target.value)} className={`${inputCls} w-28`}>
                  <option value="ja">日语</option>
                  <option value="zh">中文</option>
                  <option value="en">英语</option>
                  <option value="all">全部</option>
                </select>
                <button
                  onClick={() => void searchVoices()}
                  disabled={!ttsReady || voiceLoading}
                  className="inline-flex items-center gap-1.5 bg-neutral-800 px-4 text-sm text-white disabled:opacity-40"
                >
                  {voiceLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} 搜索
                </button>
                <button
                  onClick={() => void searchVoices(true)}
                  disabled={!ttsReady || voiceLoading}
                  className="bg-white px-3 text-sm text-neutral-600 border border-neutral-200 disabled:opacity-40"
                >
                  我的声音
                </button>
              </div>
              {voiceError && <div className="mt-3 text-xs text-neutral-800">{voiceError}</div>}
              {voices.length > 0 && (
                <div className="mt-4 grid max-h-96 gap-2 overflow-y-auto thin-scroll sm:grid-cols-2">
                  {voices.map((v) => (
                    <div
                      key={v.id}
                      className={`flex items-center gap-3  bg-white p-2.5 border ${form.voiceId === v.id ? "border-neutral-900" : "border-neutral-200"}`}
                    >
                      {v.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.cover} alt="" className="h-11 w-11 shrink-0 object-cover" />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center bg-neutral-100 text-neutral-500">
                          <UserRound className="h-5 w-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-sm font-medium text-neutral-800">{v.title}</div>
                        <div className="line-clamp-1 text-[11px] text-neutral-500">
                          {v.author} · {v.uses.toLocaleString()} 次使用 · {v.languages.join("/")}
                        </div>
                      </div>
                      <button
                        onClick={() => void preview(v.id, v.id, v.sample)}
                        className="p-1.5 text-neutral-500 hover:bg-neutral-100"
                        title="试听"
                      >
                        {playing === v.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => setForm((f) => ({ ...f, voiceId: v.id, voiceName: v.title }))}
                        className="bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
                      >
                        使用
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-24">
          <div className="overflow-hidden bg-white border border-neutral-200/70">
            <div className="bg-neutral-900 px-5 py-3 text-xs text-neutral-200">实时预览</div>
            <div className="space-y-4 bg-[#fafafa] p-5">
              <div className="flex items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={form.avatar} alt="" className="h-20 w-20 object-cover border-2 border-neutral-100" />
                <div>
                  <div className="flex items-center gap-2 text-lg font-bold text-neutral-800">
                    {form.name || "未命名"}
                  </div>
                  <div className="text-sm text-neutral-500">{tags.join(" | ")}</div>
                </div>
              </div>
              <div className="flex gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={form.avatar} alt="" className="h-9 w-9 object-cover" />
                <div className="border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-700">
                  {form.greeting || "你好！今天我们一起把这张卷子吃透吧～"}
                </div>
              </div>
              <div className="flex justify-end">
                <div className="border border-neutral-300 bg-neutral-100 px-4 py-2.5 text-sm text-neutral-900">
                  好的老师，我准备好了！
                </div>
              </div>
              <div className="bg-white/70 p-3 text-xs leading-relaxed text-neutral-500">
                <div>
                  <b className="text-neutral-600">性格</b>：{form.personality || "—"}
                </div>
                <div className="mt-1">
                  <b className="text-neutral-600">风格</b>：{form.teachingStyle || "—"}
                </div>
                <div className="mt-1">
                  <b className="text-neutral-600">语气</b>：{form.voiceStyle || "—"}
                </div>
              </div>
            </div>
          </div>
          {error && <div className="bg-neutral-100 p-3 text-sm text-neutral-800">{error}</div>}
          <button
            onClick={save}
            disabled={saving || !form.name.trim()}
            className="flex w-full items-center justify-center gap-2 bg-neutral-900 py-3 font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />} 保存导师
          </button>
          {initial && (
            <button
              onClick={remove}
              className="flex w-full items-center justify-center gap-2 py-2.5 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <Trash2 className="h-4 w-4" /> 删除导师
            </button>
          )}
        </aside>
      </div>
    </main>
  );
}
