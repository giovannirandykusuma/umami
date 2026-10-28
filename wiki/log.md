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
