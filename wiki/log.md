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
