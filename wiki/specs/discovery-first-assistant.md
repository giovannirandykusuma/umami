# Discovery-first interactive analytics assistant

Rung: epic. User approved discovery first, questions only when needed, real native RPC progress, repository-owned guidance, redesigned chat and repeated ordinary-prompt evaluations.

## Goal

Turn board chat into an interactive assistant that discovers authorized event metadata before claiming what can be measured, asks meaningful structured questions, and proposes supported local drafts. Preserve explicit Save, existing authentication and analytics permissions.

## Scope and contracts

1. Add `analytics_discover` to the existing read allowlist. Arguments: `{websiteId,startAt,endAt}` with existing strict UUID/date/cost bounds. Result: bounded event names/counts, property names/types and aggregate coverage where verifiable. Never return property values, identifiers, raw events or samples in discovery. Property names themselves remain untrusted, potentially sensitive analytics metadata. Enforce permissions and query scopes before and after every read. Do not guess login-success semantics from event names.
2. Shared `AiEvent` becomes a discriminated bounded event union supporting fixed progress phases and a final result/error envelope. `runAiTurn` remains native Pi RPC, returns `{message,draft?,questions?}`; optional `questions` is at most three records `{id,question,options?:[{label,value}]}` with bounded strings/options, unique identifiers, no executable actions. Questions are information gathering, never authority. Runtime and host validate results and UTF-8 budgets. Follow-up answers are ordinary bounded user messages, reauthorized each turn; no durable conversation database.
3. Maintain existing JSON chat endpoint compatibility. Add opt-in SSE via `Accept: text/event-stream`; events have `event: progress|result|error` and JSON `data`. Stream fixed phase status only, no raw reasoning, model tokens, credentials, analytics payloads or tool arguments. Validate final result before emitting it. Check auth/input before starting streaming. Disconnect/cancel aborts native turn; late events cannot mutate a draft. Preserve existing JSON error semantics for nonstream clients.
4. Chat renders live activity, structured clarification choices/free text, visible current website/date assumptions, meaningful empty/pending/cancel/error states and a draft preview. Only a validated final draft updates local state; existing Save remains explicit. Match Umami's existing design system; desktop/narrow/keyboard support required. Unsupported analysis is explained honestly, with needed event/property information rather than a generic retry error.
5. Explicit trusted repository-owned runtime guidance describes discovery, semantic checks, clarification, supported tools/widgets, data minimization and error handling. Do not enable ambient Pi skill/extension discovery. Guidance must be backed by code schemas and host authorization. Baseline-versus-candidate synthetic evaluations must challenge unsupported and ambiguous requests, not only scripted tool JSON.

## Non-goals

No arbitrary SQL, raw property-value disclosure during discovery, account-audit feature, automatic saves/sharing, namespace-sandbox claims, private source copying or production analytics extraction as a development fixture. Do not promise a username/login-count chart if current renderers cannot express it. This epic establishes actual available data and supported next steps; new aggregation widgets require a separately explicit capability contract if necessary.

## Acceptance

- `npx --yes pnpm@12.3.4 exec vitest run src/lib/ai` passes; real engine integration separately enabled and not counted as passed when skipped.
- Discovery tests cover authorization/revocation, multiple sites/teams, malformed arguments, large metadata, zero events, no property values, and actual query deadlines.
- Runtime/stream tests cover correlation, ordered fixed progress, one terminal event, malformed/oversized questions, disconnect, cancellation, no late mutation and JSON-client compatibility.
- Board component tests plus `npx --yes pnpm@12.3.4 exec playwright test --config=playwright.config.ts tests/e2e/ai-boards.spec.ts` exercise actual UI with synthetic fixtures: discovery progress, clarification choice/free text, supported draft, unsupported login-count request, cancel/retry, new/edit boards and explicit Save.
- Repeated synthetic ordinary-request evaluation: at least three runs each for supported board, missing website, ambiguous login event, absent username property, unsupported grouping and refinement; record every failure, no cherry-picked pass. No real identities or analytics in evaluation prompts.
- Changed-path TypeScript clean relative to recorded upstream baseline; `git diff --check` clean. Fresh code and visual gates before merge. Source-bound image and authenticated synthetic acceptance before any production rollout.

## Review focus

Metadata is not inherently non-sensitive. No raw event/property values may enter discovery output. Model-provided questions/options must not become host identity or arbitrary query authority. Preserve strict reference authorization, scoped DB execution and output bounds. Ensure streaming does not leak partial unauthorized results or conceal terminal failures. Never expose raw reasoning. Playbook instructions do not replace executable validation.

## Touched

- `src/lib/ai/rpc/contract.ts`: event/result types and analytics read allowlist.
- `src/lib/ai/runtime.ts`, `scripts/ai/host-tools.mjs`: native RPC progress, discovery schema and clarification result validation.
- `src/lib/ai/server.ts`, `src/app/api/ai/boards/chat/route.ts`: authorized metadata, streaming and final reauthorization.
- `src/queries/sql/events/getEventDataEvents.ts`, `getEventDataProperties.ts`: existing public query semantics as reference; avoid helpers that expose property values.
- `src/app/(main)/boards/[boardId]/BoardAiChat.tsx`: interactive state and presentation.

## Lanes

| Slice | Owns | Dependency | Independence |
|---|---|---|---|
| Runtime/progress/clarification contract | rpc contract, runtime/tests, trusted extension | none | Can prove native events and final validation with synthetic child/provider fixtures. |
| Authorized metadata discovery + HTTP stream | server/tests, discovery module/tests, AI API routes | runtime contract | Can test authenticated streaming/read boundaries independently of UI. |
| Chat UX | board components/tests, browser test, UI docs | host/runtime contract | Fixed SSE/result contract permits synthetic HTTP UI fixtures. |
| Guidance and repeated evaluations | dedicated trusted guidance + eval harness/docs | discovery/runtime stable | Compare baseline/candidate behavior without changing auth or rendering. |

Runtime and server slices serialize around contracts; UI starts once API ownership closes because route-group ownership parsing otherwise conservatively overlaps. Shared package/config/image changes stay MAIN-owned. All workers/reviewers use the user-mandated model and thinking route configured in this repo.

## Assumptions

User's 'data already there' is a hypothesis, not a verified production fact. Discovery must reveal missing or ambiguous event semantics. User selected asking only when needed. Existing native CLI and same-process confinement remain fixed. No additional interview is required for the approved scope.
