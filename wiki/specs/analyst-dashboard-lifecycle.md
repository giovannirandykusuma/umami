# Analyst dashboard lifecycle — specification

Rung: epic · Autonomy: ask · Run: 20261029-2039 · Date: 2026-10-29
Status: spec ready after consistency corrections; implementation, paid evaluations and deployment not started or authorized by this document.
Validation: read-only consistency probe found image/session privacy, verifier/UI stage dependency and existing-path ownership gaps. All three were corrected; structural/link/placeholder and conservative pairwise Owns checks pass. This is specification validation, not an implementation/security verdict.
Ambiguity: 0.065 after one grouped checkpoint and one follow-up — goal 1.0 · constraints 0.9 · criteria 0.9 · context 0.9. Brownfield formula: 1 − (goal×0.35 + constraints×0.25 + criteria×0.25 + context×0.15).

## Goal

An authenticated user can request an analytics dashboard in ordinary language; the assistant discovers relevant data, constructs and checks supported queries, saves a private live dashboard, rereads and executes its saved definitions, inspects its actual rendering, and repairs problems before accurately reporting what was verified.

## Approved scope and authority

Randy selected:

1. A constrained reusable analysis layer shared by chat and live board widgets, not native-widget-only output.
2. Autonomous creation and revision of new private drafts owned by the current task; explicit confirmation before edits to existing boards, sharing or deletion.
3. Actual screenshot inspection through a separate restricted browser-verification worker, not merely checking query output or render-status events.

The user's goal is the complete analyst workflow, not adding codemode. This document specifies the complete delivery, including contracts and runnable acceptance targets. Implementation must happen in `/Users/randy/Developer/work/umami`, not in the ashiato research checkout. This file is the canonical cross-repository specification; copy it unchanged into the implementation checkout before build and retain the source reference. No automatic build, push, paid evaluation or production deployment follows from writing the spec.

## Evidence baseline

Read-only source baseline: Umami `c1539bcdcd4674d0a509555b6f0ab53e9d43e5f8`. Prior independent production inspection found image revision `d487c2b7f2c68ec73d98ec3eb359151bcb784e98`, Pi 1.4.0, cx/gpt-6.1-sol medium. Rebase/reconcile current source before building; those observations are not proof of later deployment state.

Research: [workflow report](../research/analyst-dashboard-workflow.md), [native capabilities](../research/analyst-dashboard-evidence/umami-capabilities.md), [assistant trace](../research/analyst-dashboard-evidence/assistant-loop.md), [external patterns](../research/analyst-dashboard-evidence/external-patterns.md), [Pi runtime](../research/pi-assistant-capabilities.md), [identity caveats](../research/anamnesa-umami-identity.md).

## Non-goals

- Arbitrary SQL, database credentials, filesystem grep, shell tools, arbitrary JavaScript widgets, arbitrary browser navigation or external connectors.
- Cross-website identity joins, reconstructing an audit ledger, inferring event semantics from names alone, or promising analytics that instrumentation cannot support.
- Replacing Umami's native boards, saved funnels/goals, authorization system, official MCP or tracker.
- Migrating Anamnesa instrumentation or editing the reusable usage-tracking skill; that is separate work.
- Automatically converting historical chat snapshots into live queries. Existing chat snapshots remain viewable and explicitly historical.
- Mandatory codemode. The workflow must function through typed tools; orchestration optimization is a later, separately measured change.
- Autonomous edits of preexisting boards, publication, sharing or deletion without scoped confirmation.
- Unbounded retention of screenshots, raw event exports or model reasoning.

## Constraints

- Preserve native Pi RPC and confinement. Do not enable ambient skills, MCP, built-in shell/filesystem tools, worker permissions or general egress in the Pi process to make this feature work.
- Every read/write/execute/render operation derives identity from authenticated server state, never tool arguments. Recheck website/team/section access when executing saved definitions and when releasing results.
- Preserve existing board/chat APIs and old widget behavior. Additive migrations only; no destructive schema cleanup or rewriting existing board JSON.
- No change may cause ingest failure: deployment acceptance must include `/api/send` returning 200 and a verified stored synthetic event.
- Supported metrics, filters and date rules are executable schemas, not prompt-only promises. Never drop unsupported filters silently.
- Metadata, property values, titles, text widgets and model output are untrusted data. Render as text/sanitized markdown; no executable HTML or remote resources.
- Browser screenshots can contain sensitive analytics. Capture only the authorized draft canvas, minimize labels, bind artifacts to user/task/revision, never send other users' data, and never log image bytes.
- No new runtime paid-model helpers. Screenshot inspection uses the configured assistant model only if its image-input capability has passed preflight; otherwise verification is blocked honestly.
- Existing analytics deadlines/caps remain ceilings. Initial feature limits below may be lowered by deployment configuration, never raised by model input.

## User experience and completion vocabulary

The assistant shows a compact plan, sources, metric definitions and a live phase indicator. It asks only for material ambiguity the tools cannot resolve: business meaning, population, incompatible interpretations or a missing source. Do not ask the user to supply discoverable website IDs or property names.

Phases: `understand`, `discover`, `query`, `preview`, `save_draft`, `readback`, `execute_saved`, `render`, `inspect`, `repair`, `complete`. Phases may repeat; they are statuses, not fabricated reasoning. Raw tool JSON belongs in collapsed diagnostics, not the primary answer.

Final states:

- `verified`: saved revision read back; saved analyses executed with complete provenance; all required widgets rendered; screenshot inspected; no unresolved blocking mismatch. State observed date, freshness and scope.
- `data_verified_visual_pending`: definitions and data checked, but browser/model-image verification unavailable. Offer the draft and exact limitation; never say visually verified.
- `needs_input`: unresolved metric/source meaning or missing data capability; ask a bounded question and preserve safe progress.
- `blocked`: authorization, unsupported semantics, budget, unavailable verifier or persistent failure. Explain what exists and what remains unverified.
- `cancelled`: abort active work, preserve a labeled private partial draft if one was committed, never claim completion.

A structurally correct empty dashboard may be verified as empty only when data/query completeness is established. It must not be presented as proof of no real-world activity.

## 1. Reusable analysis contract

### 1.1 Durable definition

Add `SavedAnalysis` to the existing PostgreSQL metadata store. No new analytics database. Required fields:

- `id`, `ownerUserId`, optional `teamId`, `name`, optional description; ordinary timestamps.
- `schemaVersion: 1`, `revision` monotonic integer, `status: draft|ready`.
- `definition` strict JSON schema, normalized before hashing; `definitionHash` excludes presentation text but includes source, operation, metric, filters, date/timezone policy and semantic binding.
- `createdByTaskId` nullable for ownership of new drafts; lifecycle receipt/version, not credentials.

Owner/team behavior follows existing board permissions. Drafts are private owner-only until an explicitly confirmed operation changes visibility. A board must not indirectly expose a more restricted analysis; mixed references are validated both at save and execution. Archive/delete checks board references and never leaves silent dangling widgets.

Definition v1:

| Field | Contract |
| --- | --- |
| `source` | One authorized website ID; cross-source native widgets remain separate |
| `operation` | `series`, `breakdown`, `totals`, or `numeric_property` |
| `metric` | Operation-specific enum below; no free-form expression |
| `event` | Exact custom-event name where required; pageviews are a different dataset |
| `filters` | Existing supported typed event/session predicates and dimension filters, validated against operation compatibility |
| `groupBy` | At most one supported dimension; series uses a supported time unit |
| `datePolicy` | Fixed inclusive start/exclusive end milliseconds, or rolling `today|24h|7d|30d|90d`; resolved per execution. `today` starts at local midnight, `24h` is exactly 24 elapsed hours, and day ranges start at local midnight N−1 calendar days before today and end at now |
| `timezone` | Valid IANA name; required, never inferred from ISO suffixes |
| `semanticBinding` | Label, unit, population and meaning source: user-confirmed, trusted repository definition, or observed-only; observed-only cannot justify stronger business claims |
| `limits` | Host-owned effective limits returned in execution metadata, not model-supplied overrides |

Operation compatibility is an explicit tested matrix:

- `series`: pageviews, custom event occurrences, or session counts per bucket. Do not call the sum of bucket sessions whole-range unique visitors. Return `bucketSessionSum` separately when relevant and omit a misleading unique total.
- `breakdown`: occurrence/session/pageview counts by a supported existing native dimension. Event-property grouping is supported only for APIs that preserve requested event, filters and type; incompatible combinations return `unsupported_combination`.
- `totals`: only natively correct count/filter combinations. Whole-range identified users, visits and sessions are separate metrics. A requested filtered distinct count must be implemented with authorized scoped SQL and parity tests or explicitly rejected; never return an unfiltered substitute. V1 must provide unfiltered identified-user totals as already supported.
- `numeric_property`: event/session numeric property `sum|average|median|min|max|count`, only through supported native scoped operations. Property owner, type, event and filters must match; no string-to-number coercion. Missing values and zero are distinct. For aggregate-only endpoints, return an aggregate table; do not invent a numeric time series.

Canonical date normalization must adapt the fixed half-open interval to each native endpoint's actual boundary convention, with timestamp-boundary/DST fixtures; do not assume every native API already uses the same interval rule. A single task verification pass resolves its clock once so preview and saved replay are comparable.

Raw row access is not a saved-query operation. Bounded discovery/diagnostics may use existing authorized event APIs to answer a specific uncertainty. Do not retain those rows in definitions or screenshots unnecessarily.

Saved goals/funnels remain native definitions referenced by native widgets; no duplication of their DSL. Retention remains supported only with its actual session semantics; no new retention widget is promised here.

### 1.2 Execution envelope

One executor is used by chat preview, saved widget and verification. It takes trusted auth context plus normalized definition, resolves date policy once using an injected clock, and produces:

- definition ID/revision/hash when saved, execution ID and executed timestamp;
- resolved source, operation, metric/unit, date range and timezone;
- applied filters and semantic binding; unsupported fields fail before execution;
- structured columns/rows or time buckets; no arbitrary component props;
- completeness `complete|partial|unknown`, reason codes, returned/available counts where known, and freshness/cache metadata;
- warnings: observed-only meaning, missing collection coverage, capped results or incompatible uniqueness interpretation;
- structured error `{code,message,retryable,field?}`, without SQL, credentials or raw HTML.

A missing stats key is `missing_metric`, not zero. Aggregates are null where unavailable, never NaN/Infinity. Zero is accepted when explicitly returned by a valid complete query. Top-N breakdowns are labeled top-N, with remainder/coverage only when calculable. Server computes metrics; the model does not manufacture bucket arithmetic or extrapolate capped samples.

The saved definition, not a temporary resultId or response body, is the replay source. Keep existing snapshot charts unchanged.

### 1.3 API and resource lifecycle

New authenticated API routes:

- `GET/POST /api/analyses`: authorized list/create; bounded pagination. Create uses a client operation key scoped to principal/task.
- `GET/PATCH /api/analyses/{id}`: read/update. PATCH requires expected revision and a validated patch.
- `POST /api/analyses/preview`: execute a normalized unsaved definition, read-only in analytics.
- `POST /api/analyses/{id}/execute`: execute saved definition with current permissions; no caller override of source/filters.

No public sharing endpoint for analyses in this epic. Attempting to share a board containing `AnalysisWidget` returns an explicit unsupported-sharing result until a secure public execution contract exists; do not remove the widget or leak private data.

Add board-level optimistic revision to mutation responses. Existing non-agent API clients remain compatible; agent mutation tools require expected revision. Atomic agent commits verify all referenced sources/analyses and update board layout plus new analyses in one metadata transaction. If existing endpoints cannot provide this, introduce `/api/analyst/tasks/{taskId}/commit`; do not emulate atomicity with sequential model calls. Analysis execution and screenshot capture occur after commit and cannot be part of a database transaction.

Store idempotency key, request hash and committed result under principal/task. Same key+same request returns the original result; different payload returns conflict. A verification failure does not delete a committed draft. A cancellation before commit leaves no new board; after commit leaves a clearly labeled partial draft.

## 2. Persistent widget contract

Add `AnalysisWidget` to the native board registry. Its configuration contains `analysisId`, optional title, and visualization `line|bar|table|metric`; it does not contain raw rows, resultIds, SQL, JavaScript or duplicated filters.

- Board save validates analysis access, renderer compatibility and source references.
- Widget uses the same execute endpoint and semantic envelope as chat.
- Display metric definition, resolved date/timezone, execution time and completeness warnings through an accessible details control.
- Rolling definitions recompute on explicit refresh and on normal mount/staleness behavior; no claim of realtime. Default refresh is explicit; optional automatic refresh is bounded to at most once per minute while visible.
- Fixed definitions remain fixed even when the global board date changes. A fixed/rolling badge makes this visible. For v1 there is no hidden global-date override; changing saved date policy is an explicit definition edit.
- Unknown operation/schema version and deleted/inaccessible source produce visible unsupported/denied states, not empty zero charts.
- Model-chosen chart kind is validated against returned shape; fallback to table only with a visible reason, not silent semantic substitution.
- Opening in a new session/process with fresh data must work without original chat state or process memory.

Native widgets remain valid, and drafts can combine native and saved-analysis widgets. Unsupported requests are explained before any promise of faithful persistence.

## 3. Task, tools and authority

### 3.1 Server-owned task state

Persist `AnalystTask` with principal, chat, goal, status, budgets, new-draft IDs, operation keys and verification receipts. Store bounded structured context, not chain-of-thought. Bind every tool call to the authenticated chat/task; user/model fields cannot select another principal. Persisted state includes executed definition versions, private draft IDs, confirmation/receipt references and consumed budgets so resuming/retrying cannot reset safety limits. User-wait pauses are server-owned; only validated pending clarification/confirmation states pause the clock, with a 24-hour task expiry. Revalidate all authority on resume; do not reuse expired screenshots or confirmation grants.

Initial hard ceilings: 5-minute task execution window excluding user-wait time, 40 total tool calls, 20 analytics executions, 3 query executions concurrently, 12 widgets, 2 render attempts plus 1 repair rerender. Preserve existing stricter per-operation bounds; per-query timeout maximum 10 seconds, output maximum 200 buckets/rows and 32 KiB structured data, with chat summaries no larger than current host budgets. Query narrowing is explicit; no mid-JSON truncation. Timers propagate AbortSignal into fetch/DB/worker operations. Exhaustion yields resumable blocked state, not a fresh budget via tool renaming or nested calls.

### 3.2 Typed tools

Add task-scoped tools with precise descriptions and schemas:

- `analyst_discover`: authorized source list, date coverage, observed taxonomy, metric capabilities and existing analyses/boards. No bulk property-value enumeration.
- `analyst_preview`: validate/execute a supported definition; returns provenance and completeness.
- `analyst_plan_board`: validate a proposed layout/definition bundle without mutation; returns a diff and unsupported requirements.
- `analyst_commit_draft`: idempotent atomic create/update of this task's private draft resources only.
- `analyst_readback`: stored board/definition revisions, execution results and comparison against intended bundle.
- `analyst_verify_render`: fixed board/revision capture request and later bounded receipt/images.
- `analyst_record_inspection`: model's screenshot observations keyed to artifact hashes, widget IDs and revisions; code validates shape, not truth of visual judgment.
- `analyst_request_change`: exact proposed diff for an existing board and dependencies; produces trusted confirmation, then applies only that revision-bound change.

Native API reads remain available where safe. Existing generic `umami_api` must not bypass the new authority rules. Host classifies board/analysis/task-affecting writes by canonical route/method and enforces confirmations/draft ownership. Unknown writes default to confirmation or denial; POST is not automatically harmless. No method-alias, alternate endpoint or nested body can bypass sharing/deletion/edit rules. Retain authenticated API permissions as an independent boundary.

### 3.3 Confirmation rules

New task-owned private drafts may be created/revised automatically. A board existing before the task is an existing board even if private, created by the same user or named “draft.” Resuming a task can revise only its own unchanged private draft; unexpected revision/visibility changes require a new confirmation.

Before editing an existing board or saved analysis, show target, exact changes, source/metric/date changes, affected dependent boards and expected revisions. Confirmation is principal/task/diff/revision-bound, single-use and expires after 10 minutes. Rejection/timeout means no mutation. A stale revision returns conflict and requires reread/reconfirmation. Publishing/sharing/deleting always requires separate explicit confirmation, subject to supported capability; unsupported sharing remains denied even after confirmation.

Do not modify a shared saved analysis as a side effect of editing one board. Default to copy-on-write for existing referenced analyses and replace references only in the confirmed target board. In-place edits require an explicitly expanded impact confirmation.

### 3.4 Understanding and repair policy

Discover before claiming a metric is measurable. Reuse existing matching definitions only after reading semantics, source, filters and date policy. Do not infer event-success/login meaning from names. Ask material ambiguity; otherwise proceed with visible assumptions.

Preview first, then save, reread, execute saved queries and compare normalized intent/hashes/results under the same resolved clock. Compare fresh-data queries using deterministic fixtures/tolerances, not arbitrary exact equality across a moving production window. On real data, record distinct execution timestamps and explain legitimate movement.

Repair only the failing query/widget/layout, within remaining budgets. Never drop filters, change population, replace unique counts with sessions, or widen access to make a check pass. Semantic changes require clarification; existing-board edits require renewed scoped confirmation. Two unsuccessful repairs stop with an honest partial result.

## 4. Restricted browser verification

### 4.1 Worker boundary

Use a separate Node/Playwright process or service with its own restricted OS/container identity. Pi gets no generic browser, URL, cookie, selector, filesystem or network tool. The host creates a verification job containing board/task/revision and a short-lived one-use capability; the model cannot supply a URL or credentials.

The worker can reach only the configured application origin and required internal verification endpoints. Network policy must block other origins, redirects to external hosts, metadata/link-local services and Internet resources. Browser-side route filtering alone is defense in depth, not a claim of OS egress isolation. Use packaged fonts/assets; block arbitrary links, downloads, popups and service workers. No mounted production secrets or host filesystem.

The capability grants read-only rendering of exactly that board revision and referenced authorized analyses, expires within 60 seconds and is audience-bound to the verifier. Do not inject the user's reusable cookie into the worker. Exchange the capability for a narrowly scoped HttpOnly verifier session, immediately remove token material from URL/history, and never log it. Application APIs must recognize that session as read-only and restricted; no generic auth impersonation endpoint. If permissions are revoked or revisions change, abort and discard artifacts.

A deployment without the isolated verifier remains usable for data verification but cannot produce `verified` visual status. No unsafe fallback browser on the application host.

### 4.2 Render receipt and screenshot inspection

Instrument native and AnalysisWidget rendering with job-local widget IDs and states `loading|rendered|empty|error|denied|unsupported`. Receipt binds board revision, analysis revisions/hashes, query execution IDs, viewport, render completion time, console/page errors and screenshot artifact hashes.

Capture desktop 1440×1000 and narrow 390×844 views; paginate/crop the board canvas with overlap rather than shrinking illegibly. No arbitrary page screenshot. At most 6 JPEG/PNG images per job, each at most 1 MiB; total job image payload at most 6 MiB. If more panels are needed, report incomplete visual coverage; do not claim full visual verification. Worker timeout 30 seconds excluding queue, queue wait maximum 30 seconds; one running job per user, at most two globally initially. Clean browser context after every job.

Transport must account for base64 expansion, JSON framing and repeated RPC events, not only decoded image bytes. The existing 8 MiB whole-stream ceiling is insufficient for six 1 MiB images. Add a separately metered image-bearing event path with a maximum 32 MiB encoded transport budget per verification attempt and retain the existing 8 MiB limit for non-image content. Count all repeated encoded image bytes against the image budget; abort cleanly if duplication exhausts it, rather than silently dropping images or disabling stream limits. Provider/request limits can lower these bounds. A maximal-payload synthetic round-trip and an over-budget case are required before release.

Host releases only validated MIME/size images and sanitized receipt through a dedicated extension result path. Existing string-only UI bridge must be extended deliberately: convert validated host image payloads into Pi image content blocks; never print base64 into text/tool diagnostics. Maintain separate image and JSON budgets. Preflight the configured model/provider for image input using synthetic content before enabling screenshot inspection; failure produces visual-pending status without choosing another paid model silently.

The assistant inspects labels, chart type, axes, date/timezone, units, missing/error panels, clipping and narrow-layout readability. Its structured observations cite widget IDs and screenshot hashes. Automated receipts prove loading/execution state, not aesthetic truth; model inspection remains fallible. Final text says “inspected” and describes coverage, not a guarantee of perfect visuals.

### 4.3 Artifact privacy

Screenshot delivery to the model is transient. Before persisting or restoring native Pi JSONL sessions, assistant message/tool parts or task records, replace image blocks with validated text placeholders containing only artifact hash, revision and inspection receipt. Redact before diagnostic serialization, not after truncation. Do not store base64 prefixes, image URLs/capabilities or image bytes in chat/session tables, SSE events, RPC diagnostics, failure logs or restored context. Temporary native session files may contain images only within private per-turn scratch storage and must be removed on success, failure and cancellation, within the image retention ceiling. Session sanitization must preserve valid Pi message/tool-call structure and resumable non-image context; do not solve privacy by silently losing the entire session. Reinspection obtains a newly authorized artifact rather than restoring an old image. Negative tests must search persisted chats, native sessions/restores, streamed parts and diagnostics for seeded image markers and capability values.

Artifacts are private principal/task resources; signed fetch URLs expire in 60 seconds and are not included in public board JSON. Retain image bytes in private ephemeral storage for at most 15 minutes, then delete. Durable receipts contain hashes, revisions and sanitized status only, no screenshot bytes or capability tokens. Deleting a task/chat schedules immediate image cleanup. Browser/model failure paths must also clean artifacts. Metrics/logs contain counts, timing and codes, not personal labels, raw query results or screenshots.

## 5. UI behavior

Global assistant remains the primary entry point; board-context entry supplies board identity and explicit edit scope. Do not silently route between the older local board-draft chat and the global assistant.

- Show compact plan and current assumptions; allow clarification/free text, cancellation and safe resume.
- Draft preview shows live-vs-snapshot badges and each metric's definition, date policy and completeness.
- Show a board link once committed, clearly marked private/partial until verification completes.
- Existing-board confirmation presents an accessible diff and impact; keyboard focus and cancel behavior are tested.
- Verification panel separates definition readback, saved-query execution and visual inspection. Pending/unavailable checks remain visible.
- Tool cards use plain-language summaries; raw JSON is optional collapsed diagnostics. Never display raw model reasoning as evidence.
- Charts use the same structured execution results for text/table/visuals. No independently refetched substitute chart with different filters.
- Narrow layout, keyboard navigation, screen-reader labels, empty/loading/error/permission states and long labels are in scope. Follow existing Umami styling rather than redesign the entire app.

## 6. Compatibility, rollout and operations

Additive metadata migrations introduce SavedAnalysis, AnalystTask, operation records and board revision. Keep old records valid with default revisions. Reads tolerate older native widget types. Unknown future analysis versions fail visibly and remain readable for export/edit; no silent reinterpretation.

Feature flags: `AI_ANALYST_ENABLED` gates new task/tools/UI; `AI_ANALYST_VERIFIER_ENABLED` separately gates worker dispatch. Flags default off. Existing charts, boards and ingest work with both off. Execution of existing AnalysisWidgets remains available to authorized users when assistant creation is off; disabling verifier does not disable normal board rendering.

Deployment order: migrate metadata, deploy API/executor/widget readers, deploy isolated verifier and run synthetic preflight, then enable analyst tools/UI. Gate every stage with synthetic auth/ingest checks. Rollback disables creation first and preserves additive data; do not remove schema or deploy an old reader that silently discards AnalysisWidget. Prepare a source-bound compatible rollback image and backup before rollout; prior log says old backups were deleted, so do not assume one exists.

No production data used as fixtures. PostgreSQL and ClickHouse analytics paths receive semantic parity tests. Metadata transaction/idempotency tests use disposable PostgreSQL. Explicit environment validation refuses production hosts/databases in test harnesses.

## 7. Acceptance scenarios and evaluation

Synthetic Anamnesa-style fixtures are acceptance examples, not a statement that production already contains these events. Include product and ops websites, identified and anonymous sessions, duplicate activity across buckets, numeric values including null/zero, typed properties, ambiguous event names, two users/teams, rolling boundaries and permission revocation.

Required scenario set:

1. Staff activity dashboard with exact observed-event labels, identified-user total and daily occurrence series; product and ops displayed separately, never identity-joined.
2. Filtered event/person series saved, process restarted, reopened with identical semantics; add new fixture events and prove rolling query changes while fixed range remains fixed.
3. Numeric property aggregate rendered as a metric/table; unsupported numeric series/grouping rejected, not approximated.
4. Legitimate zero vs missing metric vs no collection coverage vs top-N/capped output.
5. Reuse an existing semantically matching analysis; reject a similarly named definition with different population/filter.
6. Material ambiguity asks a meaningful question; source IDs and schema facts discovered without user prompting.
7. Unauthorized/foreign/stale references and revoked access denied at preview/save/execute/render/artifact release.
8. Duplicate commit returns same board; conflicting key/revision and partial failure do not create duplicate or partial metadata bundles.
9. Existing-board edit, sharing and deletion cannot bypass confirmation through generic API tools or method aliases; declined/stale approval leaves resources unchanged.
10. Browser render failure, missing image capability, inaccessible verifier, clipped/narrow widget and stale screenshot revision cannot yield verified status.
11. Cancellation at query, commit boundary, queue, rendering and repair; no late mutations/updates or leaked images.
12. Existing native boards and historical chat snapshots remain unchanged with feature flags off.

All deterministic fixtures have expected outcomes maintained independently of model output. Offline tests must not count mocked model/tool responses as proof of live model reasoning or visual understanding.

Paid evaluation is a separately approved release gate: same configured model/settings, baseline and candidate, at least 12 ordinary-language scenarios with 3 runs each, all failures recorded. Evaluate discovery/semantics, numbers, persistence/replay, authority, visual claims, latency and cost separately. Every safety scenario must pass; every required supported lifecycle scenario must succeed in all three runs before broad rollout. If not, keep feature gated and report actual rates; never cherry-pick. Record source/image revision, fixture hash, provider/model, reasoning, costs and screenshot coverage. Approval must include a spend ceiling before any calls; no unspecified automatic spend.

## Acceptance (runnable; implementation targets)

Run from `/Users/randy/Developer/work/umami` after dependencies are installed. New files/scripts named here are deliverables, not claims of existing tests. Commands must fail on missing fixtures/assertions or empty test selection. No new package scripts required; lockfile/dependency changes are serialized by MAIN.

- **A1** `npx --yes pnpm@12.3.4 exec vitest run src/lib/analyst src/permissions/analysis.test.ts src/queries/prisma/analysis.test.ts src/lib/boards.test.ts` → exit 0; strict definition/metric matrix, dates, missing/zero, permissions, idempotency, optimistic concurrency, reference validation and native-board compatibility pass.
- **A2** `npx --yes pnpm@12.3.4 exec tsx scripts/test-analyst-api.ts --postgres` → exit 0 against a disposable seeded stack; create/read/execute, atomic commits, confirmation binding and restart/fresh-data scenarios pass; refuses production configuration.
- **A3** `npx --yes pnpm@12.3.4 exec tsx scripts/test-analyst-api.ts --clickhouse` → exit 0 with equivalent analytics outcomes; executes actual ClickHouse queries, not a stubbed branch.
- **B1** `node --test scripts/ai/verifier/*.test.mjs` → exit 0; capability lifecycle, allowlist/egress rejection, artifact cleanup, bounds, revocation, non-image responses and timeout/cancellation tests pass.
- **B2** `npx --yes pnpm@12.3.4 exec playwright test -c playwright.config.ts tests/e2e/analyst-verifier.spec.ts` → exit 0; real browser captures a deterministic fixture render adapter with desktop/narrow receipts and injected failure states without a model call. This proves verifier-stage transport/security behavior only, not real AnalysisWidget integration.
- **B3** `npx --yes pnpm@12.3.4 exec playwright test -c playwright.config.ts tests/e2e/analyst-verifier-integration.spec.ts` → exit 0 after UI and MAIN integration; captures actual native and AnalysisWidget renderers against seeded APIs, validates widget/query revisions and receipts, and rejects stale/failed renders. Required for full feature acceptance, not verifier-stage merge.
- **C1** `npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/assistant src/app/api/analyst` → exit 0; native RPC bridge, task budgets, authority bypass attempts, repair policy, receipts, maximal image-block transport and negative screenshot/session/diagnostic persistence assertions pass.
- **C2** `node --test scripts/ai/assistant-tools.test.mjs` → exit 0; exact tool schemas/allowlist, structured errors and image content preserve confinement and existing tool behavior.
- **D1** `npx --yes pnpm@12.3.4 exec vitest run 'src/app/(main)/assistant' 'src/app/(main)/boards'` → exit 0; UI state/confirmation and AnalysisWidget tests pass with source/provenance fidelity.
- **D2** `npx --yes pnpm@12.3.4 exec playwright test -c playwright.config.ts tests/e2e/analyst-lifecycle.spec.ts` → exit 0; full synthetic create→readback→execute→render→repair workflow, existing-board confirmation, reopen/fresh data, cancellation, flags-off and narrow/keyboard checks pass.
- **E1** `npx --yes pnpm@12.3.4 exec tsx scripts/ai/eval-analyst.ts --offline --strict` → exit 0; all 12 scenario groups exercised, missing/unverified evidence cannot score as verified, baseline/candidate labels honest, no network/model calls.
- **E2** `npx --yes pnpm@12.3.4 exec tsx scripts/ai/eval-analyst.ts --check-report docs/ai-analyst-eval.json` → exit 0 only for a source-qualified approved live evaluation meeting the scenario/run/safety thresholds; missing live report is NOT PASS and blocks broad rollout, not offline implementation review.
- **I1** `npx --yes pnpm@12.3.4 exec tsc --noEmit && git diff --check` → exit 0; if upstream type errors exist, attach recorded baseline and exact changed-path diagnostics, and resolve all introduced findings before acceptance.
- **I2** `npx --yes pnpm@12.3.4 openapi:check && npx --yes pnpm@12.3.4 check:api:client` → exit 0 after generation; new routes/contracts stay synchronized without changing old client behavior.
- **I3** `npx --yes pnpm@12.3.4 exec tsx scripts/ai/release-analyst-smoke.ts --synthetic-only --require-ingest` → exit 0 on explicitly approved staging/release target; source-bound build, auth denials, verifier/image preflight, feature flags and ingest200+stored-event proof attached. Refuses an unapproved target and cannot enable features automatically.

The judge must inspect assertion coverage; green commands without the specified outcomes are insufficient. Live evaluation and release smoke require approval and remain explicitly pending until executed.

## Review focus

- Cross-user/team/section revocation between creation, query, render and image release; model-controlled names/URLs/properties must not become capabilities.
- Metric compatibility and date normalization across PostgreSQL/ClickHouse; whole-range uniqueness, DST, null/zero and native endpoint semantics require real fixture assertions.
- Shared-analysis copy-on-write and board versioning must not silently modify other dashboards or break existing clients.
- Worker process/container network isolation, capabilities, image retention and logs need manual security inspection beyond route-mock tests. Do not describe browser route filters as OS confinement.
- An image-capable provider preflight and image-block round-trip are release prerequisites; synthetic mocks do not prove the configured model sees screenshots.
- Screenshot review can miss errors. Final wording must separate automated receipts, model observations and unknown coverage.
- Review every desktop/narrow capture, keyboard/confirmation path and empty/denied/error state through the UI gate. No unrelated visual redesign.
- Confirm test harness refuses production DB/host settings, release smoke cleanup is bounded, rollback reader preserves new widgets, and ingest gate checks storage, not only HTTP status.

## Touched (evidence)

Paths below are Umami-relative; new siblings are deliberate implementation targets.

| Existing path:line | Required change |
| --- | --- |
| `prisma/schema.prisma:297-315,410-427` | Add saved-analysis/task/operation metadata and board revision; additive migration after current 27 |
| `src/lib/types.ts:359-389` | Extend persistent widget config with AnalysisWidget reference |
| `src/lib/boards.ts:195` | Extend reference collection/validation without weakening native/comparison checks |
| `src/permissions/board.ts` and `src/app/api/boards/[boardId]/route.ts:15-111` | Match new analysis references and agent revision/visibility rules to existing authorization |
| `src/queries/prisma/board.ts:65-70` | Metadata transaction integration and optimistic update; no sequential pretend-atomic writes |
| `src/lib/ai/assistant/analytics/query.ts:65-231` | Reuse native query semantics through common executor; repair missing/zero and uniqueness interpretation without unrelated refactors |
| `src/lib/ai/assistant/analytics/results.ts:4-44`, `chart.ts:51-64` | Keep snapshot compatibility; distinguish persisted definition references from ephemeral handles |
| `src/lib/ai/assistant/tools.ts:122-234,273-277` | Typed analyst tools, generic-write authority guard, truthful verification results |
| `scripts/ai/assistant-tools.mjs:190-233` | Exact tool activation, precise descriptions, bounded host image-to-content bridge |
| `src/lib/ai/assistant/runtime.ts:90-108,224-320` | Allowlist/event integration without removing confinement; cancellation and scoped task receipts |
| `src/lib/ai/assistant/prompt.ts:6-15`, `playbook.md:3-11` | Goal/discovery/reuse/verification guidance backed by executable rules |
| `src/app/(main)/assistant/AssistantPage.tsx:189-194,679-704` | Context, confirmations, phases, readable tool summaries and separate verification states |
| `src/app/(main)/assistant/ResultChart.tsx:11-138` | Snapshot labeling and explicit live-analysis path, no silent conversion |
| `src/app/(main)/boards/boardComponentRegistry.tsx`, `BoardProvider.tsx:36-56`, `[boardId]/BoardComponentRenderer.tsx:17-43` | Register/render AnalysisWidget, maintain old configs and verification widget states |
| `src/components/hooks/queries/useWebsitePageviewsQuery.ts:15-35` | Reference for native live-query behavior; only change if needed for job-local render receipts |
| `src/queries/sql/events/getEventDataNumericStats.ts:39-46`, `src/queries/sql/sessions/getSessionDataNumericStats.ts:55-67` | Reference semantics; touch only for supported scoped adapter/filter parity |
| `tests/e2e/assistant.spec.ts:128-222`, `docs/ai-analytics-eval.md:3-38` | Existing mocked-browser/narrow-eval baselines; add distinct lifecycle tests/report, do not rewrite historical results |

New modules live under `src/lib/analyst/` for schemas/execution/store, `src/lib/ai/assistant/analyst/` for agent orchestration, `scripts/ai/verifier/` for isolated worker, `src/app/api/analyses/` and `src/app/api/analyst/` for authenticated boundaries. Server verification capability handling lives in the worker/server stage, not in model-visible context.

## Assumptions

| Assumption | How challenged | Resolution |
| --- | --- | --- |
| User wants live reusable custom analyses, not only existing widgets | First structured question after research | User selected reusable analysis layer |
| New drafts can be autonomous; existing resources cannot | Second structured question | User selected build drafts, confirm edits |
| “Check the dashboard” includes actual visual observation | Third meaningful question | User selected screenshots via restricted worker |
| Existing Pi loop should be replaced | Source probe and production package inspection | Rejected; keep native Pi RPC and strengthen capabilities/workflow |
| Every chat chart can already be saved live | Native lifecycle and assistant trace | Rejected; introduce explicit saved definition/widget, preserve snapshots |
| Production already has required staff/business events | Identity research and instrumentation gaps | Not assumed; synthetic fixtures plus honest coverage discovery |
| Current model accepts screenshot content | Not established by text-only runtime inspection | Mandatory synthetic provider/image preflight before visual verification rollout |
| All native metrics support all filters | Existing helper and native API inspection | Rejected; strict capability matrix and unsupported-combination errors |
| Verification is one boolean returned by show_chart | Queued-only tool response and renderer trace | Rejected; separate definition/data/render/inspection receipts |
| Broader SQL/codemode needed before a useful analyst | External workflow comparison and native operations | Not assumed; typed workflow first, no arbitrary SQL or mandatory codemode |

## Capabilities routed (docs/capabilities.md)

- Local/external evidence → research skill, Pi web-access tools; completed three bounded probes.
- Spec/reference prose → clarity skill; preserve source/unknown boundaries and executable contracts.
- Product implementation → build skill, worker lanes, fresh code judges; no workers launched by this spec.
- Visual capture/review → ui skill with agent-browser for development gates; Playwright is the app's restricted runtime verifier implementation, not permission to expose generic browser tooling to Pi.
- UI design quality → hallmark alongside UI gate, constrained to existing Umami styling and workflow states.
- Structured preferences → ask_user_question; all three meaningful choices resolved above.
- Codemode → optional existing Pi capability only after a separate constrained evaluation; not a dependency here.

## Lanes (docs/policy.md §3)

These are substantial independently testable outcomes, not a lane per file/checklist. Owns paths are implementation-repo-relative. Dependencies serialize integration; no overlapping writes are launched concurrently. Final acceptance remains end-to-end rather than inferred from component passes.

| Lane | Tier | Owns | Blocked by | Acceptance subset | Independence fact |
| --- | --- | --- | --- | --- | --- |
| `analysis-foundation` | hard | `prisma/**`; `src/lib/analyst/**`; `src/permissions/analysis*`; `src/permissions/board.ts`; `src/queries/prisma/analysis*`; `src/queries/prisma/board.ts`; `src/lib/types.ts`; `src/lib/boards.ts`; `src/lib/boards.test.ts`; `src/app/api/analyses/**`; `src/app/api/boards/**`; `src/lib/ai/assistant/analytics/query.ts`; `src/lib/ai/assistant/analytics/analytics.test.ts`; `scripts/test-analyst-api.ts`; `tests/api/analyst*` | none | A1–A3 | Definition/execution/persistence and permissions can be tested through authenticated APIs without agent or new UI |
| `render-verifier` | hard | `scripts/ai/verifier/**`; `src/lib/analyst-verifier/**`; `src/app/api/analyst-verifier/**`; `tests/e2e/analyst-verifier.spec.ts`; `deploy/analyst-verifier/**` | foundation contract frozen | B1–B2 | Isolated capability/receipt/image behavior is tested against seeded fixture boards and a fixture render adapter, independent of model behavior |
| `analyst-agent` | hard | `src/lib/ai/assistant/analyst/**`; `src/lib/ai/assistant/tools.ts`; `src/lib/ai/assistant/runtime.ts`; `src/lib/ai/assistant/handlers.ts`; `src/lib/ai/assistant/store.ts`; `src/lib/ai/assistant/analytics/results.ts`; `src/lib/ai/assistant/analytics/chart.ts`; `src/lib/ai/assistant/protocol.ts`; `src/lib/ai/assistant/prompt.ts`; `src/lib/ai/assistant/playbook.md`; `src/lib/ai/assistant/runtime.test.ts`; `src/lib/ai/assistant/tools.test.ts`; `src/lib/ai/assistant/protocol.test.ts`; `scripts/ai/assistant-tools.mjs`; `scripts/ai/assistant-tools.test.mjs`; `src/app/api/analyst/**` | foundation, render-verifier | C1–C2 | Host-enforced task/authority/repair/image contracts pass with synthetic RPC/model inputs without relying on browser visual judgment |
| `analyst-dashboard-ui` | standard | `src/app/(main)/assistant/**`; `src/app/(main)/boards/**`; `src/components/hooks/queries/useAnalysis*`; `tests/e2e/analyst-lifecycle.spec.ts`; `tests/e2e/analyst-verifier-integration.spec.ts` | foundation, render-verifier, analyst-agent | D1–D2, B3 | User-visible live widget and task/confirmation states can be checked using deterministic API/worker receipts, independently of live model accuracy |
| `analyst-evaluation` | hard | `scripts/ai/eval-analyst.ts`; `scripts/ai/analyst-evals/**`; `scripts/ai/release-analyst-smoke.ts`; `docs/ai-analyst*` | all preceding | E1–E2, I3 | Independent expected fixtures and report checking expose lifecycle failures without changing product behavior; live runs remain separately approved |

## Notes for build

- Use build/review policy §3 economic and independence tests when generating packs. Do not launch all five at once. Foundation first; freeze its schema/API contracts before dependent work. Verifier and agent image boundary are fixed by this spec; agent starts after verifier receipts are implemented. UI follows stable host APIs. Evaluation harness may be scaffolded read-only early but its acceptance runs after integration.
- Serialize migrations, package/lockfiles, generated OpenAPI/SDK files, permissions export glue, route discovery/contract generation, Docker/main deployment and shared native render-receipt glue under MAIN after relevant lane merges. MAIN records these integration edits explicitly; they are not unspecified worker authority.
- `src/permissions/index.ts`, existing native widget render-status glue outside lane owns, global feature-flag plumbing, `playwright.config.ts`, shared test fixtures/environment bootstrap and app image configuration are MAIN-owned integration tasks. Their evidence/tests are I1–I3/B3/D2; integrate fixture bootstrapping before B2 and actual widget receipt glue before B3. No lane may silently widen ownership.
- Direct mode instead of lanes: no; API/executor, isolated verifier, agent authority, UI and independent evaluation each repay a separate worker and judge. Ordered stages remain one-wide where coupled; do not invent parallelism to hit a lane count.
- Fresh security-aware code review required for metadata transactions, cross-user authorization, confirmation bypass defenses, worker capability/network boundary and image release. UI gets a separate visual gate with desktop/narrow captures. No verdict based only on model-authored test assertions.
- Verifier-stage B2 uses only its declared fixture adapter; actual widget integration is B3 after the UI stage and must never be reported passed from B2. Agent ownership includes handlers/store so persisted budget pauses, outer handler deadlines, image sanitization, restored context and chat-delete cleanup are implemented coherently. Foundation owns board permission changes; agent owns result/chart compatibility changes. These assignments close previously unowned existing paths.
- Stage merge is not release approval. Offline/component acceptance may merge behind disabled flags; live evaluation/image preflight, disposable DB parity, compatible rollback and ingest proof must pass before broad enablement.
- Expected delivery stages: foundation → isolated verifier → agent lifecycle → integrated UI → evaluation/release readiness. No calendar or cost estimate is asserted without measuring repository/build constraints.
- Before first worker, reconcile the Umami checkout and existing specs. This spec governs the new global analyst lifecycle; it does not retroactively remove explicit Save from the older local board-draft feature. Native runtime/auth constraints remain in force.
