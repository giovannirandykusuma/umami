# Implementation log

## [2026-10-27] 20261027-2221/direct | Establish isolated test tooling

Pinned pnpm 12.3.4 frozen installation succeeded. Shared browser test setup now supports Node RPC fixtures; 11 browser and 4 Node tests passed. Synthetic Prisma generation and workspace builds require no database connection. Before feature code, full TypeScript check reports four upstream diagnostics: EventsTable.tsx lines 46/54 unsupported flexWrap, admin 2FA route.test.ts line 61 excessive type instantiation, and app/mcp/route.ts line 28 distinct API-client private fetchImpl declarations. These remain baseline, not waived new errors. No production or model calls.

## [2026-10-27] 20261027-2221/ai-board-contracts-r2 | Strict renderer-compatible board drafts

Merged as 78d467c07 after fresh judge ACCEPT and canonical content-bound merge gate. All 104 synthetic tests pass including actual renderer/query-argument round trips; changed-path TypeScript and whitespace checks clean. First worker's accepted MetricsTable missing-type case was rejected by judge; fresh hard worker requires explicit supported metric type. Pure bounded validator supports website metrics bar/chart, world map, constrained metrics tables and text blocks. Backend must still authorize every referenced entity. No persistence, provider calls or production changes. Closed and archived accepted workspace after merge; prior rejected workspace preserved as local recovery evidence then archived.

## [2026-10-27] 20261027-2221/ai-pi-runtime-r2 | Native Pi RPC runtime

Merged as e02aa8585 after fresh judge ACCEPT and canonical merged-tree gate: 28 tests green, zero changed-path TypeScript diagnostics, credential-free pinned Pi 1.4.0 native CLI startup/get_state smoke verifies exactly four tools. A prior review caught ignored native tool failures/aborted settlement; regressions now fail closed even after proposal receipt. Custom SDK bridge was never merged; native CLI follows decision 0001. Smoke does not establish live provider compatibility. Dedicated deployment filesystem/network/credential isolation remains required; same-UID processes are not an OS sandbox. No model or production calls. Workspace archived; cleanup conservatively retained branch due to MAIN-only decision documentation, then all eight owned paths were verified identical to MAIN before deliberate branch deletion.

API worker started. UI launch must serialize after API: ownership parser treats route-group parentheses as notes and wildcard replacement conservatively overlaps the API path. No ownership safety override taken.
