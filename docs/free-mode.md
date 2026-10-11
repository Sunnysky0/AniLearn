# 自由提问模式

自由提问提供一个不依赖试卷、外刊或学习计划的一对一课堂。学生先选导师并立即进入课堂；讲解和板书使用简体中文，语音使用日语。课堂可接受最多 4 张图片，每张压缩后最多 2 MiB，单条文字最多 4,000 字。图片只在查看对应消息或恢复模型上下文时读取。

## 页面与操作

- `/free` 显示导师选择、讲解模型状态和最近自由会话。点击「开始提问」幂等创建会话并直达 `/free-classroom/[id]`。
- 新会话使用稳定欢迎请求 ID。成功欢迎后刷新不会再次生成欢迎语；失败或中断的欢迎可手动重试。
- 桌面课堂左侧显示聊天，右侧显示按话题保存的黑板；窄屏以「对话／黑板」切换。
- 会话自动保存。学生可以加载更早消息、重命名或删除会话、查看旧黑板、继续旧话题，并将所有黑板内容导出为 Markdown。
- 告别不表示掌握或课程完成。只有服务端成功结束、NDJSON 正常 EOF 且语音／文字揭示队列空闲后才出现「返回首页」。

## 数据与恢复

| 表 | 内容 |
| --- | --- |
| `free_sessions` | 导师、标题、当前话题、幂等创建请求与欢迎请求 |
| `free_topics` | 会话内稳定顺序、话题标题和 `BoardBlock[]` |
| `free_turns` | 幂等请求 ID、意图、输入指纹、原始请求话题、最终关联话题和状态 |
| `free_messages` | 用户／导师消息、语言、板书记录、日语语音和图片附件 |

学生输入和话题切换均通过自由会话 PostgreSQL advisory lock 序列化。轮次状态为 `running`、`success`、`failed` 或 `cancelled`。重试复用请求 ID 和输入指纹；成功轮次只重放已保存结果。进程异常或浏览器断开不会启动后台续跑，学生刷新后可以点击恢复。最初请求话题单独保存在 `requested_topic_id`，即使模型已新建话题并更新消息归属，也能重建原始输入指纹。

## 接口

自由模式 API 使用 `force-dynamic`，流式轮次返回 NDJSON 并设置 `Cache-Control: no-store`。

| 接口 | 用途 |
| --- | --- |
| `POST /api/free-sessions` | 使用 `{ tutorId, requestId }` 幂等创建空会话，要求 chat 模型可用 |
| `GET /api/free-sessions` | 按最近活动时间返回 20 条历史和游标 |
| `GET/PATCH/DELETE /api/free-sessions/:id` | 加载课堂、重命名／切换当前话题、删除会话 |
| `POST /api/free-sessions/:id/turn` | 欢迎、教学、继续、告别的 NDJSON 轮次 |
| `GET /api/free-sessions/:id/messages?before=:id` | 分页读取更早消息 |
| `GET /api/free-sessions/:id/messages?turn=:id` | 恢复一条失败轮次的原始用户输入 |
| `GET /api/free-sessions/:id/topics/:topicId` | 读取完整话题及黑板 |
| `GET /api/free-sessions/:id/messages/:messageId/attachments/:idx` | 按需读取历史图片 |
| `GET /api/free-sessions/:id/notes` | 按话题顺序下载 Markdown 板书 |

普通教学协议要求先有且仅有一个 `<topic mode="new|keep">`，消息和板书可交错，最后只有一个 `<action>wait|continue</action>`。服务端将 `next`／`finish` 降为 `wait`，拒绝动作后的内容和未闭合标签；欢迎和告别禁止创建话题或板书。外语引用、例句和练习作为独立、带语言标识的消息，不生成 TTS。

## 上下文与客户端行为

使用已配置的 chat 连接和模型。每轮最多取 60 条、动态历史与板书合计最多 60,000 字符；优先当前话题并保留当前用户输入。模型视觉上下文只携带当前输入和最近两条带图的学生消息。自动连续讲解遵循设置默认值，学生可在课堂关闭；每次实际提问后最多自动追加 6 轮。

聊天 NDJSON 接收和语音播放队列独立执行。新输入中断当前播放并保留学生输入顺序；播放期间仍会接收后续事件。静音或没有可用 TTS 时使用文字揭示，不调用 `/api/tts`。公式、粗体和链接沿用现有原子揭示；播放失败回退为文字。离开页面会取消请求和播放并清理本地队列。

## 数据库更新与验证

`src/db/schema.ts` 的变更只增加自由模式表和轮次的 `requested_topic_id` 列，不修改试卷／外刊表，也不删除既有恢复字段。部署前应先审查并同步增量 schema；回退应用时保留这四张表。

实现后的自动化与浏览器检查范围、模拟环境限制记录在[自由提问验证报告](free-mode-validation.md)。

运行自由模式纯逻辑检查：

```powershell
npm run free:test
```

该组测试覆盖输入边界、幂等指纹、流式标签边界、话题／动作约束和当前话题上下文优先级。它不验证真实模型教学质量、Fish Audio 声音或视觉模型质量。
