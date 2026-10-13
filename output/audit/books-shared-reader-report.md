# 典籍导读与共享阅读器验收记录

验收日期：2026-10-13。开发基线：`763e0d107b7c59b1a816f310d910f445f9ddf445`。实现包括 EPUB／MOBI 导入、目录校对与不可变版本、默认柏拉图、逐章课堂、三个层次的私人笔记，以及外刊和典籍共用的连续阅读器。

## 环境与应用保护

全部安装、构建、迁移和应用验收均在普通物理副本 `D:/Repo/AniLearn-verification/books-20261013-00001551/app` 进行。副本使用独立依赖、环境文件和 `.next`，没有创建或切换 Git 分支。测试 PostgreSQL 为独立 Compose 项目 `anilearn_books_20261013_00001551`，端口 5547；应用和模拟服务分别为 3107、4107。API 的 SQL fixture 先核对 `current_database() = anilearn_audit_20261007`。

原应用基线为 PID 10052、端口 3000、构建 `RkC-c-TkRX1x6oeG00hAr`，原数据库容器为 `anilearn-postgres-1`。此前多次健康核查正常。实施期间原启动器在本地 08:25 记录了停止应用和数据库；本任务没有执行这项操作，也没有将其重新启动。原 `.next`、依赖、环境文件、数据库和启动器运行文件没有被本任务覆盖；生产迁移和新版启用留待另行安排。

Calibre 9.16 使用独立短路径 `D:/AniLearnTools/books-00001551/Calibre Portable/Calibre/ebook-convert.exe`，配置与转换材料也位于本任务目录。长路径便携安装器的路径错误已修正，没有管理用户其他 Calibre 进程。

## 确定性检查

| 检查 | 结果 |
| --- | --- |
| `npm run books:test` | 43 项通过，含导入、目录完整覆盖、语义文本／UTF-16 锚点、章节状态、上下文限制、幂等提交和真实组件布局恢复回归 |
| `npm run reading:test` | 11 项通过 |
| `npm run math:test` | 16 项通过 |
| `npm run free:test` | 13 项通过，已包含 LLM 适配器检查，无重复执行 `llm:test` |
| `node output/audit/provider-audit.cjs` | 13 组通过 |
| `npm run typecheck`、完整 `npm run lint` | 通过 |
| `npm run build` | 最终隔离生产构建通过 |
| `node output/audit/upgrade-api.mjs` | 完整 30 组通过，含旧请求哈希、成功回放、来源／笔记修订、1.5 MB 以上／1,003 段材料，以及实际测试进程重启和手动恢复 |
| `node output/audit/books-api.mjs` | 完整 10 组通过，含真实 EPUB／MOBI、静默进入、三类笔记、版本隔离、准备锁、重复上传、错误输入、长章实际重启续接、增量迁移重复执行 |

应用修复后重新构建；未改变的既有 API 检查保留有效结果。所有模拟调用使用 dummy credentials。审计脚本会在断言失败时以非零状态结束。

## 真实柏拉图材料

原文件为 `books/Selected Dialogues of Plato.epub`，SHA-256：`fe57ba5bc471550ac502b2256bf4291a011279428523c6f309fbdd8fea8500bb`。按 EPUB 2 的 spine 保留 23 个正文顺序文件，学习单元为 Ion、Protagoras、Phaedrus、Symposium、Apology，卷前／卷后材料另可查看。

正文与全部脚注的非空白字符共 466,598，逐章与原 XHTML 对照一致；254 条旧式脚注全部保留，并逐一检查引用、原段落和回链。脚注数字留在原句中，普通行内锚点作为正文块别名；只有目录边界切分逻辑章节。封面及图片通过内部资源接口读取。

真实 EPUB 经 Calibre 转为 MOBI，再通过产品导入接口转换、校对和发布成功。导入器允许经验证且未向阅读器暴露的 IDPF／Adobe 字体混淆，拒绝正文、图片、未知算法和混合加密。

## 浏览器验收

使用 Playwright CLI 的命名 session `books`，复用隔离应用与数据库，运行 `output/audit/browser-books.js`。桌面为 1366×768，手机视口为 390×844。最终结果及截图保存于 `output/playwright/` 和忽略的审计 JSON 中。

最终浏览器结果：18 项通过，包含 1366×768 和 390×844 截图；报告输出见 `output/playwright/books-browser-run.txt`，关键截图为 `books-desktop.png`、`books-mobile.png`、`books-notes.png` 和 `books-article-target.png`。

用例使用真实原生鼠标选区和滚动；语音以确定性 WAV 模拟，并分别验证并发预取、逆序合成／顺序播放、静音、取消、失败回退和离页资源释放。上传重试保留原生 multipart，仅模拟浏览器收到的成功响应丢失，避免 Playwright `route.fetch` 转发时遗漏文件内容。字体、列宽、导师分栏和临时回看均检查同一文字位置，而非只检查滚动像素。

## 真实教学与语音的限制

原应用公共配置曾显示 Gemini 和 Fish 可用。实际 smoke 时原配置数据库已停止，记录为 `unverified`，没有为测试重新启动原服务。因此本次没有通过真实模型教学质量、绝对无剧透或真人听音验收。模拟测试证明协议、持久化、上下文选取和播放队列行为，不作为上述教学质量的证明。

## 交付

仅整合审查后的源码、依赖声明、增量迁移、内置 EPUB、复用审计脚本与本报告；不整合副本依赖、构建、环境、MOBI 测试材料或运行数据。交付前核对源文件与已测副本一致，执行 `git diff --check`、`codegraph sync`，提交并推送现有 `main`。生产数据库未应用 `docs/migrations/20261013-books-shared-reader.sql`，新版尚未启用。

任务结束时只清理本任务拥有的浏览器、3107／4107 测试进程、独立 Compose 容器与测试卷。保留可复核的验证副本、截图和独立 Calibre 工具。
