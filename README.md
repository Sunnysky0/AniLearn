# AniLearn

高考试卷驱动的 AI 一对一辅导平台，使用 Next.js、Drizzle 和 PostgreSQL。

## 本机启动（Windows / Docker Desktop）

1. 启动 Docker Desktop，使用 Linux 容器。
2. 安装依赖：`npm install`。
3. 首次配置时，复制环境变量模板：

   ```powershell
   Copy-Item .env.example .env.local
   ```

   将 `.env.local` 中的 `POSTGRES_PASSWORD` 替换为随机十六进制密码。`DATABASE_URL` 会自动使用同一文件中的用户名、密码、端口和数据库名。已经配置好的 `.env.local` 无需重新复制。

4. 启动数据库并等待就绪，然后创建本地数据库表：

   ```powershell
   npm run db:up
   npm run db:push
   ```

5. 启动开发服务：

   ```powershell
   npm run dev
   ```

   打开 http://localhost:3000。首次访问会自动创建预设导师。模型和 Fish Audio API 密钥在「设置」中填写。

默认导师为《少女与战车》中的大吉岭，Fish Audio 声音 ID 为 `db1553e441c84b49bf250912563ec8fc`，语音使用日语。旧版预设艾琳会更新为大吉岭并保留原导师 ID，已有课堂仍能关联到她。其他导师可在「我的导师」中编辑。

若服务器无法直连 Fish Audio，可在「设置」的语音区域填写 HTTP/HTTPS 代理地址，例如 `http://127.0.0.1:18081`。代理只用于 Fish 语音合成与声音搜索，保存后立即生效；Windows 系统代理不会自动应用到服务器请求。代理地址留空保留现有配置，点击旁边的「清除」恢复直连。地址可包含代理用户名和密码，页面仅返回脱敏预览；无需数据库迁移。「保存并试听」每次重新合成，用于验证最新配置；失败时分别提示连接、密钥、余额和限流等原因。

物理预设导师为《Fate/stay night》中的远坂凛，Fish Audio 声音 ID 为 `0efe389bb7b544c690da2fbeee0831d8`。旧版预设凛会更新为远坂凛并保留原导师 ID。

## 图片资源

四位预设导师的头像保存在 `public/avatars/`，首页课堂插画保存在 `public/images/hero.jpg`。这些图片随项目一起部署。

生成模型为 `gpt-image-2.5-sunburst`（接口中的正式名称）。大吉岭的头像和首页插画以 `025_darjeeling.webp` 为人物参考，保留参考图的发型、校服和茶杯特征。完整提示词保存在 `output/imagegen/prompts.json`，原始图片保存在同一目录，网页资源清单保存在 `output/imagegen/assets.json`。网页头像使用压缩后的 512 × 512 PNG，首页插画使用 JPEG。重新生成时，图片接口地址和密钥分别通过 `.env.local` 的 `IMAGE_GENERATION_BASE_URL` 和 `IMAGE_GENERATION_API_KEY` 配置。

## 生产构建

```powershell
npm run typecheck
npm run lint
npm run build
npm run start
```

Next.js 在构建收集路由时会加载数据库模块，因此构建环境也必须提供 `DATABASE_URL`。本机使用项目根目录的 `.env.local`；远程构建和部署环境应分别配置指向相应数据库的 `DATABASE_URL`。`drizzle.config.ts` 也读取 Next.js 环境文件，应用和建表工具共享连接配置。

`DATABASE_URL` 仅供服务端使用。`.env.local` 包含本机数据库密码，已加入 `.gitignore`。

## 试卷解析与课堂恢复

单份试卷最多 12 页。超过限制的 PDF 会提示实际页数，需要拆分后上传，不会只取前几页。

支持图片、PDF、Markdown（`.md` / `.markdown`）和 LaTeX（`.tex`）试卷，也可混合上传并调整顺序。每个文本文件作为一个来源页，最多 1.5 MB，须使用 UTF-8 编码。原文保存在现有页面表中，无需数据库迁移；分析模型直接读取原文，保留公式与宏定义。Markdown 预览渲染文字与公式，LaTeX 预览显示源码，不编译或执行 TeX。外部图片及 `\input` / `\include` 依赖不会自动读取，应在文本中提供必要内容或另行上传相关图片。

解析先建立完整题目清单，再逐题生成答案、解法、关键点、教材知识点和方法。只有全部题目通过完整性校验，试卷才能开始新课堂。失败时保留已完成的解析，点击「继续解析」可从未完成的题目接着处理；旁边的重新扫描按钮可从头开始。服务重启后也可继续解析，但不会自动重启任务。逐题解析比单次生成需要更多模型请求。

课堂保存开课时的题目快照，重新解析试卷不会改变旧课堂的聊天、板书和题目对应关系。课程只有在解法、知识点、方法、易错点都有实际讲解记录，且所有题目完成后，才会显示整卷学完。讲解记录校验可以拦截错误的进度动作，不能替代答案、教材出处或教学质量的人工验收。

点击“我懂了，下一题”会核验四项讲解记录；模型漏记时，从本题已保存的导师消息和板书核对原文，不必重讲。点击“就到这里吧，再见”只结束本次交流，保留未完成进度；告别文字和语音结束后，“返回首页”启用。失败或停止时可重试，下一次仍可继续课堂。

静音时直接显示文字，不调用 Fish Audio。语音等待超时或失败会回退到文字；明显的语言或长段落问题会尝试修复，语音脚本不合格时不会播放。中日语言验证采用规则检查，音频与中文按消息播放比例同步，尚不支持逐词对齐。

课堂情感标签使用 Fish Audio S2/S2.1 方括号语法：每条可播放语音以一个主要情绪或导师基础语气标签开头，正文为日语。既支持 `[calm]`、`[curious]` 等英文标签，也支持日语自然语言描述；消息修复会参考原标签，缺少句首标签时补导师语气。完整的位置、组合、音效与旧版 S1 区别见 [TTS 情感标签规范](docs/tts-emotion-tags.md)。

此次修复新增 `papers.analysis_draft`、`sessions.snapshot` 和 `sessions.coverage`。本机数据库已同步；在其他环境运行新版前，需要同步数据库结构。

## 数据库管理

| 命令 | 用途 |
| --- | --- |
| `npm run db:up` | 启动 PostgreSQL，等待健康检查通过 |
| `npm run db:status` | 查看容器状态及端口 |
| `npm run db:down` | 停止并移除容器，保留数据库数据卷 |
| `npm run db:push` | 将 `src/db/schema.ts` 同步到本地数据库 |

PostgreSQL 16 只监听本机 `127.0.0.1`，默认端口为 `5432`，数据库名为 `app_db`，用户名为 `anilearn`。端口可通过 `.env.local` 中的 `POSTGRES_PORT` 修改。数据保存在 Docker 命名卷 `anilearn_postgres_data` 中，容器重建后仍然保留。

用户名、密码和数据库名在数据卷首次初始化时生效；以后修改环境变量不会自动修改数据库内已有的账户。`db:push` 用于本地开发，已有数据的部署环境应先审查数据库结构变更。
