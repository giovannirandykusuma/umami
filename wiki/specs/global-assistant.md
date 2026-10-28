# global-assistant — spec

Rung: epic · Autonomy: auto · Run: 20261028-1649 · Date: 2026-10-28
Ambiguity: 0.15 after round 1 — goal 0.9 · constraints 0.85 · criteria 0.8 · context 0.85

## Goal

Every user gets a global **Assistant** page (side nav, outside Boards) with persistent chat history (new · rename · delete), a Pi-RPC agent that can read and change anything in Umami that the user themselves may change (deletes need an in-chat confirm; it can ask the user questions), a Paseo-like streamed timeline (text deltas, collapsible full thinking, tool-call rows with args/results, inline charts, links), and a new **multi-website compare chart** (one chart, one line per website) usable on boards and in chat.

## Non-goals

- No floating/⌘J panel (Randy chose page only). No team-shared chats. No voice/attachments.
- No cross-website de-duplicated "unique people" metric (needs identify data; per-site visitors only).
- No direct DB/SQL access for the model, no shell/filesystem tools in the Pi child.
- Old `/api/ai/boards/chat` route stays (unused) — cleanup queued, not in this epic.

## Constraints

- Native Pi RPC CLI stays (decision 0001): Pi child spawned with `--no-builtin-tools --no-extensions --no-skills --no-mcp --no-context-files` + the trusted host-tools extension; tools execute in the **host** process via the existing `extension_ui_request` input bridge, never inside the child.
- Security ("just enough", internal tool): every model tool call that touches Umami goes through the real `/api/*` route handlers with **the requesting user's own bearer token**, so existing authorization is the ceiling. Any `DELETE` (or delete-like path) requires an explicit user confirm part answered via `/reply`; rejection or 5-minute timeout returns "denied" to the model. `/api/auth/**` is blocked. Provider key never reaches the browser or tool results. Chat rows are strictly per-user (other users' chat ids → 404).
- Stream/history contract is **`src/lib/ai/assistant/protocol.ts`** (MAIN-authored, committed before the wave). Lanes must not change it; a needed change is a fork back to MAIN.
- Compare widget contract (fixed for all lanes): board component `type: 'WebsiteCompareChart'`, `props: { websiteIds: string[] (2–10 unique UUIDs), metric: 'visitors' | 'visits' | 'pageviews', unit?: 'hour' | 'day' | 'month' }`, uses the board/page date range like `WebsiteChart`; every `props.websiteIds` entry counts as a referenced website for board permission checks.
- Model/route: `AI_MODEL`, `AI_BASE_URL`, `AI_PROVIDER_KEY`, `AI_REASONING_LEVEL` env as deployed today; the reasoning stream must be forwarded (thinking_delta).
- One running turn per chat, ≤4 concurrent turns process-wide, turn wall clock ≤5 min, ≤40 tool calls/turn, tool result to model truncated to 32 KiB, persisted tool result ≤8 KiB.
- Match Umami's design system (`@umami/react-zen`, existing CSS modules, light/dark). Keyboard: Enter send, Shift+Enter newline, Esc stop.
- Changed-path TypeScript clean vs baseline (4 upstream diagnostics); `git diff --check` clean; no whole-file reformatting of untouched code.

## Acceptance (runnable; the judge pastes these verbatim)

- `npx --yes pnpm@12.3.4 exec vitest run src/lib/ai src/app/api/ai src/lib/boards.test.ts "src/app/(main)/boards" "src/app/(main)/assistant"` → exit 0
- `npx --yes pnpm@12.3.4 exec prisma validate` → exit 0, and `ls prisma/migrations | grep -c ai_assistant` → 1
- `npx --yes pnpm@12.3.4 exec tsc --noEmit -p . 2>&1 | grep -c "error TS"` → 4 (unchanged upstream baseline)
- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3317 PLAYWRIGHT_SKIP_WEB_SERVER=1 npx --yes pnpm@12.3.4 exec playwright test --config=playwright.config.ts tests/e2e/assistant.spec.ts` → all pass against the `ai-ui-fixture` Paseo script server
- `git diff --check master...HEAD` → empty

## Review focus

- Tool bridge: can the model reach any route with more privilege than the user (token swap, path traversal like `/api/../`, absolute URLs, `//host`, non-loopback base)? Is the loopback base fixed server-side?
- Delete confirm: every DELETE path and delete-like POST is gated; a confirm reply for chat A cannot resolve chat B or another user's turn.
- Chat isolation: list/get/rename/delete/turn/reply/cancel all scoped to `auth.user.id`.
- Stream: exactly one terminal event; client disconnect aborts the child and still persists a `cancelled` assistant message; late child output after settle is dropped.
- Pi session persistence round-trip (restore → turn → save) does not leak between chats or users; temp dirs removed.
- Compare chart on a **shared** board: share-token viewers can load it only if all referenced websites are in the board (permissions via `getBoardEntityIds`).
- Thinking text is shown collapsed; no provider key/credentials in any persisted part.
- Visual: history list, streaming timeline, tool rows, confirm/question cards, chart part — desktop 1280×800 and narrow 390×844, light + dark.

## Touched (evidence)

- `src/lib/ai/runtime.ts:119-139` — spawn flags; new assistant runtime reuses spawn but keeps session + forwards deltas.
- `src/lib/ai/runtime.ts:237-260` — `extension_ui_request` host-tool bridge pattern to reuse.
- `scripts/ai/host-tools.mjs:1-135` — trusted extension shape; new `scripts/ai/assistant-tools.mjs` alongside.
- `src/lib/auth.ts:26,71` — `getBearerToken`/`checkAuth`: user token forwarded to loopback API calls.
- `src/lib/mcp/dispatch.ts:276` — in-process route dispatch reference (optional alternative to loopback HTTP).
- `prisma/schema.prisma:381-399` — Board model pattern for new `AiChat`/`AiChatMessage`.
- `src/lib/boards.ts:162-210` — `getBoardEntityIds` must include compare-chart `props.websiteIds`.
- `src/lib/ai/board-draft.ts:109-163` — strict draft validator must accept the compare widget.
- `src/app/(main)/boards/boardComponentRegistry.tsx:140-410` — register `WebsiteCompareChart`.
- `src/app/(main)/websites/[websiteId]/WebsiteChart.tsx:44-66`, `src/components/metrics/PageviewsChart.tsx:35-72` — per-site series + chart styling to reuse.
- `src/app/(main)/SideNav.tsx:35-52` — add Assistant nav entry.
- `src/app/(main)/boards/[boardId]/BoardEditPage.tsx:5-17` — remove `BoardAiChat` panel from Design.

## Assumptions

| assumption | how challenged | resolution |
|---|---|---|
| Page-only placement | asked Randy | "Full Assistant page only" |
| Writes: everything the user may do, confirm deletes, can ask questions | asked Randy | his free-text answer; tools adopted from his Pi stack (ask/confirm/select via extension UI) |
| Full thinking text visible, collapsed | asked Randy | chosen |
| "One chart with three lines" = per-site visitors/visits/pageviews over time | Umami counts per website | compare chart; cross-site dedup is a non-goal |
| Standalone Next is one process, so in-memory pending-reply map works | Docker image runs one `node server.js` | recorded here; multi-replica is out of scope |
| Design references | Mobbin search (main) | `shots/refs/assistant/*.webp` (Customer.io, Unify, Lindy, Langdock, Apollo, Grok history, Otter, Cohere) |

## Capabilities routed (docs/capabilities.md)

- UI references → mobbin skill (done by MAIN; images in `shots/refs/assistant/`).
- Visual gate → ui skill (ui-judge on the UI lane).

## Lanes (docs/policy.md §3 · disjoint owns · one independently-acceptable outcome each)

| lane (slug) | tier | owns | blocked by | acceptance subset | independence fact |
|---|---|---|---|---|---|
| compare-chart | standard | `src/app/?main?/boards/WebsiteCompareChart*`, `src/app/?main?/boards/boardComponentRegistry.tsx`, `src/lib/boards.ts`, `src/lib/boards.test.ts`, `src/lib/ai/board-draft.ts`, `src/lib/ai/board-draft.test.ts` | — | vitest boards + board-draft, tsc | Widget contract is fixed in this spec; nothing else is needed to render, validate and authorize it. |
| assistant-backend | hard | `prisma/schema.prisma`, `prisma/migrations/27_add_ai_assistant/**`, `src/lib/ai/assistant/**` (except protocol.ts; handlers exported from `handlers.ts`), `scripts/ai/assistant-tools.mjs`, `scripts/ai/assistant-tools.test.mjs`, `docs/ai-assistant.md` | — | vitest src/lib/ai + src/app/api/ai, prisma validate, migration count | Protocol and widget contracts are fixed; a fake Pi child fixture proves streaming/tools/confirm without UI. |
| assistant-ui | standard (ui) | `src/app/?main?/assistant/**`, `src/app/?main?/SideNav.tsx`, `src/app/?main?/boards/?boardId?/BoardEditPage.tsx`, `src/app/?main?/boards/?boardId?/BoardAiChat*`, `src/app/?main?/boards/?boardId?/ai-stream*`, `src/components/messages.ts`, `tests/e2e/assistant.spec.ts`, `tests/e2e/ai-boards.spec.ts`, `package.json`, `pnpm-lock.yaml` | — | vitest assistant, playwright assistant.spec, ui-judge | Renders the fixed protocol from synthetic SSE fixtures; does not need the real backend. |

## Notes for build

- Route files `src/app/api/ai/assistant/**` are 1-line re-exports added by MAIN at backend merge (owns parser cannot separate `src/app/(main)` from `src/app/api`).
- assistant-ui starts after compare-chart merges (same `src/app/` owns prefix) and renders chart parts with the merged `WebsiteCompareChart`.
- Serialize: only `assistant-backend` touches prisma; only `assistant-ui` touches package.json/lockfile (markdown renderer). If launch preflight sees `?main?` globs overlapping, start compare-chart + backend first, UI after compare-chart merges.
- After all three merge: MAIN runs the merged gate, builds the image, runs a live synthetic smoke against the real gateway (create a 3-site compare board, delete-confirm denied), then asks Randy before production (new additive migration this time).
