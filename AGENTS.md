<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

# AniLearn

AI one-to-one tutor platform for exam learning, English/Japanese article reading and chapter-based book reading. Exam materials get a complete directory and plan-selected analysis, then a streaming classroom: chat on the left, blackboard on the right, Japanese TTS in sync with Chinese text.

Built as a Next.js App Router app (React 19, Tailwind 4, Drizzle + PostgreSQL). Created by Claude Opus 5.5.

## Product charter

- **EPDL (Exam Paper Driven Learning).** The paper supplies a complete stable inventory. Five paces select representative problems and concrete goals before detailed analysis. Default pace is 纲举目张; only 条分缕析 and legacy sessions require all problems and all four core topics.
- **Readings.** Independent English/Japanese articles, unlimited source pages, background per-page OCR, paginated source review, and two-stage sessions: silent free reading with user-initiated questions/notes, followed by guided whole-article analysis. OCR and long-article context preparation resume from saved work after failure or restart. User notes stay separate from tutor analysis. Chinese explanation and labeled foreign quotes/examples are separate content types; speech remains Japanese.
- **Books.** EPUB/MOBI import, corrected logical chapters and immutable versions. Built-in Selected Dialogues of Plato initializes without model/TTS requests. Silent reading precedes user-confirmed chapter analysis; every focus requires explicit confirmation. All main chapters read unlocks an optional whole-book summary. Annotations, chapter notes and book notes are shared per content version; chat and learning progress remain per tutor session. Preparation and imports save checkpoints and resume manually after failure/restart.
- **Shared reader.** Articles and books use `ReaderDocument`, UTF-16 text anchors and character positions with viewport pagination. Books paginate each chapter and retain chapter navigation. `Reader` owns typography, native selection, search, annotations, footnotes and temporary inspection; `ReadingWorkspace` owns desktop tutor resizing/collapse and the mobile discussion panel. Resume positions and named bookmarks are shared per immutable content version, independently of classroom teaching state; books also retain each chapter's position. Never replace resume positions during inspection or let layout changes move the saved character anchor. Old article selections, snapshots and request hashes remain compatible when optional new fields are omitted.
- **Custom tutors.** Personality, teaching style, speaking style, avatar, greeting, and Fish Audio voice (`voiceId` + Japanese `voiceStyle` tag). Every tutor can teach every subject; the database subject column is retained only for compatibility.
- **Models.** OpenAI / Anthropic / Grok (xAI) / Gemini, via API. No vendor SDKs — raw `fetch` + SSE in `src/lib/server/llm.ts`.
- **Voice.** Fish Audio TTS (`s2.1-pro`). Chat and board are Chinese; spoken audio is Japanese. Text in the chat bubble reveals in sync with playback.
- **Short messages.** The tutor sends 2–6 short bubbles per turn (1–3 sentences each), never one long paragraph.
- **Default language.** UI, prompts, chat, and board: Simplified Chinese (`zh-CN`). TTS speech scripts: Japanese.

## Domain language

| Term | Meaning |
| --- | --- |
| Paper | Uploaded exam (`papers` + `paper_pages`). Status: `uploaded` → `analyzing` → `ready` \| `failed`. |
| Inventory | Model-generated directory of all problems, including their numbers, full statements, and start/end pages. Validated before detailed analysis. |
| Analysis draft | `papers.analysisDraft`: inventory plus fully validated problems. Saved after each problem; retained on failure for resume. |
| Problem | One extracted item. Sub-questions of a 大题 stay one problem. Strategy: `student_first` (先练后讲) or `direct_teach` (直接精讲). |
| Tutor | Persona + voice, without subject binding. Presets: 大吉岭, 远坂凛, 晴人, 阿尔托莉雅. Artoria replaces 小樱 in place, preserving the tutor ID. |
| Learning plan | Versioned pace, request and ordered representative units with related problems, reason and concrete goal IDs. Pending supplements require explicit confirmation; unselected items are not mastery. |
| Connection | Named protocol, URL, server-side key and optional legacy environment fallback. Chat and analysis independently bind connection ID + free-form model name. |
| Session | One classroom sitting: one paper + one tutor, with a paper/problem snapshot. Progress is per-problem `pending` \| `active` \| `done`. |
| Reading phase | One reading classroom phase: `free_reading` keeps the tutor silent until a student asks; `article_analysis` guides whole-article structure, writing, and theme analysis, with emotion and technique for literary work. |
| Reading focus | An ordered article-analysis angle: `structure`, `writing`, `theme`, and for literary work `emotion` and `technique`. A student explicitly confirms each completed angle. |
| Reading selection | A validated, stable-ID text anchor in the immutable reading-session snapshot. It supplies context for questions and private annotations. |
| Coverage | Per-session, per-problem evidence for `solution`, `knowledge`, `skills`, and `pitfalls`, stored in `sessions.coverage`. |
| Turn | One main tutor LLM call, with optional message/board repair calls. Streams NDJSON `TurnEvent`s. Ends with `wait` \| `continue` \| `next` \| `finish` on success. |
| Board | Per-problem chalkboard page. Blocks of Markdown/LaTeX the student can treat as notes. |
| Speech | Japanese TTS script stored on tutor text messages (`messages.speech`). |

Subjects: `数学 物理 化学 生物 语文 英语 历史 地理 政治`.

## Layout (classroom)

```
┌──────────────┬─────────────────────────────┐
│ Chat         │ Blackboard (right, larger)  │
│ (left)       │ AI writes board work here   │
│ user ↔ tutor │ Markdown + LaTeX, chalk UI  │
└──────────────┴─────────────────────────────┘
```

Other routes: `/` home, `/papers` + `/papers/new` + `/papers/[id]`, `/readings` + `/readings/new` + `/readings/[id]`, `/books` + `/books/new` + `/books/[id]`, `/tutors` + `/tutors/[id]`, `/settings`, `/classroom/[id]`, `/reading-classroom/[id]`, `/book-classroom/[id]`.

## Architecture

```
src/
  app/                 pages + Route Handlers (NDJSON streams for analyze/turn)
  components/          AppHeader, Markdown, Paper*, TutorEditor, classroom/*
  db/                  drizzle schema + pg Pool (DATABASE_URL)
  lib/types.ts         shared types, PROVIDERS, DTOs, event unions
  lib/text.ts          math normalize, atomic reveal, short-message splitting, language checks
  lib/client/media.ts  JPEG downscale, PDF→image (pdfjs in /public/pdfjs)
  lib/client/speech-audio.ts  shared TTS prefetch, playback cache, cancellation and URL lifetime
  lib/client/chat-attachments.ts  shared chat image compression and draft attachment state
  components/ClassroomComposer.tsx  shared exam-style composer for all three classrooms
  lib/server/
    google-docs.ts    Google Docs public PDF export with redirect and size limits
    llm.ts             OpenAI-compat / Anthropic / Gemini streaming
    analysis.ts        inventory and complete-problem validation
    prompts.ts         inventory + analysis + tutor system prompts
    protocol.ts        incremental <tag> parser (not JSON — LaTeX-safe)
    tutor-output.ts    Chinese/Japanese message repair and coverage evidence checks
    locks.ts           PostgreSQL advisory locks using a separate connection pool
    settings.ts        provider + Fish keys (DB override, else env)
    data.ts            DTO mappers, preset tutors, classroom load
```

API (all `force-dynamic`):

| Path | Role |
| --- | --- |
| `POST /api/papers` then `POST /api/papers/:id/pages` | Create paper; append images or UTF-8 Markdown/LaTeX sources as base64 data URLs. PDF is rasterized in the browser first. Each text file is one source page (max 1.5 MB). |
| `POST /api/import/google-doc` | Fetch a public Google Docs document as a PDF with all tabs; validates every redirect and limits the response to 20 MB. Does not create a material record. |
| `POST /api/readings` then `POST /api/readings/:id/sources` | New paged uploads declare `expectedPageCount`; append each source at a stable zero-based `idx`. Matching retries are idempotent. The final source starts background OCR. Exam limits do not apply to readings. |
| `POST /api/readings/:id/analyze` | Per-source OCR. `{ background: true }` returns `202` and schedules work with `after`; default preserves NDJSON. `{ restart: true }` clears page drafts and advances the revision. Background re-recognition moves legacy articles into paged review. |
| `GET /api/readings/:id/analysis-status` | Lightweight completed/total/current-page status, revision and resumability using the reading operation lock; no source payloads or full drafts. |
| `GET/PATCH /api/readings/:id/pages/:idx` | Read or save one recognized source page; saves require the current material revision. Empty recognized pages are complete. |
| `POST /api/readings/:id/confirm` | Accept only `{ revision }`; require every expected page and generate full text plus paragraphs in source order, atomically setting `ready`. Legacy articles retain their full-text PATCH endpoint until background re-recognition. |
| `POST /api/reading-sessions/:id/analysis` | Confirm the full article has been read and start or resume background whole-article context preparation. Returns `202`; context is saved in resumable chunks. |
| `GET /api/reading-sessions/:id/analysis-status` | Lightweight full-article preparation status, progress and resumability; never returns the full draft. |
| `GET/POST /api/reading-sessions/:id/notes` and `PATCH/DELETE /api/reading-sessions/:id/notes/:noteId` | Read and save a full-article learner notebook or anchored annotations. Per-note revisions reject stale updates. |
| `GET/PATCH /api/reading-sessions/:id/reader-state` | Shared resume position for the classroom snapshot's article version. Position writes use their own revision and idempotent mutation ID, independently of teaching locks. |
| `GET/POST /api/reading-sessions/:id/bookmarks` and `PATCH/DELETE /api/reading-sessions/:id/bookmarks/:bookmarkId` | Named bookmarks shared by article version. Create uses a client ID; rename/delete require the bookmark revision. |
| `POST /api/reading-sessions/:id/turn` | Reading question or guided-analysis turn. Body includes a stable `requestId`, `phase`, `stateRevision`, optional `focus`, validated `selection`, optional `selectionTask` (`vocabulary`, `grammar`, `meaning`), `text`, `images`, and optional `continue`, `goodbye`, or `analysis_summary` intent. Selection tasks require an anchor and exclude images/intents; they preserve the bookmark and teaching state. Streams `ReadingTurnEvent` NDJSON. Messages never advance article-analysis progress; the student confirms focus and completion explicitly. |
| `GET /api/reading-sessions/:id/messages/:messageId/attachments/:idx` | Read one saved reading-classroom message image. |
| `POST /api/papers/:id/analyze` | Inventory then per-problem vision analysis, streamed as NDJSON `AnalysisEvent`. Body `{ restart?: boolean }`; default resumes saved draft. Continues after browser disconnect. |
| `PATCH/DELETE /api/papers/:id` | Edit/delete under the paper lock. Subject cannot change after publication or while a draft exists. |
| `POST /api/sessions` | Start classroom (`paperId` + `tutorId`). Requires complete, error-free `ready` paper; saves snapshot in a transaction. |
| `PATCH/DELETE /api/sessions/:id` | Jump/delete under the session lock; active generation returns `409`. |
| `POST /api/sessions/:id/turn` | Tutor turn. Body `{ text?, images?, intent?: "complete_problem" \| "goodbye", problemIdx? }`. Streams `TurnEvent` NDJSON; successful `done` echoes the optional intent. Exact shortcut text also resolves the intent. `problemIdx` binds completion and retries to the intended problem; already-done targets only synchronize progress. |
| `POST /api/tts` | Fish Audio mp3. Body `{ text, voiceId }`. In-memory cache by model+voice+text. |
| `GET /api/voices` | Fish Audio voice search (default `lang=ja`). |
| `GET/PUT /api/settings` | Provider keys, models, Fish key, `autoContinue`. Keys never returned in full. |
| `GET /api/health` | Read-only schema readiness derived from Drizzle tables, columns, primary keys and unique keys. Returns `503` with `SCHEMA_NOT_READY` or `DATABASE_UNAVAILABLE` until ready. |

Settings keys: DB row `app_settings.id = 1`, else env. Provider env: `OPENAI_API_KEY`; `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`; `XAI_API_KEY` / `GROK_API_KEY`; `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`. Fish: `FISH_API_KEY` / `FISH_AUDIO_API_KEY`. Default Fish model `s2.1-pro`. Default voice `db1553e441c84b49bf250912563ec8fc`.

DB (Drizzle, `src/db/schema.ts`): `app_settings`, `tutors`, `papers`, `paper_pages` (base64 image or UTF-8 text per source page, identified by MIME), `problems`, `sessions`, `messages`, `boards` (unique on session+problemIdx). Text sources use `text/markdown`, `text/x-tex`, or `application/x-tex`; send their decoded source to the LLM as text, never as an image. Do not compile TeX or resolve external file dependencies. `PaperDTO.pageMimes` is optional for legacy snapshots and enables source-aware previews.
`reading_sessions.learning_state` stores two-phase teaching progress; `analysis_draft` stores resumable whole-article context preparation. `reading_turns` provides idempotent streaming-turn replay, and `reading_personal_notes` stores learner-owned notes with independent revisions. `reading_messages` also stores chat attachments, phase/focus metadata and validated source anchors. Apply additive reading changes with `npm run db:push`, or review `docs/migrations/20261011-reading-two-phase-learning.sql`; keep the earlier attachment migration when upgrading from a pre-attachment database.

Book contracts are re-exported from `src/lib/book-types.ts`; tables from `src/db/books-schema.ts`. Review `docs/migrations/20261013-books-shared-reader.sql` before upgrading an existing database. Book APIs under `/api/books` cover multipart upload (50 MiB; 256 MiB expanded), manual import resume, directory correction/confirmation, immutable chapter documents and internal resources. `/api/book-sessions` covers session creation, bookmark/chapter/focus mutations, three private note kinds, streaming idempotent turns, checkpointed chapter preparation and optional whole-book summary. MOBI requires an absolute `CALIBRE_EBOOK_CONVERT` path; only the conversion's own child may be terminated on timeout. Preserve raw sources and historical versions.

Book pagination adds `book_reader_states` and `book_bookmarks`; review `docs/migrations/20261017-book-pagination.sql` before upgrading. `GET/PATCH /api/book-sessions/:id/reader-state` saves the last position and chapter positions atomically with an independent revision and mutation ID. `GET/POST /api/book-sessions/:id/bookmarks` and `PATCH/DELETE /api/book-sessions/:id/bookmarks/:bookmarkId` manage version-owned named bookmarks. These operations do not acquire the teaching lock or alter chapter learning. Session-local `action: "bookmark"` remains compatible and synchronizes the captured question position before an unanchored free-reading turn. Browser acceptance instructions are in `docs/book-pagination-acceptance.md`.

Book turn context is limited to current-question text, the current chapter's opened preparation, confirmed-read prior chapter memories and relevant history. Later chapters never enter automatic context, even if previously visited. Whole-book personal notes require explicit attachment. Publishing directory changes creates a new version; existing classrooms and notes keep their version. Successful turns must remain successful if a post-commit response/read fails. Use the separate lock pool and book-specific namespaces consistently across processes.

Recovery fields: `papers.analysis_draft` (nullable), `sessions.snapshot` (nullable for legacy sessions), and `sessions.coverage` (default `{}`). Sync schema before running this version in another environment. Do not remove these fields or use a destructive schema reset to resolve migration issues.

## Analysis and classroom integrity

- Publish only after the complete inventory and every plan-selected detailed problem pass validation. Inventory and nullable details remain distinct; a partial required set must never emit `done` or become `ready`. Drafts are keyed by stable index, including non-contiguous selections.
- Each problem gets up to two analysis attempts. Save completed results outside the retry loop so a database-write failure cannot duplicate a problem.
- Replace published problems atomically. A failed reanalysis keeps the prior published set; existing classrooms keep their original snapshot. Legacy sessions without snapshots are backfilled before replacing problems.
- Draft problem events use provisional negative IDs. After publication, load persisted problems rather than treating provisional IDs as database IDs.
- Analysis continues when its browser stream disconnects. A process restart stops the task, but preserves completed draft work. The student must click to resume; there is no durable job worker or automatic restart.
- Reading OCR starts after every expected source page uploads, runs with Next.js `after`, saves each recognized page in `readings.draft`, and continues when the browser closes. A process restart leaves the saved pages intact; the article page reports an unlocked stale run as resumable.
- Reading OCR reads only the current source payload, makes at most two image-recognition attempts per page, and saves outside the retry loop. `[空白页]` stores an empty draft value whose key still counts as complete. Reading tasks have no whole-article deadline; every LLM call retains its 180-second timeout. Confirmation has no aggregate 1.5 MB or 1,000-paragraph cap, but each imported text source retains its 1.5 MB cap. The shared reader preloads its internal window while retaining DOM involved in native selection; there are no user-facing paragraph groups.
- Reading classrooms start in `free_reading` without a model or TTS request. Text selection is verified against the session snapshot; bookmark movement is independent of article-analysis focus. `article_analysis` uses saved per-chunk context, a separate preparation lock, and a manual resume after failure/restart. Three general and five literary analysis angles require explicit student confirmation. Personal notes are isolated from tutor-generated analysis, with per-note revision checks. Legacy reading progress stays visible as history and never implies article-analysis completion.
- Reading selection shortcuts bind exact selected text separately from supporting context and carry the current focus in both phases. Buffer shortcut output; require ordered exact visible-text quotes, Chinese explanation and a terminal `wait`. Retry only a target/shape validation failure once, within the original deadline. Prepare speech, atomically save all accepted tutor messages and turn success, then emit events. Never retry cancellation, transport, speech-repair or database errors as a selection failure. This guard checks targets and shape, not semantic correctness. Omitted `selectionTask` preserves legacy request hashes and successful replay.
- `tryOperationLock` must reserve a connection from the separate lock pool, never the database work pool. Release on success, failure, cancellation, and pre-stream errors. Keep paper/session lock namespaces consistent across app processes.
- Serialize session generation, jumps, and deletion. A `409` means another operation owns the lock. Client retries must be bounded; do not remove server locks to make an interrupted request succeed.
- Only accept coverage quotes of at least six non-whitespace characters that appear in actual tutor Chinese messages or board content. Normal tags reference the current turn; completion may make one bounded repair call using saved teaching from this session and problem, never student input, other problems, or reference solutions. Reject headings and completion declarations as evidence. Persist coverage by problem index.
- When plan-goal coverage is incomplete, convert `next`/`finish` to `wait`. Visit unfinished selected units before completing the session. Preserve effective evidence when goals match, require new evidence for expanded goals, and reject retries with obsolete plan versions. Supplementary analysis must match the snapshot material revision and atomically apply its plan only after success.
- OpenAI/xAI requests must send the requested output budget (`max_completion_tokens` for OpenAI gpt-5/o-series, otherwise `max_tokens`). All adapters must reject truncation, safety stops, and premature stream termination.

## Streaming protocol

Do not switch analysis/tutor output to JSON. Tags survive raw LaTeX and parse while the model is still streaming (`createTagParser` in `protocol.ts`).

**Analysis**: `inventorySystemPrompt` first produces a closed `<inventory count="N" pages="P">` with `<overview>` and unique `<item number="1" page="1" endpage="1">` entries. A closed `<plan>` selects stable indices and goals before `analysisSystemPrompt` produces one closed `<problem>` per selected item, with `<content> <answer> <solution> <keypoints> <knowledge> <skills> <reason> <student>`. Validated draft problems persist by index in `papers.analysisDraft`; publication requires every selected detail, while unselected directory entries retain nullable analysis. Default retry resumes the draft; `{ restart: true }` rebuilds the inventory.

**Tutor turn** (`buildTutorSystem`):

```
<msg>
<zh>中文消息（Markdown + $LaTeX$）</zh>
<ja>[語氣] 日本語の音声台本。数式は日本語で読む。LaTeX/中文禁止。</ja>
</msg>
<board mode="append|replace" title="本页标题">
板书 Markdown
</board>
<covered topic="solution|knowledge|skills|pitfalls">Exact quote from Chinese chat or board in this turn</covered>
<action>wait|continue|next|finish</action>
```

- `<msg>` and `<board>` may interleave. Exactly one `<action>` at the end.
- `wait` = wait for the student. `continue` = client auto-fires another turn (cap 6). `next` / `finish` update session progress.
- `next` / `finish` and explicit `complete_problem` require the current plan's goals, backed by actual emitted or saved tutor content. Complete pace and legacy plans require all four core topics. Complete coverage alone does not finish a problem. Finish cannot skip unfinished selected units. Excluded items are not marked mastered. Coverage is a progress guard, not independent semantic verification.
- `goodbye` preserves progress and suppresses board work, completion and automatic continuation. The return-home control unlocks only after a successful done, normal stream EOF, and the entire playback/reveal queue is idle; cancellation or failure must not unlock it. Goodbye state is page-local; retry retains intent.
- Sessions keep a paper/problem snapshot. Paper and session mutations use separate PostgreSQL advisory-lock connections, including across app processes.
- Exam paper PDF, upload UI and server share `MAX_PAPER_PAGES = 12`; oversized paper PDFs are rejected explicitly. Reading sources have no page-count cap and are rendered and uploaded one page at a time.
- Paper and reading uploads accept pasted images and public Google Docs links. The shared import control reads one preferred image representation per clipboard item; Google Docs export imports all tabs as PDF pages and goes through the existing review flow. Text-entry controls keep their normal paste behavior. Imports are staged before submission; paper pages, including pasted paper text, count toward the 12-page paper limit.
- Google Docs imports require public access and export permission, use no Google login, and time out after 30 seconds. Export requests are restricted to Docs document links, allow at most five redirects to Google export hosts, and cap the PDF at 20 MiB. No document source is stored until the user submits the upload form.
- Client pump (`Classroom.tsx`): play each `message` (TTS + reveal), then apply `board` / `problem` / `done`. User may interrupt; pending input flushes the queue.
- All three classroom streams start TTS prefetch when a valid tutor message event arrives. Synthesis may complete out of order; each classroom applies messages, boards, notes, progress and completion in its existing event order.
- The three classroom composers use `ClassroomComposer` and the shared chat-attachment helper. Chat text is limited to 4,000 Unicode code points; each message accepts up to four JPEG/PNG/WebP/GIF images, each at most 2 MiB after conversion. Paste reads image file items from the active composer and leaves text-only paste native.
- Reading message attachments are separate from article source pages. Existing `reading_messages` rows get an empty `attachments` array through the additive JSONB column default.

## Message and voice handling

- `prepareTutorMessages` checks short Chinese text plus Japanese speech. Invalid or long messages get a repair call; Chinese repairs must preserve the original content. If repair fails, retain usable Chinese chunks with empty speech. Unrepaired Japanese chat must fail rather than appear in a Chinese bubble.
- Short-message splitting targets 80 characters and preserves atomic formulas, bold spans, and links. One indivisible token can exceed the target. The 2-6 bubble count is a prompt target, not a hard runtime limit; preserve content during fallback.
- Japanese board text/title is translated through a separate repair call and checked again. `/api/tts` also validates speech before contacting Fish.
- `SpeechAudioController` owns browser TTS requests, in-flight deduplication, cached object URLs, cancellation and cleanup. Every complete valid Chinese tutor message with Japanese speech starts prefetch immediately in all three classrooms; playback awaits the same request result and remains FIFO. Settings and tutor previews use the same requester, while settings previews preserve `fresh: true`.
- Follow `docs/tts-emotion-tags.md`: S2/S2.1 cues use square brackets and concise free-form descriptions (Japanese descriptions are valid). Every playable tutor speech starts with a primary emotion/style cue; preserve existing cues during repair and add the tutor's base style when absent. Keep cues only in speech, with Japanese spoken text. Do not impose an English-only whitelist or silently convert S2 cues for legacy S1.
- Repeatable UI acceptance uses the `$playwright` skill's `playwright-cli` wrapper and saves artifacts under `output/playwright/`. Use `@Browser` for exploratory debugging when it helps; choose one tool for acceptance of a given scenario. See the verification workflow below. Do not introduce `@playwright/test` unless the user asks for test files or a test-runner/CI migration.
- Muted mode must skip voice prefetch, synthesis, and replay. Use the text reveal timer directly; never wait for inaudible playback.
- The message request body is limited to 12 MiB. Shared server validation rejects more than 4,000 text code points, more than four images, unsupported image MIME types, invalid base64 or an image exceeding 2 MiB; never silently truncate a classroom message.
- Current limits: LLM call 180 seconds, full tutor turn 270 seconds, full analysis 750 seconds, Fish request 12 seconds, browser TTS request 15 seconds. Preserve cancellation and text fallback when changing these limits.
- On interruption, preserve all queued student inputs in order. On unmount, cancel generation/TTS, finish reveal, pause audio, clear pending work, and revoke blob URLs. Optimistic message IDs must be unique.
- Clean up PDFs through the `getDocument` loading task's `destroy()`. The bundled pdf.js 6.4 API does not expose `destroy()` on the resolved document proxy.

## Invariants

1. **Language split.** Explanations + board + UI = Simplified Chinese. Reading quote/example/exercise content can use the explicitly labeled article language; notes require labeled foreign blocks. TTS `<ja>` / `speech` = Japanese. Foreign quotes are never automatically synthesized.
2. **TTS sync.** Reveal tokens from `tokenizeForReveal` (LaTeX/bold/links stay atomic). Progress follows `audio.currentTime / duration`. Fallback timer if TTS is missing or muted.
3. **Short bubbles.** Prompts and fallbacks must keep tutor text as multiple short messages. Never concatenate a turn into one paragraph.
4. **Markdown + LaTeX.** `$...$` / `$$...$$` only (not `\(`/`\[` in model output). Render through `components/Markdown.tsx` (`remark-math` + `rehype-katex` + `normalizeMath`). Typewriter must not split a formula.
5. **Board is notes, not chat.** Concise structured Markdown: `##` sections, `**bold**` = chalk highlight, `>` = theorem box, `- [x]` = recap ticks. One board page per problem.
6. **EPDL coverage.** Complete pace/legacy plans require full solution, knowledge, skills and pitfalls. Other paces use their concrete goals; advanced adds extension and variation feedback. Honor `student_first` vs `direct_teach`. Completion means this plan finished, never mastery of excluded problems.
7. **Side questions.** Student can interrupt any time. Answer, then return to the current problem.
8. **Secrets.** API keys live in settings/env. Public settings expose `hasKey` + masked preview only. Never log raw keys or page image payloads.
9. **No extra LLM/TTS SDKs.** Extend `llm.ts` / `/api/tts` with `fetch`. Keep the Fish call shape: `Authorization: Bearer`, header `model`, body `{ text, reference_id, format: "mp3" }`.

## Code conventions

- TypeScript strict. Import via `@/*` → `src/*`.
- Shared contracts in `src/lib/types.ts`. DB rows stay in `data.ts`; API/UI speak DTOs.
- Server-only I/O in `src/lib/server` and Route Handlers. Browser helpers in `src/lib/client`.
- User-facing copy is Chinese. Code, comments, and this file are English.
- `"use client"` only for interactive trees (`Classroom`, `Blackboard`, `Markdown`, editors). Pages that can be server components should stay server components (`dynamic = "force-dynamic"` when they read the DB).
- Tailwind utility classes + the chalk/markdown rules already in `globals.css`. Match existing classroom chrome; do not introduce a second design system.
- Prefer small, explicit functions over new frameworks. Match the surrounding file's style.
- After behavior changes: `npm run typecheck`, `npm run lint`, and the affected checks selected by the verification workflow below. Classroom/UI changes need a real browser pass for the affected flow; upload, settings, other classrooms and voice edge cases are selected by impact rather than repeated for every UI edit.
- After completing code updates and the relevant checks, run `codegraph sync` from the project root to update the code index before reporting completion.

## Git workflow

- Work, commit and push directly on the existing `main` branch.
- Do not create or switch to another branch on your own. Use another branch only when explicitly instructed by the user.

## Verification workflow

### Select checks by impact

- Before testing, identify the changed behavior, shared consumers and relevant failure paths. Use the matrix below and the "When changing X, also touch Y" table. State the selected checks briefly; expand coverage when dependencies, failures or uncertainty justify it.
- Documentation-only changes require `git diff --check` and verification of changed links, file paths and documented commands. Do not start the app/database, run a production build or rerun application tests for prose changes.
- Test-tooling-only changes require the affected script's syntax/type/lint checks and checks of its success and failure behavior. Build/start the application only when the tooling change depends on real application integration.
- All application behavior changes require a final passing `npm run typecheck` and `npm run lint`. During development, prefer affected unit tests, incremental TypeScript checks and linting changed files. Cached lint is available with `npm run lint -- --cache --cache-location .anilearn/eslint-cache`; keep the final full-project lint check.
- Retain cheap unit/provider checks when running them is simpler than maintaining selection logic. A test belongs at each layer that verifies a distinct risk: API rejection of a stale note revision and UI preservation of its draft are both useful.

| Changed area | Required affected checks | Browser scope / additional triggers |
| --- | --- | --- |
| Free questions, topics, retries or greeting/goodbye | `npm run free:test`; `npm run free:audit` when server persistence/protocol changes | Free classroom: affected question/topic/retry/restore/exit flow |
| Reading phases, anchors, personal notes or analysis | `npm run reading:test`; `node output/audit/upgrade-api.mjs` when server state, persistence or preparation changes | Reading classroom: silent entry, affected selection/note/phase/focus/completion flow and refresh recovery |
| Book import, immutable versions, chapter learning or shared reader | `npm run books:test`; `node output/audit/books-api.mjs` for persistence/preparation; `reading:test` and `upgrade-api.mjs` for shared article contracts | `browser-books.js` through Playwright CLI: default Plato entry-to-exit, native selection, notes, typography/character restore, footnotes, desktop/mobile and affected old article flows |
| EPDL plans, problem analysis, coverage or snapshots | `node --import tsx --test src/lib/server/learning-plan.test.ts`; select `fix-api.mjs` and/or `upgrade-api.mjs` for the changed rules | Exam classroom: affected problem/plan/board/progress flow |
| LLM adapters, proxies, streaming tags or language repair | `npm run llm:test`; `node output/audit/provider-audit.cjs`; API suites for affected consumers | Representative turns in all affected modes; configured live connection smoke when changing transport/provider configuration |
| Shared classroom composer, attachments, event queue or speech controller | Relevant free/reading/input/provider checks; API checks if the request contract changes | All affected classrooms: send and restore; shared playback changes also need FIFO, mute, interruption, fallback and cleanup checks |
| Markdown, math normalization, reveal tokens or board rendering/export | `npm run math:test`; provider/parser checks when tag/reveal handling changes | Affected rendering and exported notes; voice/reveal checks when tokenization changes |
| PDF/images, clipboard or Google Docs import | `npm run google-docs:test` for Docs changes; affected upload/API checks | Affected paper/reading import, review and limits; both consumers when shared media/import code changes |
| Settings, model bindings or tutor configuration | Provider/free checks and settings/API checks for changed fields | Affected save/preserve/clear/masking/preview behavior and one consuming flow |
| Schema, locks or shared persistence | API suites for every affected consumer; additive migration/legacy checks | Concurrency, idempotency, stale revisions, snapshots, cancellation and lock release remain required when affected |
| Launcher, process ownership or lifecycle | `npm run launcher:test`; lifecycle audit when process/container management changes | Use the owned lifecycle-audit environment; no classroom tour required |
| Layout, navigation or styles | Final typecheck/lint and affected UI checks | Desktop `1366×768` and mobile `390×844` for affected layouts; reuse API results when server behavior is unchanged |

- `free:test` already includes `llm.test.ts`; omit a second `llm:test` run when that same version has passed through `free:test`.
- The API audit scripts currently run whole suites. Select the applicable script, then let its complete assertions run; do not invent filtering flags or claim individual cases were selected. Extra inexpensive coverage inside a selected suite is acceptable.
- The 1.5 MB-plus / 1,003-paragraph article and actual restart checks are required for changes to chunking, OCR/context preparation, background work, recovery or relevant persistence. Lifecycle integration is required for launcher lifecycle changes. These are not mandatory additions to an unrelated visual/prose change; they may still run inside a selected whole API suite.
- For a release or a change to cross-mode contracts, schema, locks, LLM transport or shared playback, broaden to all affected consumers and one main browser flow per classroom. Preserve all explicitly requested acceptance cases. Do not run unrelated Launcher/Docs/import flows solely because another feature changed.

### Build once and reuse the environment

1. Complete the affected fast checks and resolve their failures before starting expensive integration work. Independent unit, provider and static checks may run in parallel; serialize operations that mutate shared settings, fixtures, ports or generated files.
2. Run `npm run build` for changed application code/configuration before production-runtime API/browser acceptance and final delivery. Reuse a successful build for unchanged application inputs. Documentation/report-only edits do not invalidate it; application code, dependencies, config or relevant environment changes do.
3. Start one owned isolated audit runtime and reuse its database/mock provider for selected API suites and browser acceptance. Run suites that mutate global model/settings fixtures sequentially, then establish the browser fixture explicitly. Reuse valid state; reset only owned test records as needed.
4. When application changes require another build, stop the identified preview before building and restart it afterward. Keep the owned mock service/database when safe. Do not run dev/start/build processes concurrently against the same `.next` output.
5. After the selected checks pass, rerun only checks invalidated by further edits, failures or changed fixtures/configuration. Record enough context to distinguish current results from historical results: tested source revision/diff, command, environment, fixture/model mode and outcome.
6. Shut down and verify the owned test environment through the cleanup rules below. Index sync, migrations, Git operations and cleanup are delivery operations; report them separately from test coverage.

### Browser acceptance and pass criteria

- `@Browser` is useful for discovery, visible interaction and unknown UI defects. Playwright CLI is the default for repeatable acceptance and saved evidence. Do not repeat the same stable scenario with both tools just to compare them; a user-requested tool switch reuses valid findings and reruns affected cases.
- Read the Playwright skill and check `npx` before using its wrapper. Reuse a named browser session. Use current snapshots and accessible roles/labels for ordinary controls; refresh refs after meaningful UI changes. For precise selection/drag tests, use a bounded reusable interaction rather than repeatedly guessing screen coordinates.
- Prepare most scenario state through the isolated fixture/API. Keep one full user entry-to-exit path for a newly introduced or substantially changed mode; focused regressions can start at the affected state. Do not replay upload, all five analysis angles and every historical flow before each small UI check.
- Reuse existing scripts through the skill's CLI where suitable. Save stable sequences with explicit assertions for reuse; CLI clicks/snapshots alone are not an unattended regression suite. Do not add a new testing framework for a routine fix.
- Wait for the expected request, rendered state or playback condition with a bounded timeout. Use fixed delays only when elapsed time is the behavior being measured, such as reveal progress or timeout fallback. Preserve actual browser selection/playback checks where DOM/API-only checks cannot prove the interaction.
- Every claimed automated pass needs an assertion or an aggregate that throws/returns a nonzero status on failure. An `outcome: "fail"` report row must fail the run. Observation-only rows, screenshots and a clean console require an explicit recorded review; do not count them as automatic passes. Never relax an assertion merely to match an unexpected result.
- Inspect console and relevant network requests; absence of a tutor bubble alone does not prove silent reading made no model/TTS request. Assert persistence through refresh/API state and verify critical UI behavior, not only HTTP success.
- Save screenshots at changed/important states and failure traces/logs when useful under `output/playwright/`. Avoid a screenshot and full snapshot after every unchanged step. A mobile viewport checks responsive layout; it does not by itself prove physical-device touch/audio behavior.

### Separate deterministic and live validation

- Use isolated mock models/audio for repeatable protocol, state, concurrency, playback-order and fallback checks. Preserve separate checks for server contracts and browser behavior.
- When transport/proxy/provider binding, teaching prompts or voice behavior changes, run a small relevant live smoke with the project's existing configured service when available, unless the user requests mock-only validation. Include the actual reported failure where applicable; do not replay the whole mock matrix against paid services.
- If live credentials/service access are unavailable, complete deterministic checks and explicitly mark real model/Fish behavior unverified. An observed live failure remains a failure or limitation even when mock suites pass.
- Teaching correctness, OCR completeness and Japanese speech quality need representative real materials, reference answers and listening review. Report these separately from software regression results; retain the verification limits below.

## Commands

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start (requires a completed build)
npm run lint
npm run typecheck    # tsc --noEmit
npm run math:test    # Markdown/LaTeX and rendering checks
npm run free:test    # free input/prompts/protocol, including llm.test.ts
npm run llm:test     # LLM/proxy/error checks when free:test is not selected
npm run free:audit   # isolated free-session API regression
npm run google-docs:test # link validation and Google Docs export safety checks
npm run launcher     # Windows full-screen TUI; auto-start app and PostgreSQL
npm run launcher:test # launcher core and terminal-layout regression tests
npm run reading:test  # reading phase and source-selection validation
npm run reader:test   # pagination, character restore, inspection and resumable position writes
npm run books:test    # ebook import, chapter states, context boundaries and reader anchors
codegraph sync       # update the code index after code changes
```

Requires `DATABASE_URL` in the environment or root `.env.local`. `drizzle.config.ts` loads the same Next.js environment files. Local PostgreSQL runs through `compose.yaml` (`npm run db:up`); initialize its schema with `npm run db:push`. See `README.md` and `.env.example`. Schema: `src/db/schema.ts`.

## Local lifecycle and regression checks

- The Windows TUI entrypoint is `AniLearn.cmd` / `npm run launcher`; implementation lives in `scripts/launcher/`. It uses Ink 6, `tsx`, a local authenticated named pipe, and a detached lifecycle manager. Runtime files, sanitized logs, preferences and build fingerprints are ignored under `.anilearn/`.
- Launcher `Q` / Ctrl+C closes the app process tree and project PostgreSQL via Compose `stop`, preserving the volume. `D` explicitly detaches; unexpected panel loss defaults to cleanup. Verify PID plus creation time and command before stopping, and confirm the Compose project's working directory before managing its container.
- Launcher database monitoring is read-only and counts metadata; never query messages, paper payloads or settings secrets for the dashboard. Keep logs sanitized before persistence and display.
- Lifecycle integration checks: `node --import tsx scripts/launcher/lifecycle-audit.ts`. This creates a unique owned Compose project, environment file, app/database ports and volume under `.anilearn/`; it checks absence before creation and only removes its own test volume. Do not run against the application database. Keep AniLearn stopped after launcher verification.

- After completing work and verification, shut down AniLearn's app process tree and local database by default, including any preview started for the task, unless the user explicitly asks to leave it running. Verify shutdown before reporting completion.
- When closing AniLearn, stop only the identified project server process tree. Stop its local database with `docker compose --env-file .env.local stop`; preserve the `anilearn_postgres_data` volume. Do not stop all Node processes or Docker Desktop.
- A user's shutdown request takes precedence over automatically starting a preview. Do not restart the app after a documentation-only update.
- When selected by the verification workflow, run provider/parser checks with `node output/audit/provider-audit.cjs`. Results are written to `output/audit/fix-provider-results.json`.
- Selected API regression requires a completed build and PostgreSQL. Start `node output/audit/runtime.cjs` once, then run the applicable `node output/audit/fix-api.mjs`, `node output/audit/upgrade-api.mjs`, and/or `npm run free:audit` suites sequentially. The harness creates the isolated `anilearn_audit_20261007` database, mock provider on `127.0.0.1:4107`, and app on `127.0.0.1:3107`. It refuses to reuse an existing test database.
- Shut down the harness through `GET http://127.0.0.1:4107/shutdown` and verify cleanup. Never point its SQL fixture endpoint at the user's application database or delete a pre-existing test database without checking ownership.
- Browser scripts are `output/audit/browser-audit.js`, `browser-upload-settings.js`, and `browser-fix-edge.js` for classroom/voice, upload/settings, and interruption/timeout flows. Select relevant flows and run against the isolated harness through Playwright CLI; screenshots belong in `output/playwright/`. Some existing report rows are observational or only record `outcome`; apply the pass criteria above when reviewing them, and add hard assertions when maintaining those scenarios.
- Historical `api-audit.mjs` and the original `*-results.json` record defects before repair. Use `fix-api.mjs` and `fix-*-results.json` for current expectations. The audit and repair reports are in `output/audit/`.

## Verification limits

The October 7, 2026 repair passed typecheck, lint, build, 18 API regression groups, provider/parser checks, and browser flows using mock models/audio. Real provider and Fish Audio behavior was not verified because no live keys were configured. Do not present these checks as live integration or teaching-quality acceptance.

The inventory itself is generated by a vision model; structural validation cannot detect every OCR omission. Answers and textbook sources have no independent verification or retrieval. Coverage quotes guard progress, but do not prove semantic completeness. Language checks are heuristic, and Chinese reveal follows Japanese audio duration rather than word-level alignment. Validate these limits with real papers, standard answers, and live speech before claiming product acceptance.

## When changing X, also touch Y

| If you change | Also check |
| --- | --- |
| Tutor prompt / `<msg>` shape | `prompts.ts`, `turn/route.ts` parser, `Classroom.tsx` pump, TTS reveal |
| Board Markdown | `Blackboard.tsx`, `globals.css` `.board`/chalk rules, export notes |
| Analysis tags | `prompts.ts` inventory/analysis prompts, `analysis.ts`, `analyze/route.ts`, draft resume and publication |
| Coverage / course completion | `types.ts`, `schema.ts`, `prompts.ts`, `tutor-output.ts`, turn progress and jumped problems |
| Snapshot / reanalysis | `schema.ts`, `data.ts`, session creation, analysis publication, old classrooms |
| Provider API | `llm.ts`, `types.ts` `PROVIDERS`, `settings.ts`, `/settings` UI |
| TTS | `/api/tts`, `text.ts` validation, `tutor-output.ts`, `Classroom.tsx` prefetch/play/replay/mute/cleanup |
| Upload / PDF limits | `types.ts` `MAX_PAPER_PAGES`, `media.ts`, upload page and pages API |
| Reading OCR and review | `reading-analysis.ts`, reading upload/source/page/confirm handlers, `ReadingView.tsx`, `ReadingClassroom.tsx` and reading recovery regressions |
| Operation locks | `locks.ts`, paper/session mutation handlers, cancellation and concurrency regressions |
| Schema | `schema.ts`, DTO mappers, every Route Handler that reads the table |
