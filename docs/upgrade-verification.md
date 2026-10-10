# AniLearn Guidance Upgrade

The upgrade adds five-paced exam plans, selected detailed analysis, explicit supplementary analysis, independent model-purpose bindings, all-subject tutors and English/Japanese article classrooms.

## Verification

- `src/lib/server/learning-plan.test.ts`: closed plans, stable sparse indices, duplicate/invalid targets, advanced goals, changed-goal evidence and nullable details.
- `output/audit/upgrade-api.mjs`: legacy settings conversion, masking, independent model tests, compatible connections, selection/completion, supplementary failure/resume and version conflicts, snapshot isolation, correct repair model, English/Japanese reading recovery, automatic per-page OCR, long-article confirmation/classrooms, page revision conflicts, blank pages, truncation/timeouts, database-write failures, duplicate starts and actual app restart/resume.
- `output/audit/fix-api.mjs`: existing 18 classroom regression groups. Fixtures explicitly use the complete pace; failed drafts count actual analyzed items rather than directory entries.
- `output/audit/provider-audit.cjs`: four protocol adapters, output budgets, truncation/EOF rejection, tag parsing and atomic reveal.
- `output/audit/browser-upgrade.js`: desktop/mobile settings and avatar, article upload/review, original positioning, notes/practice, reading recovery, queued interruptions, exit, Japanese audio reveal and mute cleanup.
- `output/audit/browser-plan-sources.js`: pace adjustment, cancellation, supplementary failure/retry, atomic publication, immediate problem dividers, completed-plan reopening, mobile controls, all article source formats, 17/100-page PDF uploads, background completion after closing the upload tab, 50-paragraph groups and 13 mixed sources with interrupted upload/resume.
- `output/audit/upgrade-tutor-migration.mjs`: legacy Sakura is upgraded in place, with existing tutor IDs and classroom associations retained; preset subject wording is removed.
- Existing classroom browser scripts cover board rendering, notes export, synchronized reveal, muted playback, interruption and request timeouts.
- Launcher unit tests and isolated lifecycle audit validate schema readiness and owned process/database cleanup.

The API runtime creates an isolated database and mock model endpoint. Test output is in ignored `output/audit/*results.json`; browser screenshots are in `output/playwright/`. It must be shut down via the mock endpoint and the owned Compose database stopped without deleting its persistent volume.

## October 9, 2026 Results

Typecheck, lint and the production build passed. Focused learning-plan tests passed (3); provider/parser checks passed (13); existing API regression groups passed (18); upgrade API groups passed (11), including canceled version rejection and sparse initial draft resume. The separate tutor migration check passed. Launcher unit tests passed (10), and its isolated lifecycle audit passed (20), including owned process/container cleanup.

Browser checks passed for English/Japanese reading, all article source formats, exam PDF/image upload, settings, selective plans and reopening completed plans. Existing classroom checks passed for board rendering and notes export, Japanese audio reveal, mute, ordered interruptions, voice timeouts and goodbye/return gating. Desktop and mobile screenshots were inspected. Final API checks ran sequentially after launcher checks, avoiding concurrent rebuilds of the shared `.next` directory.

These checks use simulated models/audio. They do not verify real selection quality, OCR completeness, answer correctness, textbook citations or Fish voice quality. Goal quotes guard recorded progress and do not independently prove semantic mastery. Reading exercises are open dialogue records rather than a validated question bank.

## October 10, 2026 Results

Typecheck, lint and the production build passed for unlimited reading uploads and automatic long-article OCR. Upgrade API checks passed (21 groups), and the existing API checks passed (18 groups). Provider/parser checks passed (13), Google Docs safety checks passed (6), and Markdown/math checks passed (16).

The long-article API case confirms more than 1.5 MB of text and 1,003 paragraphs, then creates a reading classroom and completes its first tutor turn. It checks ordered page mapping, rejects confirmation before all sources are recognized, rejects stale page edits and confirmation revisions, and preserves historical classroom snapshots. Fault cases cover explicit blank pages, truncated OCR, per-call timeouts, draft database-write failures, duplicate background starts, saved-page reuse, a process interrupted after its final page save, and a real app-process restart followed by manual resume. The isolated runtime preloads a five-second substitute for the production 180-second LLM timeout so the timeout case can finish quickly; application timeout behavior and source remain unchanged.

Real Chrome checks passed: long-source/plan flows (9 groups), English/Japanese reading and speech flows (5), Google Docs/clipboard imports (8), paper upload/settings (5), and the existing classroom and interruption/voice-timeout flows. Both 17-page and 100-page PDFs finish OCR after their upload tabs close. The 100-page article confirms every source and renders 50 paragraphs per group. A 13-source mixed upload safely continues after a simulated failed page upload. The same browser rejects a 17-page exam PDF and keeps its submission disabled. Desktop/mobile screenshots were inspected, including paged review and classroom source groups.

Evidence is saved in `output/audit/upgrade-api-results.json`, `upgrade-plan-source-results.json`, `upgrade-browser-results.json`, `google-docs-import-results.json`, and the existing `fix-*-results.json` reports. Screenshots are in `output/playwright/`. The local schema received only the additive `readings.expected_page_count` column, with legacy rows defaulting to zero. The audit uses its own database and dummy credentials; its teardown removes only that database, stops the owned app, and preserves the project's PostgreSQL volume.

Models, audio and Google Docs browser exports are simulated. These checks establish upload, review, recovery and classroom flow behavior; real OCR completeness and Fish speech quality remain unverified.
