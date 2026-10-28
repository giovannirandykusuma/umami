# Global AI assistant backend

The shared contract is `src/lib/ai/assistant/protocol.ts`. The backend exports
`listChats`, `createChat`, `getChat`, `renameChat`, `deleteChat`, `runTurn`, `reply`
and `cancel` from `handlers.ts`. MAIN must add the corresponding Next route
re-exports under `/api/ai/assistant/chats` (GET/POST), `/{chatId}`
(GET/PATCH/DELETE), `/{chatId}/turn`, `/{chatId}/reply`, and `/{chatId}/cancel`
(POST). Route files and the UI are deliberately outside this implementation.

Apply migration `27_add_ai_assistant` and regenerate Prisma before deploying.
Chats and messages are scoped to the authenticated user. Foreign chats return 404,
including on reply/cancel. The first user message supplies the automatic title.
An active chat returns 409 on another turn or deletion; cancel it before deleting.

## Native runtime

Uses the existing pinned `scripts/ai/native.mjs` entrypoint, Node permission
confinement, gateway model configuration and explicit trusted extension loading.
Configure `AI_ENABLED=true`, `AI_PI_ROOT` (absolute pinned Pi 1.4.0 installation),
`AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_PROVIDER_KEY`,
`AI_EGRESS_ORIGINS`, and optionally `AI_REASONING_LEVEL` exactly as for board AI.
No built-in tools, MCP, skills, project context, or discovered extensions load.
The new extension only exposes `umami_api`, `ask_user`, `show_chart`, `open_link`.
The Docker runner already copies scripts, so no Dockerfile change is needed.

Each turn restores the chat's Pi JSONL into a private temporary session directory,
streams text/thinking and tool events, saves the updated session, and removes the
temporary directory. Session snapshots over 2 MiB are dropped whole rather than
slicing JSONL and leaving dangling parent IDs. The visible persisted transcript
is retained even if the model's native context is dropped. Cancelled and failed
turns also persist their assistant timeline and any available session snapshot.
SIGTERM is followed by SIGKILL after one second. Limits are one turn per chat,
four per Node process, five minutes, 40 tool calls and 8 MiB RPC output.

## API authorization and dispatch

The host—not the model child—performs HTTP requests to the fixed base
`http://127.0.0.1:${PORT || 3000}${BASE_PATH || ''}`. This was chosen over
in-process importing because the whole API already has route-specific validation
and authorization; bypassing or duplicating that machinery would increase the
security surface. Only the requesting request's Authorization, Cookie and
x-umami-api-key headers are forwarded. No service/admin identity is introduced.
Use a trusted single application on this loopback port, and configure PORT and
BASE_PATH to match the running app. Redirects are forbidden. Paths must be plain
relative `/api/...` paths without traversal, encoding, query strings or hosts;
query values are encoded separately. `/api/auth/**` and `/api/ai/**` are blocked.

Every DELETE and POST ending `/delete` or `/reset` emits an in-chat confirmation.
Only a matching reply on the same owned chat can approve it. Rejection,
five-minute expiry or cancellation never dispatches the API call. Questions
similarly wait for a matching answer and enforce option-only answers when asked.
Chart types are allowlisted; link targets are relative app paths only. API results
are bounded while reading (32 KiB for the model, 8 KiB for stored tool details).
Analytics data and API responses are untrusted data, not instructions.

The current active-turn registry and pending interactions are process-local.
Run with sticky routing to a single Node process for a given chat; multi-worker
cross-process locks and restart recovery are not implemented. A process crash
cannot finalize a running assistant message. The old board-chat flow is unchanged.

## Verification

Offline tests launch a fake native RPC subprocess for streaming, tool exchange,
session restoration, cancellation and deadline behavior. Handler tests cover
ownership, authentication, persistence, concurrency and stream cancellation.
Host tool tests exercise path guards, delete approval/denial/expiry and questions.
The extension's Node tests use real lockfile-installed TypeBox schemas but no
provider. No real model/provider or live-database integration was run.
