# AniLearn Guidance Upgrade

The upgrade adds five-paced exam plans, selected detailed analysis, explicit supplementary analysis, independent model-purpose bindings, all-subject tutors and English/Japanese article classrooms.

## Verification

- `src/lib/server/learning-plan.test.ts`: closed plans, stable sparse indices, duplicate/invalid targets, advanced goals, changed-goal evidence and nullable details.
- `output/audit/upgrade-api.mjs`: legacy settings conversion, masking, independent model tests, compatible connections, selection/completion, supplementary failure/resume and version conflicts, snapshot isolation, correct repair model, English/Japanese reading recovery and image OCR.
- `output/audit/fix-api.mjs`: existing 18 classroom regression groups. Fixtures explicitly use the complete pace; failed drafts count actual analyzed items rather than directory entries.
- `output/audit/provider-audit.cjs`: four protocol adapters, output budgets, truncation/EOF rejection, tag parsing and atomic reveal.
- `output/audit/browser-upgrade.js`: desktop/mobile settings and avatar, article upload/review, original positioning, notes/practice, reading recovery, queued interruptions, exit, Japanese audio reveal and mute cleanup.
- `output/audit/browser-plan-sources.js`: pace adjustment, cancellation, supplementary failure/retry, atomic publication, immediate problem dividers, completed-plan reopening, mobile controls, all article source formats and PDF limits.
- `output/audit/upgrade-tutor-migration.mjs`: legacy Sakura is upgraded in place, with existing tutor IDs and classroom associations retained; preset subject wording is removed.
- Existing classroom browser scripts cover board rendering, notes export, synchronized reveal, muted playback, interruption and request timeouts.
- Launcher unit tests and isolated lifecycle audit validate schema readiness and owned process/database cleanup.

The API runtime creates an isolated database and mock model endpoint. Test output is in ignored `output/audit/*results.json`; browser screenshots are in `output/playwright/`. It must be shut down via the mock endpoint and the owned Compose database stopped without deleting its persistent volume.

## October 9, 2026 Results

Typecheck, lint and the production build passed. Focused learning-plan tests passed (3); provider/parser checks passed (13); existing API regression groups passed (18); upgrade API groups passed (11), including canceled version rejection and sparse initial draft resume. The separate tutor migration check passed. Launcher unit tests passed (10), and its isolated lifecycle audit passed (20), including owned process/container cleanup.

Browser checks passed for English/Japanese reading, all article source formats, exam PDF/image upload, settings, selective plans and reopening completed plans. Existing classroom checks passed for board rendering and notes export, Japanese audio reveal, mute, ordered interruptions, voice timeouts and goodbye/return gating. Desktop and mobile screenshots were inspected. Final API checks ran sequentially after launcher checks, avoiding concurrent rebuilds of the shared `.next` directory.

These checks use simulated models/audio. They do not verify real selection quality, OCR completeness, answer correctness, textbook citations or Fish voice quality. Goal quotes guard recorded progress and do not independently prove semantic mastery. Reading exercises are open dialogue records rather than a validated question bank.
