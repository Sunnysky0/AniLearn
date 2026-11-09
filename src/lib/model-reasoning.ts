import type { ConnectionProtocol, ModelReasoning, ReasoningEffort } from "./types";

const EFFORTS: Record<ConnectionProtocol, readonly ReasoningEffort[]> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  "openai-compatible": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  xai: ["low", "medium", "high", "xhigh"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["minimal", "low", "medium", "high"],
};

export function reasoningControl(protocol: ConnectionProtocol, model: string): "effort" | "budget" | "unsupported" {
  if (protocol !== "gemini") return "effort";
  const name = model.trim().replace(/^models\//, "").toLowerCase();
  if (/^gemini-2\.5(?:-|$)/.test(name)) return "budget";
  if (/^gemini-(?:[3-9]|\d{2,})(?:[.\-]|$)/.test(name)) return "effort";
  return "unsupported";
}

export function reasoningEfforts(protocol: ConnectionProtocol): readonly ReasoningEffort[] {
  return EFFORTS[protocol];
}

export function geminiBudgetLimits(model: string): { min: number; max?: number; canDisable: boolean } {
  const name = model.trim().replace(/^models\//, "").toLowerCase();
  if (/^gemini-2\.5-pro(?:-|$)/.test(name)) return { min: 128, max: 32768, canDisable: false };
  if (/^gemini-2\.5-flash-lite(?:-|$)/.test(name)) return { min: 512, max: 24576, canDisable: true };
  if (/^gemini-2\.5-flash(?:-|$)/.test(name)) return { min: 1, max: 24576, canDisable: true };
  return { min: 1, canDisable: false };
}

export function reasoningError(reasoning: unknown, protocol: ConnectionProtocol, model: string): string | null {
  if (reasoning === undefined) return null;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return "推理设置格式无效。";
  const value = reasoning as Partial<ModelReasoning>;
  const control = reasoningControl(protocol, model);
  if (value.kind === "effort") {
    if (Object.keys(value).some((key) => key !== "kind" && key !== "level") ||
      typeof value.level !== "string" || !reasoningEfforts(protocol).includes(value.level as ReasoningEffort))
      return "推理强度档位无效。";
    if (control !== "effort") return "当前 Gemini 模型不支持强度档位，请使用思考预算或模型默认值。";
    return null;
  }
  if (value.kind === "budget") {
    if (Object.keys(value).some((key) => key !== "kind" && key !== "tokens") ||
      typeof value.tokens !== "number" || !Number.isSafeInteger(value.tokens)) return "思考预算必须是整数。";
    if (control !== "budget") return "只有 Gemini 2.5 模型支持思考预算。";
    const { min, max, canDisable } = geminiBudgetLimits(model);
    const valid = value.tokens === -1 || (canDisable && value.tokens === 0) ||
      (value.tokens >= min && (max === undefined || value.tokens <= max));
    return valid ? null : "当前 Gemini 模型的思考预算须为 -1" + (canDisable ? "、0" : "") + " 或 " +
      (max === undefined ? "正整数；未知型号的范围请通过模型测试确认" : min + "–" + max) + "。";
  }
  return "推理设置类型无效。";
}
