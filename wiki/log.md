# Implementation log

## [2026-10-27] 20261027-2221/direct | Establish isolated test tooling

Pinned pnpm 12.3.4 frozen installation succeeded. Shared browser test setup now supports Node RPC fixtures; 11 browser and 4 Node tests passed. Synthetic Prisma generation and workspace builds require no database connection. Before feature code, full TypeScript check reports four upstream diagnostics: EventsTable.tsx lines 46/54 unsupported flexWrap, admin 2FA route.test.ts line 61 excessive type instantiation, and app/mcp/route.ts line 28 distinct API-client private fetchImpl declarations. These remain baseline, not waived new errors. No production or model calls.

## [2026-10-27] 20261027-2221/ai-board-contracts-r2 | Strict renderer-compatible board drafts

Merged as 78d467c07 after fresh judge ACCEPT and canonical content-bound merge gate. All 104 synthetic tests pass including actual renderer/query-argument round trips; changed-path TypeScript and whitespace checks clean. First worker's accepted MetricsTable missing-type case was rejected by judge; fresh hard worker requires explicit supported metric type. Pure bounded validator supports website metrics bar/chart, world map, constrained metrics tables and text blocks. Backend must still authorize every referenced entity. No persistence, provider calls or production changes. Closed and archived accepted workspace after merge; prior rejected workspace preserved as local recovery evidence then archived.

## [2026-10-27] 20261027-2221/ai-pi-runtime-r2 | Native Pi RPC runtime

Merged as e02aa8585 after fresh judge ACCEPT and canonical merged-tree gate: 28 tests green, zero changed-path TypeScript diagnostics, credential-free pinned Pi 1.4.0 native CLI startup/get_state smoke verifies exactly four tools. A prior review caught ignored native tool failures/aborted settlement; regressions now fail closed even after proposal receipt. Custom SDK bridge was never merged; native CLI follows decision 0001. Smoke does not establish live provider compatibility. Dedicated deployment filesystem/network/credential isolation remains required; same-UID processes are not an OS sandbox. No model or production calls. Workspace archived; cleanup conservatively retained branch due to MAIN-only decision documentation, then all eight owned paths were verified identical to MAIN before deliberate branch deletion.

API worker started. UI launch must serialize after API: ownership parser treats route-group parentheses as notes and wildcard replacement conservatively overlaps the API path. No ownership safety override taken.

## [2026-10-27] 20261027-2221/ai-board-api-r2 | Opt-in database deadline scope

Prior API review rejected promise-only query deadlines and unbounded UTF-8 final output. Fresh worker established that existing lexical Prisma/ClickHouse and helper/model reads cannot be enlisted by an AI-only transaction wrapper. MAIN authorized narrow opt-in async-local shared query plumbing and focused scoped/unscoped synthetic tests. Ordinary request behavior must remain unchanged; transactions cannot span model generation. Fresh review must verify actual server-side execution limits, lifetime/cleanup and no cross-request scope leakage. Implementation and acceptance remain pending.

## [2026-10-27] 20261027-2221/ai-board-api-r4 | Authorized and bounded analytics API

Merged ee1a0e200 after fresh sequential judge ACCEPT, canonical merged-tree affected gate and all five real PostgreSQL/ClickHouse tests green. 47 endpoint, 186 AI unit and 453 affected tests passed; changed-path TypeScript clean. Shared opt-in read-only database scopes bound AI queries and preserve ordinary dispatch; final serialized UTF-8 response capped at 32 KiB. User-only edit/reference/read/final authorization rechecked; no persistence tools. Historical concurrent-judge import timeout remains failed evidence, resolved by fresh isolated gate, not relabeled. Prior formatting-only rejection resolved by exact four base-layout restores. Synthetic engine shutdown executed after merged-tree gate via ownership-validating teardown; logs/data retained locally. Workspace archived, branch owned blobs verified identical before deliberate deletion (MAIN-only wiki differs). UI worker launched next. No production/model/provider calls.

## [2026-10-28] 20261027-2221/final | Integrated feature acceptance and remaining release gates

UI merged33c7c7277 after code and visual ACCEPT; merged-tree174 affected tests green. Integration merged3311c7518 after fresh judge ACCEPT and MAIN4test rerun: real signed nonadmin session, actual endpoint/permissions/syntheticPostgreSQL/nativePi loop/tool bridge/validator; test-only spawn composition appends a deterministic trusted provider extension, not an unmodified live-provider launch. Final combined feature/engine/component acceptance: all211 tests across8 files passed with both integration flags enabled. Full tsc exits2 with exactly four unchanged upstream baseline diagnostics; no changed-path errors. Whitespace/current-tree private-path scans clean. Outgoing-history secret scan exits1 for one explicitly synthetic provider key literal, not a real credential; strict scan remains unresolved. Two benign developer-local tool paths exist in historical commits but were removed from current tree. Local visual evidence remains in historical synthetic commits and is excluded from current public tree.

Source is implemented and feature-tested for isolated staging, not actually deployed. No full ship suite, full production build, live-provider compatibility or deployment isolation validation is claimed; no push/deployment authorized. UAParser/dependency licensing remains release gate. Owned synthetic engines and UI services stopped, accepted workspaces closed. Portable staging instructions in docs/ai-staging.md; final documentation/test portability commit9798ac27b.

## [2026-10-28] 20261027-2221/discovery-rollout | Discovery-first assistant live in production

Randy authorized app-only rollout of published b841d010d (immediate no-wait three-turn live synthetic image check, 1,203-test full suite, clean source scan, all prior). Fresh protected backup /opt/umami/backups/20261028T091957Z-discovery (pg_dump restorable, 27 table-data entries, configs, previous image id). Migration files identical (27) to production, no new migrations; no new runtime env keys. Image transferred via docker save/load; local and imported layers+config hash equal, imported id 31415f915e5d (tested acd03884d5d3); offline native smoke passed on VPS. Switch via docker-compose.ai.yml with health-gated automatic rollback (prior override kept as .prev): healthy, 0 restarts, 1 GiB cap, ~109 MiB. Post-switch: public heartbeat 200, normal login/verify 200, browser boards visible and source link equals b841d010d, AI env root mode 600, 26 finished migrations. No production model prompt, analytics read or board save during verification. Superseded main and 15 idle judge/probe agents archived. UAParser commercial license remains open.

## [2026-10-28] spec/global-assistant | rung epic · 3 lanes · ambiguity 0.15

Randy: page-only Assistant outside Boards, history+delete, act-as-user with delete confirm and questions, full collapsed thinking, multi-site compare chart. MAIN committed protocol contract src/lib/ai/assistant/protocol.ts. Mobbin refs in shots/refs/assistant (local).

## [2026-10-28] 20261028-1700/compare-chart | DECIDE: widen to BoardComponentSelect

Worker paused: no multi-website ConfigField in manual editor. MAIN approved widening Owns to BoardComponentSelect.tsx (+test) for a validated 2–10 websiteIds field; scalar fields unchanged. Disjoint from assistant-backend (no src/app).

## [2026-10-28] 20261028-1700/assistant-backend | Global assistant backend merged

Merged 2e2d1a2b8 after fresh judge ACCEPT (10 commands reproduced) and canonical squash gate (affected 35 tests). Per-user AiChat/AiChatMessage (additive migration 27_add_ai_assistant), SSE turns via native confined Pi with per-chat session restore, host loopback umami_api as requesting user, /api/auth and /api/ai blocked, delete confirm, ask_user, show_chart, open_link. MAIN added thin route re-exports; tsc baseline 4. Offline only: no live provider/DB yet. In-memory turn registry assumes single process.

## [2026-10-28] 20261028-1700/compare-chart | Compare chart merged

Merged 4a97073f9 after fresh judge ACCEPT (r2, 6 commands; r1 unjudged: Node 26 localStorage env + invalid kind). Canonical squash gate: affected 687 passed/18 skipped. WebsiteCompareChart {websiteIds 2-10, metric visitors|pageviews (visits dropped: no series endpoint), unit}; strict draft validation; getBoardEntityIds counts all websiteIds; manual multi-website editor field. Merge-gate owns check required MAIN adding *main* glob equivalents to pack (route-group bug; original kept as pack.md.pre-glob-fix). Post-merge formatter drift on registry restored.

## [2026-10-28] 20261028-1700/assistant-ui | r1 REJECT; worktree lost; reconstructed

Judge #0001 REJECT (2 med): unknown SSE events abort the turn (stream.ts:35); link parts accept absolute and slash-backslash external URLs (AssistantPage.tsx:669). Visual work had passed MAIN review (3 rounds of shots). MAIN ran lane cleanup (force) in parallel with a failed patch export; the uncommitted worktree was destroyed. Reconstructed by replaying the worker Pi session writes/edits on e006b1a8a + pnpm add react-markdown remark-gfm; 3 replayed edits did not apply verbatim (worker format-on-write drift), fixed SideNav duplicate + ChartJS import by hand → branch recover/assistant-ui-r1 (853feda32), tsc baseline clean. r1 shots kept in .shikumi/assistant-ui-r1-shots. Round 2: fresh hard worker from that branch.

## [2026-10-28] 20261028-1700/assistant-ui-r2 | Assistant page merged

Merged e9ca20b77 after fresh code judge ACCEPT (#0002: unknown SSE skipped, same-origin links only, 15 unit + 2 browser tests) and ui-judge ACCEPT (#0003 P4 H4 E4 S4 R4; drawer/expanded/menu states not pictured). Merge gate bound to #0002 (tooling allows one active review; #0003 differed only by a next-dev-generated AGENTS.md, removed). Merge retries: VERDICT_DIRS separator, react-markdown missing in MAIN node_modules, prior run left a lane commit, load-average-22 timeouts in untouched runtime/query/2FA tests (pass focused 65/65); final gate VITEST_MAX_WORKERS=4: 1224 passed/18 skipped across full suite. tsc baseline 4. All three global-assistant slices merged; live synthetic image test next.

## [2026-10-28] global-assistant | Live synthetic test: turn 1 pass, follow-ups broken

Image sha256:c0bec0a4 (source 4f3e6fbfe pushed). Live cx/gpt-6.1-sol medium, invented data: turn 1 built "Apps compare" board with 3-site WebsiteCompareChart via GET /api/websites, show_chart, POST /api/boards, open_link; 401 unauth; foreign chat 404; 254 MiB. Turn 2 failed instantly: Pi refuses restored session whose header cwd (old mkdtemp dir) no longer exists (dist/core/session-cwd.js); offline fake child never enforced it. Gateway streams no reasoning for this model (direct probes with reasoning_effort/reasoning/include_reasoning: content only) → Randy chose live activity row instead of thinking text. Fix lane assistant-followup-fix launched. Not deployed.

## [2026-10-28] 20261028-2005/assistant-followup-fix | BLOCKED → env setup granted

Worker fix done (session cwd rebase, fake-Pi cwd enforcement + regression, bounded exit diagnostic, live Thinking/Working timer; 52 scoped tests pass) but tsc printed 41: fresh worktree lacked generated Prisma client/package builds. MAIN granted gitignored setup (install, prisma generate, package builds); screenshots deferred to MAIN on rebuilt image.

## [2026-10-28] global-assistant | Live synthetic test PASSED

Image sha256:4ba40d12 (source 329890ccf, pushed). Real cx/gpt-6.1-sol medium, invented data: turn 1 built "Apps compare" board with 3-site WebsiteCompareChart (GET /api/websites, show_chart, POST /api/boards, open_link, 71 text deltas); turn 2 (follow-up in same chat, restored Pi session) GET /api/boards then DELETE emitted confirm, reply rejected (200) → tool denied, board survived; history 4 messages; 401 unauth; foreign chat 404; 260 MiB/1 GiB. Thinking text: gateway sends none (live activity row instead, per Randy).

## [2026-10-28] 20261028-2005/assistant-chart-range | Verification dependency provisioning

Worker blocked on absent worktree dependencies. MAIN approved an untracked worktree-local node_modules symlink to the existing main dependency tree solely for tests, without installs or mutations of shared dependencies, to be removed after verification. No product scope expansion or deployment permission. Prior missing dark-mode legend report was disproved in the live browser: all three website labels are visible below the chart (shots/live/chart-legend-check.png).

## [2026-10-28] 20261028-2005/assistant-chart-range | Explicit chart range fix merged

Merged 7db2d4921 after fresh judge ACCEPT: 236 affected tests passed, targeted chart/prompt/tool tests passed, baseline substitution failed both new range regression cases as expected. Merged-tree gate passed. Explicit millisecond startAt/endAt now control comparison API requests and timezone-adjusted axis; absent or invalid ranges retain global board selection. Prompt removes unsupported visits metric. Rebuilding release image before final live verification; production unchanged.

## [2026-10-28] 20261028-2005/direct | Corrected image live verification passed

Image sha256:54b018e35943b80f432cd3779bc3acc5dd293697d5111a7ab6c25b005936bdd8 (source 7db2d4921) passed real-gateway synthetic smoke: three-site board creation, streamed text, follow-up delete confirmation rejected, board survives, four persisted messages; memory 279.8 MiB / 1 GiB. Evidence .pi/tasks/assistant-live-corrected.txt. Real browser shows full October 15–28 comparison with three labeled lines (shots/live/corrected-range.png). Additional browser turn captured Thinking... 0s then successful websites list (corrected-live-timer.png and corrected-live-timer-later.png); elapsed increment not separately captured. Mobile history drawer/menu visually verified in prior same-UI image. Production unchanged; awaiting deployment consent, with fresh backup and migration 27 required.

## [2026-10-28] 20261028-2005/direct | Assistant deployed with authorization

Randy explicitly approved deployment. Fresh protected backup: /opt/umami/backups/20261028T150151Z-assistant (183728-byte custom pg_dump, readable pg_restore TOC, configs and prior image ID). Transferred tested config digest 54b018e35943b80f432cd3779bc3acc5dd293697d5111a7ab6c25b005936bdd8; remote OCI manifest ID cad444ee5f86682ada65d1de17320881fecdc2c7acb9781004cf617325108202, identical layers and runtime config. Offline pinned Pi confinement/RPC smoke passed on VPS. Health-gated compose rollout succeeded, zero restarts, migration 27_add_ai_assistant finished. Public heartbeat 200/ok, login page 200, anonymous chats 401; built source SHA 7db2d4921 confirmed in served image assets; memory 165.3 MiB / 1 GiB. No production model prompt or authenticated analytics access during this rollout. Previous compose override retained for app rollback; additive chat tables need not be dropped for app rollback.

## [2026-10-29] 20261029-1504/analytics-tools | Provision worker test environment

Worker blocked before implementation on absent worktree dependencies and synthetic databases. MAIN supplied an ignored node_modules symlink to existing dependencies, prohibited shared installs/mutations, and launched receipt-checked synthetic PG/CH setup plus Prisma schema push only to analytics_integration. Worker steered to continue implementation/unit tests while setup completes; no production or live provider access authorized. Keep dependency link and fixtures for fresh judge.

## [2026-10-29] 20261029-1504/analytics-tools | Resolve runtime allowlist seam

Worker correctly forked on runtime.ts hardcoded original four-tool allowlist. MAIN authorized narrow Owns expansion to runtime.ts and runtime.test.ts: add exactly the five spec analytics tool names, optional display titles, and allow/deny bridging regression tests; preserve unknown-name denial, tool limits, sandbox and session restoration. Worker owns the coupled change to avoid divergent main/worktree edits. Existing main line-wrap drift remains untouched. MAIN launched worktree-local Prisma generation (schema output src/generated/prisma) against synthetic configuration. No deployment or provider spend.

## [2026-10-29] 20261029-1504/analytics-tools | Resolve acceptance runner contention

Worker reports original test selection timing out repeatedly in pre-existing query.test.ts import while same selection passes with two workers (341 passed). MAIN authorized VITEST_MAX_WORKERS=2 for acceptance, preserving test selection/assertions/timeouts. Fresh judge must reproduce; no acceptance override issued. Also expanded Owns to scripts/ai/assistant-tools.test.mjs to update old four-tool registry expectation for nine approved names and run coupled regression coverage. Worker reports seven real PG integration cases passing, CH query-builder coverage only, and three existing TS diagnostics rather than prior four; judge to verify no new changed-file errors.

## [2026-10-29] 20261029-1504/analytics-tools-r2 | Resolve nested dependencies and import budget

R2 worker reports both judge findings fixed with six pre-fix regression cases, seven PG integration cases passing, but blocked on missing worktree packages/mcp/node_modules and unchanged query import exceeding five seconds. MAIN linked the existing nested MCP dependencies without installs or source changes. Approved acceptance CLI --maxWorkers=1 --testTimeout=15000 solely for runner/import contention; implementation deadlines/assertions unchanged, no test/config edit. Fresh judge must reproduce adjusted command and baseline diagnostics. Stop repeated retries if new budget fails and investigate timing.

## [2026-10-29] 20261029-1504/analytics-tools-r2 | Authorized narrow review recovery

Two fresh judges reproduced functional green but rejected unrelated runtime line wrapping under explicit judge scope rule. Randy selected narrow recovery: preserve implementation, fresh worker removes only unrelated hunk and investigates recurring formatter, then fresh review. No deployment/model calls authorized. Two low findings note load-sensitive unchanged query import and runtime cancellation test; run verification serially.

## [2026-10-29] 20261029-1504/analytics-scope-recovery | Backend merged

Merged a4cb79e38 after fresh ACCEPT with zero findings and final merged-tree gate exit0. Judge reproduced347 broad tests,7 enabled real PG integration zero skips,62 affected, registry3, exact three baseline TS errors, fixed regression negative controls, and stable20-path hash manifest with only authorized runtime hunks. Archived completed recovery workspace preserving branch. Launched result-chart-ui and independent offline analytics-eval workers from this merge. Live model evaluation and deployment remain unauthorized.

## [2026-10-29] 20261029-1504/result-chart-ui | Authorize fixture and capture updates

UI worker passes18 unit tests and baseline-only TS checks but browser fixture500s because Turbopack rejects external worktree dependency symlinks. MAIN approved narrow paseo.json ai-ui-fixture --webpack flag and scripts/ai/capture-ui.mjs result-chart/table fixtures/screenshots; Owns expanded. Only restart owned Paseo fixture. Browser/visual gates remain required, no product deployment or model calls.

## [2026-10-29] 20261029-1504/analytics-eval | Correct standalone-script acceptance gate

Fresh judges0001/0002 found no source defects and reproduced offline evaluator checks; affected-tests first lacked dependencies then delegated to Vitest --changed, which selected zero tests for standalone .mjs plus docs and exited1. MAIN corrects applicability: generic Vitest gate is N/A for this two-file lane, not a failing implementation test. Required gates remain node syntax, evaluator self-test (nine mutation controls), offline transcript/parity/malformed/opt-in/comparison probes, diff check, scope review. Fresh judge required; no override of existing REJECT, no live model spend.

## [2026-10-29] 20261029-1504/analytics-eval | Offline evaluator merged

Merged e7e0079ae after fresh judge0003 ACCEPT, no findings. Scope/review-content binding and canonical commit-before-squash sequence retained; local merge helper substituted reviewed standalone syntax+self-test+diff-check gate for inapplicable Vitest selector (zero tests for mjs/docs). Gate passed, including9 negative controls. Six-prompt fixture/report/opt-in guard and offline parity/comparison checks independently reproduced by judge. Live baseline/candidate rates NOT RUN, spend unauthorized. Closed evaluator workspace, preserved branch. UI browser verification remains pending.

## [2026-10-29] 20261029-1504/result-chart-ui | UI merged; approved build complete

Merged68de3780a after code judge0001 ACCEPT and visual judge0002 ACCEPT, verified both bind same result/content. Canonical merge used active visual verdict with code evidence separately verified; merged-tree gate passed.18 unit and3 mocked browser tests reproduced; four visual states accepted P4 H4 E3 S4 R4 V-null, zero reported overflow/errors and table total42. Evidence copied to .shikumi/analytics-result-ui-shots before workspace cleanup. Nonblocking raw ISO bucket label polish noted; no line-specific screenshot/contrast audit claimed. All three implementation slices now merged locally: backend a4cb79e38, offline eval e7e0079ae, UI68de3780a. No deploy, provider calls or live baseline/candidate eval; production still prior release.

## [2026-10-29] incident | Missing GeoIP ingestion restored; permanent gate pending

Production image built with SKIP_BUILD_GEO=1 lacked /app/geo/GeoLite2-City.mmdb; heartbeat-only deployment checks missed /api/send500. Fresh backup /opt/umami/backups/20261029T112024Z-geo-hotfix. Downloaded canonical build:geo asset, validated via maxmind, hotcopied48.4MiB to app container0644. Public synthetic send returned200 at11:21UTC; coordinating Ashiato session independently confirmed three sends200 and persisted pageview/ops/named event rows at11:22UTC. Container-local fix not durable across recreation; failed historical events not recovered. Permanent geo-ingest-guard worker now priority, chart/eval paused until its verified merge. Randy approved model spend/push/deploy via coordinator, conditional candidate>baseline; no new live evaluations yet.

## [2026-10-29] release | Approved live comparison and release preparation

Chart polish18f5e5393 accepted by code+UI judges and merged. Permanent geo guard6ae9baad7 and marker boundarye8a2a08e0 passed immutable image081812c5 ingestion200/200, persisted1/1, geo2. Live evaluation runner910f6881c merged after fresh judge ACCEPT and offline merged-tree gate. Official baseline7db2d4920/6 vs candidate6ae9baad6/6; text TOTAL correctness6/6 BOTH: improvement is result-chart parity, not numerical accuracy. Same nine-router cx/gpt-6.1-sol medium/seed/settings; private reports retained .shikumi/runs/20261029-1504/live-analytics-eval/scratch/reports-20261029-190318, not committed. Randy authorized push and deploy conditional candidate improvement via coordinator. Preparing final immutable release build/ingestion gate then fresh backup/deployment.

## [2026-10-29] release | Analytics release deployed and ingestion verified

Randy explicitly requested deletion of both Umami backup files and unused images; removed /opt/umami/backups, temporary image archives and old unused Umami images, preserving running/new images and live database. No additional backup created. Pushed source d487c2b7f and built tested config image20ed3e469c25; final isolated smoke200/200, persisted1/1,geo2. Archive transfer resumed after timeout; SHA256 matched before import. Remote manifest0f57a4c40c0a4239f0cc417fd777005b18313a2fbeadd4e575d7a9a94a05c936 labeled source d487c2b7f. Offline Pi confinement smoke passed on VPS; compose rollout healthy zero restarts;48.4MiB GeoIP present in image. Post-deploy public synthetic usage-smoke pageview/event both200, exact unique-URL DB rows1/1 and geo2. Heartbeat200/ok, login200, anonymous chats401. No real production analytics sent to model.
