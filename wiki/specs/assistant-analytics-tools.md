# assistant-analytics-tools — spec

Rung: epic · Autonomy: auto · Date: 2026-10-29 · Status: draft for Randy's approval (no build yet)
Builds on: [global-assistant](global-assistant.md) (full user-authorized API, delete confirm, persistent chats, native Pi RPC — all kept).
Evidence (private, Ashiato): `wiki/research/umami-assistant-quality.md` (production chat diagnosis), `analytics-assistant-prior-art.md` (Umami MCP, community MCPs, PostHog/Mixpanel/Amplitude), `umami-tracking-practices.md` (Umami data model + docs).

## Problem (observed in the deployed Assistant, 14-turn production chat)

The Pi loop, auth and streaming work. The **analytics competence layer** is missing:

| Symptom the user saw | Root cause in code |
|---|---|
| "0 unique users" although events were tracked | Only pageview stats endpoints are taught (`prompt.ts`). Nothing explains event-only apps, or visitors (sessions) vs identified users (distinct ids). |
| "No names/emails" until corrected | Identity lives in **session data** (identify traits). The model searched **event data**. No tool or prompt mentions `session-data/*`. |
| "Chart displayed" ×4, no usable graph | `show_chart` accepts any `props` (`additionalProperties: true`). It emits the chart and returns the literal `'Chart displayed'` (`tools.ts:183`). The model nested `websiteId` in `props`, so the renderer showed "Select a website". |
| Click series never became a chart | `WebsiteChart` renders pageviews only. It ignores supplied data, event and `distinctId` filters and chart type. Fixing the website id would still show the **wrong metric**. |
| Retries on bad calls | `umami_api` returns `"404 <html…>"` / `"400 …"` as normal text (`isError:false`). Unknown query keys are dropped silently by the route's zod schema, so a filter can vanish and the call still returns 200. |

Prior art agrees (Mixpanel Run-Query → Display-Query; PostHog query-bearing visualization artifacts; Amplitude query-definition rendering). The model chooses **what** to ask. The host executes a **typed query**, and the chart and the text both use **that result**. Umami issue #4563 (valid filters → HTTP 200 zeros) shows that types alone are not enough. Semantics need tests on seeded data.

## Goal

The question "plot staff member X's clicks over the last 7 days" (and the regression set below) works end to end. The text and the chart show the same host-computed numbers. Failures are explicit and repairable. Full authorized API access remains for the long tail.

## Non-goals

- No SQL tool, no new chart engine, no multi-agent/reviewer layer, no model switch in this epic (measure first).
- No change to auth ceiling, delete confirm, chat persistence or Pi transport.
- No cross-website "unique people" metric.

## Design

### 1. Typed analytics tools (host-executed with the requesting user's bearer)

| Tool | Executes | Returns |
|---|---|---|
| `analytics_schema` `{websiteId, startAt, endAt}` | existing routes: `metrics?type=event`, `event-data/properties`, `session-data/properties`, `stats`; new `people/count` | event names + counts, event-data keys, **session-data keys**, pageviews/visits/visitors, identified-user count, `hasPageviews`/`hasCustomEvents` |
| `find_people` `{websiteId, startAt, endAt, search (≥2 chars), property?}` | **new** `GET /api/websites/{id}/people` | ≤ 10 candidates `{distinctId, matchedProperty, matchedValue, sessions, lastAt}`, `truncated` |
| `query_series` `{websiteId, startAt, endAt, unit, timezone, metric, filters}` | `pageviews` (metric `pageviews`/`visitors`) or `events/series` (metric `events`) | `{resultId, metric, unit, range, timezone, appliedFilters, buckets[], total, truncated}` |
| `query_breakdown` `{…, dimension, limit ≤ 50}` | `metrics` | `{resultId, rows[], truncated}` |
| `query_totals` | `stats` + `people/count` | `{resultId, pageviews, visits, visitors, identifiedUsers}` with labels |

- **People lookup (new, read-only).** One parameterized query over `session_data`, which already stores `distinct_id` per trait row (`prisma/schema.prisma:237-247`; ClickHouse `db/clickhouse/schema.sql:76-90`). Existing `sessions?search=` only matches distinct_id/city/browser/os/device (`getWebsiteSessions.ts:30-36`), and `session-data/values` returns values without ids, so neither can resolve a person.
  - Search: the term is trimmed and must be 2–100 chars after trimming (else 400). It is a **literal** case-insensitive substring: `%`, `_` and `\` are escaped (`ILIKE … ESCAPE '\'` / ClickHouse `positionCaseInsensitive`), so `__` or `%%` match only those characters. Optional `property` restricts `data_key` exactly.
  - Anonymous exclusion: `distinct_id IS NOT NULL AND distinct_id <> ''` (ClickHouse `distinct_id` is a non-null String).
  - Aggregate **by `distinct_id` first, then limit**: per candidate, `matchedProperty`/`matchedValue` = the lexicographically smallest matching (data_key, string_value), `sessions` = `count(distinct session_id)` over all matching rows of that id, `lastAt` = max(created_at). Order `lastAt desc, distinct_id`, limit 11. An 11th row means `truncated: true`, and the response holds 10.
  - `GET /api/websites/{id}/people/count` = identified users **active in the range** (event time, same meaning as visitors). PostgreSQL: `count(distinct session.distinct_id)` from `website_event` joined to `session` on (session_id, website_id), with `website_event.created_at` in range (PG `website_event` has no distinct_id). ClickHouse: `count(distinct distinct_id)` from `website_event` with `created_at` in range (CH has no `session` table; `db/clickhouse/schema.sql:2-55`, cf. `getSessionMetrics.ts:95-104`). Both: website-scoped, `distinct_id <> ''` / not null, performance events excluded.
  - Both routes: `canViewWebsiteSection(auth, websiteId, 'sessions')`, same as `session-data/values`. PostgreSQL + ClickHouse branches mirror `src/lib/ai/discovery.ts`.
- **Series metrics are limited to what routes compute:** `pageviews`, `visitors` (the `sessions` series of the `pageviews` route) and `events` (`events/series`, with `event` filter). Any other metric (`visits`, `identifiedUsers`) → `unsupported_metric`. Those are totals only in this epic.
- **Filters**: typed object `{distinctId?, event?, path?, …filterParams, eventProperty?: [{name, op, value, type}], sessionProperty?: [...]}`. Property filters encode to `epfN`/`spfN` = `<dataType>.<op>.<name>.<value>` (`src/lib/params.ts:181-245`), which `parseRequest` re-adds after zod (`src/lib/request.ts:37-44`). Every other key must be in the target route's schema. A key outside it → `unsupported_filter` **before** any HTTP call (zod otherwise strips it silently and returns 200).
- **Result store**: `resultId` = random UUID, stored in-process under the trusted `(userId, chatId)` from `handlers.ts` (never from tool args) with the turn generation that created it. Valid in that turn and the next turn of the same chat; older, foreign or unknown → `unknown_result`. LRU ≤ 50 per chat. Entries for a chat are dropped on chat delete and when the server process restarts. A cancelled turn keeps its results until the next turn ends (same rule).
- **Host context seam**: `executeTool(name, args, {credentials, interaction, fetch?})` gains `context: {userId, chatId, turn}`, built in `handlers.ts` from the authenticated request and a per-chat turn counter. The `handlers.ts` changes are this context, the turn-counter advance at turn start, and a result-store clear in the chat DELETE handler. All are owned by analytics-tools.
- `umami_api` stays for the long tail, with a short endpoint catalog in the prompt. Only its error shape changes (§3).

### 2. Result-backed charts

- `show_chart` accepts either `{resultId, kind: 'line'|'bar'|'table', title?}` or a **strict** board widget: per-type schema, `websiteId` top level, no extra props, allowed metrics per type. An unknown field → `invalid_chart` with the exact path (e.g. `props.websiteId`).
- New protocol part `{type:'result-chart', id, title, kind, series: {label, metric, unit, range, timezone, appliedFilters, buckets, total}}`. It renders with `src/components/charts/Chart`/`BarChart` and an always-available table toggle. It never uses `WebsiteChart`.
- Size: buckets ≤ 400 and the part ≤ 8 KiB. Larger → `result_too_large` (ask for a coarser unit). No silent truncation, so text and chart can never diverge.
- The tool reply is `{ok:true, status:'queued', partId}`, never "displayed". No browser render acknowledgement in v1: the payload is host-built and validated, and rendering is proven by Playwright (cut per review — late renders after turn end have no lifecycle owner).

### 3. Honest errors

`umami_api` and typed tools return `{ok:false, status, code, message, retryable}` with `isError:true`. HTML/stack bodies are stripped. 2xx returns `{ok:true, data}`. An empty result is `ok:true` with `empty:true`. A truncated result carries `truncated:true`.

### 4. Analytics playbook (prompt, ≤ 1.2 k tokens, shipped file `src/lib/ai/assistant/playbook.md`)

- Call `analytics_schema` first for an unfamiliar site or range.
- The four counts: pageviews, visits, visitors = sessions, identified users = distinct ids. Always name the one used.
- Event-only apps: report events and identified users, never "0 users".
- People: identity is in session data (identify traits). Resolve with `find_people`, then filter by `distinctId`. If there is more than one candidate, `ask_user` with the candidates' matched values. Never align separate name/email lists.
- Answer and chart from the same `resultId`. Say "tracked clicks", not "clicks". Show first/last activity, never "active time".
- Do not claim absence from a truncated or capped result.

### 5. Regression set

**A. Unit (no DB):** `src/lib/ai/assistant/analytics/*.test.ts` with an injected fetch. Covers filter encoding (`epfN`/`spfN`), `unsupported_filter`/`unsupported_metric` before any fetch, the error shape for 400/404/HTML, strict chart validation (`props.websiteId` path), `result-chart` emission with identical buckets, `result_too_large`, resultId scoping (foreign user, foreign chat, expired after turn+1, dropped on chat delete); handler passes trusted context, and a tool arg named userId/chatId is ignored. People query builder unit test, both engines: escaping of `%`/`_`/`\`, empty-id exclusion, aggregate-before-limit SQL shape, people/count source table per engine (PG join session, CH website_event) with range + empty-id predicates (ClickHouse is covered at this level only; production runs PostgreSQL).

**B. Integration (opt-in, real SQL):** `src/lib/ai/assistant/analytics.integration.test.ts`, gated by `AI_ANALYTICS_INTEGRATION=1` (a skip is not a pass). It uses the existing synthetic PostgreSQL from `scripts/ai/synthetic-engines/setup.sh` (see `docs/ai-discovery-integration.md`) and calls the real route handlers with a signed non-admin session. Seed:
- site A, event-only: no pageviews, identified staff;
- staff names only in session data. "Dewi Anggraini" (distinct id `u_1`, 3 sessions) and "Dewi Ayu" (`u_2`). Names are never the distinct id;
- `u_1`: 7-day `ui.element_clicked` series with a known total and one day empty;
- site B: pageviews at an Asia/Jakarta day boundary;
- a user without access to site B.

| Case | Assertion |
|---|---|
| event-only | `hasPageviews=false`, `identifiedUsers=2` |
| person lookup | `find_people('Dewi')` → exactly `u_1`, `u_2`. `u_1` matches by name and email yet appears once with sessions=3 |
| wildcard | `find_people('__')` and `('%%')` → 0 candidates |
| anonymous | a session-data row with no/empty distinct id matching 'Dewi' is not returned |
| cap | 12 seeded "Staff NN" people → 10 candidates, `truncated:true`, no person duplicated |
| person series | `query_series(events, {distinctId:'u_1', event})` total = seeded total; Jakarta buckets match a reference |
| forbidden site | `find_people`/`query_*` on site B by the other user → 401, `{ok:false}` |

**C. Browser:** `tests/e2e/assistant.spec.ts` (API mocked via `page.route`, like the existing cases). The fake stream emits a `result-chart` part, and the test asserts the line chart canvas plus a table toggle showing the seeded total. A `chart` part with invalid props is never rendered as an empty "Select a website".

**D. Live eval (report only):** `scripts/ai/eval-analytics.mjs`, 6 synthetic prompts against the B fixture with the configured model. Pass = correct total in the text and a `result-chart` part with the same total. Run baseline (master) and candidate with the same model; MAIN records both in wiki/log.md.

Baseline red evidence is the diagnosis's synthetic reproductions (`ashiato wiki/research/umami-assistant-quality.md`). New tests are not claimed to exist on master.

## Acceptance (Umami checkout; node 22 — vitest jsdom localStorage fails on node 26)

1. `npx --yes node@22.23.4 node_modules/vitest/vitest.mjs run src/lib/ai "src/app/(main)/assistant" src/app/api/ai "src/app/api/websites/[websiteId]/people"` → exit 0.
2. With `sh scripts/ai/synthetic-engines/setup.sh` running and `DATABASE_URL` as in `docs/ai-discovery-integration.md` (schema `analytics_integration`): `AI_ANALYTICS_INTEGRATION=1 npx --yes node@22.23.4 node_modules/vitest/vitest.mjs run src/lib/ai/assistant/analytics.integration.test.ts` → exit 0, 7 tests, 0 skipped.
3. `paseo script start ai-ui-fixture` (port 3317), then `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3317 PLAYWRIGHT_SKIP_WEB_SERVER=1 npx --yes pnpm@12.3.4 exec playwright test tests/e2e/assistant.spec.ts` → all pass.
4. `./node_modules/.bin/tsc --noEmit 2>&1 | grep -c "error TS"` → 4 (baseline); `git diff --check` empty.
5. `node scripts/ai/eval-analytics.mjs` once on the synthetic fixture with the configured model. Baseline and candidate pass rates are logged (informational, not a gate).

## Lanes

| lane | tier | owns | blocked by | acceptance |
|---|---|---|---|---|
| (MAIN first) protocol | — | `src/lib/ai/assistant/protocol.ts` (`result-chart` part) | — | 4 |
| analytics-tools | hard | `src/lib/ai/assistant/analytics/**`, `src/lib/ai/assistant/analytics.integration.test.ts`, `src/lib/ai/assistant/tools.ts`, `src/lib/ai/assistant/tools.test.ts`, `src/lib/ai/assistant/handlers.ts`, `src/lib/ai/assistant/handlers.test.ts`, `src/lib/ai/assistant/prompt.ts`, `src/lib/ai/assistant/prompt.test.ts`, `src/lib/ai/assistant/playbook.md`, `scripts/ai/assistant-tools.mjs`, `src/queries/sql/people/**`, `"src/app/api/websites/[websiteId]/people/**"`, `src/queries/sql/index.ts` | protocol | 1, 2, 4 |
| result-chart-ui | standard | `"src/app/(main)/assistant/**"`, `tests/e2e/assistant.spec.ts` | protocol | 1, 3, 4 |
| eval | standard | `scripts/ai/eval-analytics.mjs`, `docs/ai-analytics-eval.md` | analytics-tools | 5 |

Workers, judges and probes: `cx/gpt-6.1-sol` medium. A fresh judge for each lane. ui-judge for result-chart-ui (light/dark, narrow, table fallback). `runtime.ts` is not touched (`handlers.ts` only for the context seam above). If the tool registry needs a runtime change, the lane forks back to MAIN.

## Review focus

- `resultId` cannot cross user or chat boundaries and lives at most until the end of the next turn; scope comes only from the handler context. Typed tools never exceed the user's route permissions (they call the same routes with the same bearer).
- `find_people` requires a search term and returns only the matched property/value per candidate (≤ 10). No bulk enumeration of names/emails, no other traits, no new PII store. Persisted tool results stay ≤ 8 KiB.
- No silent filter drop anywhere. The tz handling of buckets matches the upstream convention (`src/lib/prisma.ts:67-103`), with a reference test.

## Dependency on the tracking standard

Ashiato tracking standard v0.5 (separate spec) moves page views to native pageviews and request logs to `<app>-ops`. The playbook must handle both old data (`ui.page_viewed` events, `api.*` mixed in) and new data. `analytics_schema` surfaces which kind a site has.
