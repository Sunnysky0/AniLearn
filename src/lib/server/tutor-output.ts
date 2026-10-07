import { hasJapaneseText, isJapaneseSpeech, splitShortMessages, withSpeechStyle } from "@/lib/text";
import { COVERAGE_TOPICS, type CoverageTopic, type TeachingCoverage } from "@/lib/types";
import { complete, type LLMConfig } from "./llm";
import { createTagParser, innerTag } from "./protocol";
import { tutorSpeechRules } from "./prompts";

export async function prepareTutorMessages(cfg: LLMConfig, zh: string, ja: string, signal: AbortSignal, voiceStyle = "") {
  const chunks = splitShortMessages(zh);
  if (!chunks.length) throw new Error("模型没有返回有效消息，请重试。");
  if (chunks.length === 1 && !hasJapaneseText(zh) && isJapaneseSpeech(ja)) {
    return [{ zh: zh.trim(), ja: withSpeechStyle(ja, voiceStyle) }];
  }
  const fallback = () => chunks.map((chunk) => ({ zh: chunk, ja: "" }));
  let raw: string;
  try {
  raw = await complete(cfg, {
    system: `[MESSAGE_REPAIR] 修复导师消息。不要回答学生的新问题，不增加教学进度。
将用户提供的内容整理为多条简体中文短消息，每条不超过 80 字，保持公式、答案与教学含义。
若用户提供的消息已经是中文短句，必须逐字保留每条中文。
每条消息配一段自然日语语音，不含中文、Markdown 或 LaTeX；数学公式改为日语读法。
原语音台本只作语音风格参考；保留其中有效且符合语境的情绪、强调和停顿标签，分拆后每条语音仍须有句首标签。原标签无效时按中文含义重新选择。
${tutorSpeechRules(voiceStyle)}
只输出 <msg><zh>中文短消息</zh><ja>日语语音</ja></msg>，不得输出 action、board 或 covered。`,
    messages: [{ role: "user", content: chunks.map((chunk) => `<zh>${chunk}</zh>`).join("\n") + `\n<original_speech>${ja}</original_speech>` }],
    maxTokens: 8192, signal,
  });
  } catch (e) {
    if (signal.aborted || hasJapaneseText(zh)) throw e;
    return fallback();
  }
  const parser = createTagParser(["msg"]);
  const blocks = [...parser.push(raw), ...parser.end()];
  const repaired = blocks.map((b) => ({ zh: innerTag(b.body, "zh") || "", ja: innerTag(b.body, "ja") || "" }));
  if (!blocks.length || blocks.some((b) => !b.closed) || repaired.some((m) =>
    !m.zh || hasJapaneseText(m.zh) || !isJapaneseSpeech(m.ja) || splitShortMessages(m.zh).length !== 1)) {
    if (hasJapaneseText(zh)) throw new Error("导师消息语言不正确，修复失败，请重试。");
    // Preserve all Chinese content, but never synthesize an invalid speech script.
    return fallback();
  }
  if (!hasJapaneseText(zh) && repaired.map((m) => m.zh).join("") !== chunks.join("")) {
    return fallback();
  }
  return repaired.map((m) => ({ ...m, ja: withSpeechStyle(m.ja, voiceStyle) }));
}

export function acceptCoverage(coverage: TeachingCoverage, topic: string, quote: string, taught: string[]) {
  const compact = (s: string) => s.replace(/\s/g, "");
  const evidence = compact(quote);
  if (!COVERAGE_TOPICS.includes(topic as CoverageTopic) || evidence.length < 6 ||
    !taught.some((s) => compact(s).includes(evidence))) return;
  coverage[topic as CoverageTopic] = quote;
}
