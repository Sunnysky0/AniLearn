"use client";

import { geminiBudgetLimits, reasoningControl, reasoningEfforts } from "@/lib/model-reasoning";
import type { ConnectionProtocol, ModelReasoning, ReasoningEffort } from "@/lib/types";

const input = "w-full border border-neutral-300 bg-white px-3 py-2 text-sm";
const names: Record<ReasoningEffort, string> = {
  none: "关闭（none）", minimal: "极低（minimal）", low: "低（low）", medium: "中（medium）",
  high: "高（high）", xhigh: "极高（xhigh）", max: "最高（max）",
};

export default function ReasoningSettings({ purpose, protocol, model, value, onChange }: {
  purpose: "chat" | "analysis";
  protocol: ConnectionProtocol;
  model: string;
  value?: ModelReasoning;
  onChange: (value: ModelReasoning | undefined) => void;
}) {
  const control = reasoningControl(protocol, model);
  if (control === "unsupported") return <p className="text-xs text-neutral-500">
    当前 Gemini 模型没有可用的推理强度设置，将使用模型默认值。
  </p>;

  if (control === "effort") {
    const levels = reasoningEfforts(protocol);
    return <div>
      <label className="text-sm">推理强度
        <select aria-label={purpose + "推理强度"} className={input + " mt-1"}
          value={value?.kind === "effort" ? value.level : ""}
          onChange={(event) => onChange(event.target.value ? { kind: "effort", level: event.target.value as ReasoningEffort } : undefined)}>
          <option value="">模型默认</option>
          {levels.map((level) => <option key={level} value={level}>{names[level]}</option>)}
        </select>
      </label>
      <p className="mt-1 text-xs text-neutral-500">各模型支持的档位不同；不支持的设置会在模型测试中显示接口错误。</p>
    </div>;
  }

  const { min, max, canDisable } = geminiBudgetLimits(model);
  const budget = value?.kind === "budget" ? value.tokens : undefined;
  const selected = budget === undefined ? "" : budget === -1 ? "dynamic" : budget === 0 ? "off" : "custom";
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">思考预算
      <select aria-label={purpose + "思考预算模式"} className={input + " mt-1"} value={selected}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "dynamic" ? { kind: "budget", tokens: -1 } :
            next === "off" ? { kind: "budget", tokens: 0 } :
              next === "custom" ? { kind: "budget", tokens: min } : undefined);
        }}>
        <option value="">模型默认</option>
        <option value="dynamic">动态思考（-1）</option>
        {canDisable && <option value="off">关闭思考（0）</option>}
        <option value="custom">自定义 token 数</option>
      </select>
    </label>
    {selected === "custom" && <label className="text-sm">思考 token 数
      <input aria-label={purpose + "思考预算 token"} className={input + " mt-1"} type="number" step="1"
        min={min} max={max} value={Number.isFinite(budget) ? budget : ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : { kind: "budget", tokens: Number(event.target.value) })} />
    </label>}
    <p className="text-xs text-neutral-500 sm:col-span-2">留空使用模型默认；{max === undefined ? "未知型号的预算范围请通过模型测试确认" : `自定义范围为 ${min}–${max} token`}。预算和强度档位不会同时发送。</p>
  </div>;
}
