# 课堂完成修复独立验收

验收日期：2026-11-17。独立验收任务指定模型为 GPT-6.1 Terra，推理强度 Extra High（xhigh）。使用 Windows、Next.js production build、本地 PostgreSQL 和独立 `anilearn_audit_20261007` 数据库；模拟模型使用本地 dummy 凭据，验收结束后删除隔离数据库并停止应用、模拟服务和项目数据库。

验收针对 `main` 基线 `ff45bb37344c0eda8c10d7f5051d559f1c66c3b7` 上的本次最终改动，最终构建包含保留历史确认目标 ID 的合并逻辑。该版本 `src/lib/server/session-completion.ts` 的 SHA-256 为 `dd3588bb433a6d5fbd4842a11b0de0dd8670c1647e246ff2c744f278e39b6045`。

## 结果

- `npm run build`、`npm run typecheck`、`npm run lint`、`git diff --check` 通过。
- `node --import tsx --test src/lib/server/learning-plan.test.ts src/lib/server/tutor-output.test.ts`：7 项通过。覆盖确认目标 ID、扩展目标、多段原文、8192 token、推理强度、伪造/格式/截断和缺失状态。
- `node output/audit/classroom-completion-api.mjs`：14 组通过。覆盖无配置或不可用模型时确认且无模型请求、重复请求、过期版本、失败回滚、历史证据恢复、禁止来源、恢复失败和自动完成守卫。
- `node --import tsx output/audit/classroom-plan-cycle.ts`：实际 `applyPlan` 调用验证旧目标在再次确认后仍保留，新增目标重开进度，撤回新增目标后恢复完成。
- Playwright CLI 运行 `output/audit/browser-confirmation.js`：无模型配置时确认最后一题并刷新保留标记；生成中连点确认仅推进原题。`output/audit/browser-session25.js` 对课堂 25 的隔离副本完成最后一题、刷新并显示本人确认，coverage 哈希不变，确认过程没有模型或 TTS 请求。截图保存在 `output/playwright/classroom-confirmation.png` 和 `output/playwright/classroom-session25-confirmed.png`；后者包含课堂内容，仅供本机查看。

## 真实模型与限制

只读取得课堂 25 的当前模型配置、导师消息和板书，在进程内直接调用 `recoverCoverage`，没有调用用户课堂 turn 或改写用户数据。一次真实调用约 10 秒后返回 `missing`：1 个待检目标、0 个接受目标，未报告技术错误。它说明此次自动恢复未确认该 skills 目标，不能证明讲解语义不足；本人确认路径不依赖该结果。历史日志证明第二次拦截发生输出截断，但没有原始标签日志，不能断定首次拦截的原因。

浏览器未单独模拟音频播放中确认或掉线后重试；服务端重复请求和生成中连点已验证。非连续选讲索引未做独立 fixture 验证；已有回跳未完成题回归通过。30 秒恢复超时未等待实际期限，已验证截断和格式错误不会被误报为缺少讲解。

隔离 fixture 脚本只读用户库并将必要课堂数据写入临时数据库，运行 `output/audit/classroom-completion-copy-fixture.cjs` 前必须确认隔离 runtime 已就绪；不要将课堂截图或内容提交到仓库。
