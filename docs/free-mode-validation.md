# 自由提问模式验证记录

验证日期：2026-10-10。所有 API 与浏览器模型响应均使用隔离审计数据库和本地模拟服务。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过；包含全部自由模式页面和 API 路由 |
| `npm run free:test` | 通过；输入、上下文预算、流式协议和话题约束 |
| `npm run free:audit` | 通过；创建幂等、欢迎重放、话题分页、附件访问、重试恢复、笔记导出、告别和删除 |
| `node output/audit/fix-api.mjs` | 通过 18 组试卷、课堂、计划、并发锁和语言／语音协议回归 |
| `npm run math:test` | 通过 16 项 |
| `npm run google-docs:test` | 通过 9 项 |
| `npm run launcher:test` | 通过 12 项 |
| `node output/audit/provider-audit.cjs` | Provider 流、截断拒绝、标签解析和原子揭示检查全部通过 |
| `git diff --check` | 通过 |

## 浏览器检查

使用真实浏览器打开最新生产构建，完成以下流程：从导师选择页直接创建课堂；确认仅显示一次欢迎；提交文字问题；追问后仍使用原话题页；明确换题后创建新页；刷新后恢复聊天和板书；结束交流后显示返回首页。390px 手机视口提供对话／黑板切换且无横向溢出；桌面导师选择页已目视检查。

- [手机课堂截图](../output/playwright/free-mode-mobile.png)
- [桌面导师选择截图](../output/playwright/free-mode-desktop.png)

## 验证边界

审计模型和语音均为模拟环境。本轮未配置真实模型密钥或 Fish Audio，因此不代表真实教学质量、视觉识别、声音生成或音画同步通过验收。数据库 schema 已通过现有 `db:push` 增量同步方式应用；本轮没有部署线上服务。
