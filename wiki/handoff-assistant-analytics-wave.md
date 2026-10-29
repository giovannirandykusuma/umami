# Handoff: assistant-analytics-tools build wave

From ashiato MAIN 01a1866e, 2026-10-29. Randy approved the build ("both in parallel"). Lanes for this repo must launch from a session in this repo. **No deployment without Randy's separate explicit OK.**

- Spec (fourth judge ACCEPT): `wiki/specs/assistant-analytics-tools.md` (16709f174).
- MAIN-first protocol is done and pushed: 88d9816c6 + 388d643e3 (`result-chart` part, `AssistantSeries`, `AssistantSeriesMetric`, `AssistantChartKind`, `AssistantToolError`). Lanes must not change protocol.ts.
- Leave the pre-existing `runtime.ts` pi-lens wrap diff alone.
- All roles: cx/gpt-6.1-sol medium (.shikumi.json). Fresh judge per lane. ui-judge for result-chart-ui.

## Wave 1 (parallel)

### analytics-tools (hard)
Goal: the spec's analytics-tools lane:
- typed tools `analytics_schema`, `find_people`, `query_series`, `query_breakdown`, `query_totals`;
- new read-only `people` + `people/count` routes/queries (PG + CH, as §1 specifies);
- typed filter encoding, with `unsupported_filter`/`unsupported_metric` raised before any fetch;
- a resultId store scoped by trusted (userId, chatId, turn) from handlers.ts (turn advance, chat-delete clear);
- strict `show_chart` (resultId → `result-chart` part, or a strict widget with an exact-path `invalid_chart`);
- `AssistantToolError` for `umami_api` and the typed tools;
- `playbook.md` + `prompt.ts`;
- tests §5A and §5B.

Owns: `src/lib/ai/assistant/analytics/**, src/lib/ai/assistant/analytics.integration.test.ts, src/lib/ai/assistant/tools.ts, src/lib/ai/assistant/tools.test.ts, src/lib/ai/assistant/handlers.ts, src/lib/ai/assistant/handlers.test.ts, src/lib/ai/assistant/prompt.ts, src/lib/ai/assistant/prompt.test.ts, src/lib/ai/assistant/playbook.md, scripts/ai/assistant-tools.mjs, src/queries/sql/people/**, src/app/api/websites/[websiteId]/people/**, src/queries/sql/index.ts`

Acceptance: spec items 1, 2 and 4.
- 1: node 22 vitest. node 26 fails on jsdom localStorage.
- 2: synthetic engines per `docs/ai-discovery-integration.md`, schema `analytics_integration`, 7 tests, 0 skipped.
- 4: tsc = 4 errors, plus `git diff --check`.

Context:
- Never take userId/chatId from tool args.
- People search: literal, escaped, empty-id exclusion, aggregate by distinct_id before the limit of 11.
- Series metrics: only pageviews, visitors and events.
- Format with `npx --yes pnpm@12.3.4 exec biome format --write`.
- No live model calls, no deploy.

### result-chart-ui (standard)
Goal: render the `result-chart` part in the Assistant timeline:
- existing `components/charts/Chart`/`BarChart` plus a table toggle;
- show the label, metric, range, timezone and applied filters;
- never use `WebsiteChart`;
- an invalid legacy `chart` part shows a clear error, not an empty "Select a website".

Owns: `src/app/(main)/assistant/**, tests/e2e/assistant.spec.ts`

Acceptance: spec items 1 (assistant dir), 3 and 4.
- 3: `paseo script start ai-ui-fixture`, then Playwright. The new mocked result-chart case shows the seeded total.
- Also capture light, dark and narrow screenshots into shots/ for the ui-judge.

## Wave 2

eval (standard) — Owns `scripts/ai/eval-analytics.mjs, docs/ai-analytics-eval.md`. Blocked by analytics-tools. Acceptance item 5 is informational. A live model run needs Randy's OK for model spend on synthetic data. MAIN logs baseline and candidate in wiki/log.md.

## Evidence (private, do not copy into this public repo)
`/Users/randy/Developer/work/ashiato/wiki/research/{umami-assistant-quality,analytics-assistant-prior-art,umami-tracking-practices}.md`
