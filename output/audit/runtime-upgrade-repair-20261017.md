# 运行环境修复记录

2026-10-17 在原工作区 `D:\Repo\AniLearn` 执行日志诊断计划的第 1–4 步。用户指定第 5 步仅运行 typecheck 和完整 lint，其他自动化测试、构建、API 与浏览器验收由用户完成。

数据库升级前已核对 `.env.local` 连接与本项目 Compose 容器、工作目录及 `anilearn_postgres_data` 数据卷一致。目标数据库为 `app_db`，搜索路径为默认的用户 schema 与 `public`。原应用保持停止，仅为备份和迁移临时启动 PostgreSQL。

迁移前确认外刊附件和两阶段导读结构已存在，9 张典籍表及 3 个共享阅读器字段尚不存在。因此只应用 `docs/migrations/20261013-books-shared-reader.sql`，没有重跑先前外刊迁移或使用 schema reset。迁移使用事务、升级操作锁、5 秒锁等待和 60 秒语句超时。

完整备份归档为 `.anilearn/anilearn/backups/2026-10-17T13-29-00-692Z-runtime-upgrade/before.dump`，大小 2,170,721 字节，归档目录可读取。同目录的 `before.json`、`after.json` 保存结构、索引、迁移与备份校验和及数据摘要；这些本地文件由 Git 忽略。

迁移在提交前核对了 18 张原有表。按每张表迁移前的列集合计算行数和排序后的逐行内容摘要，全部保持一致，涵盖设置、导师、试卷、原始来源、课堂快照、聊天、板书、外刊、自由提问和个人笔记。迁移加入 9 张典籍表以及 `reading_sessions.reader_position`、`reading_messages.reader_anchor`、`reading_personal_notes.reader_anchor`。没有初始化默认书籍或发送模型、语音请求。迁移完成后已停止本项目 PostgreSQL，保留原数据卷。

| 变更 | 实现 |
| --- | --- |
| 结构就绪检查 | `src/lib/server/schema-readiness.ts` 从 Drizzle schema 派生全部表、列、非空要求、主键与唯一键要求，由启动器、健康接口和书架共用；使用调用者已有连接执行只读元数据查询 |
| 健康与典籍入口 | 健康接口在结构缺失时返回 `503` 和 `SCHEMA_NOT_READY`，连接失败时返回 `DATABASE_UNAVAILABLE`；典籍书架与列表 API 显示中文升级提示 |
| Docker 冷启动 | 总等待预算为 120 秒，Desktop 启动命令失败或超时后继续探测 Linux 引擎，保留取消、Linux 引擎要求和最终超时；取消时只清理核验过的 Docker CLI 进程 |
| 日志 | 命令失败记录命令类别、阶段、耗时和退出状态；显式记录错误级别，并识别超时；应用 ORM 查询及多行参数在写入日志前过滤，保留数据库错误码与应用错误标识；重载历史日志时也过滤 ORM 载荷 |

最终版本的 `npm run typecheck` 与完整 `npm run lint` 均通过。不新增或运行测试套件，不进行生产构建、生命周期测试、API 或浏览器验收。实际功能、冷启动、取消和恢复流程的验收由用户完成。

2026-10-17 用户确认验收通过，授权将本轮改动提交并推送到现有 `main`。
