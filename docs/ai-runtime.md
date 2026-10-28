# Native Pi AI turn runtime

`runAiTurn({ messages, draft, signal, executeTool, onEvent })` is server-only and off
unless `AI_ENABLED=true`. Each turn launches the **standard Pi 1.4.0 CLI in
`--mode rpc`**, through `scripts/ai/native.mjs`. There is no SDK JSONL bridge.
The launcher checks the installed package name/version and imports its CLI entry;
it does not download anything. Provision that exact package in the deployment
image, set an absolute `AI_PI_ROOT`, and keep it and the trusted extension read-only.
Package provisioning/lock ownership belongs to the main integration, not this lane.

Required server settings: `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`,
`AI_PROVIDER_KEY`, and `AI_EGRESS_ORIGINS` equal to the single HTTPS origin of
`AI_BASE_URL` (which may include a `/v1` path). These are never client parameters.
A fixed OpenAI-completions `models.json` is generated in mode-0600 per-turn scratch,
using `$AI_PROVIDER_KEY` environment interpolation and text-only input. The model
has `reasoning: true` and `thinkingLevelMap` mapping `off: "none"`,
`minimal: null` (unsupported), `low: "low"`, `medium: "medium"`, `high: "high"`,
and `xhigh: "xhigh"`. Compatibility is fixed to `supportsStore: false`,
`supportsDeveloperRole: false`, `supportsReasoningEffort: true`,
`maxTokensField: "max_tokens"`, and `thinkingFormat: "openai"`.
Optional server-only `AI_REASONING_LEVEL` defaults to `medium`; only `off`, `low`,
`medium`, `high`, and `xhigh` are accepted. Empty/unknown/unsupported levels fail
before child launch. The host explicitly passes `--thinking <level>` and allowlists
this setting in the child environment; clients cannot choose it. The native CLI
is unchanged. Arbitrary native
config, commands, paths, headers and client fields are not accepted. The key is
not written to disk or placed on the process command line. No inherited developer authentication,
PATH, NODE_OPTIONS, proxy settings, resource settings, or unrelated secrets enter
the child. Only explicit settings and isolated HOME/cwd/temp/XDG/Pi directories
are passed. All turn files are deleted after the child is killed/reaped.
TLS verification remains enabled; no TLS bypass, NODE_OPTIONS, proxy, or inherited
CA configuration is passed.

## Native protocol and tools

The host sends only `prompt` and correlated `extension_ui_response` records. The
smoke sends only `get_state`. No general RPC endpoint is offered to the model.
LF JSON records are decoded as UTF-8, not split on Unicode paragraph separators.
Prompt response ID/command/success/disposition must match. A response acknowledges
acceptance; `agent_end` is not terminal. Completion requires both the correlated
`started` response and `agent_settled`, a valid final proposal, and no pending
reads, with native `aborted: false` explicitly present. Native `tool_execution_end`
requires a nonempty string call ID, an allowlisted tool name and `isError: false`.
A failed/denied tool is terminal for this host even if Pi could recover; unknown
tools need not reach the extension UI for the host to reject the turn. Malformed
error/abort fields fail closed. Ordinary `agent_end` remains nonterminal and a
successful tool outcome is not itself an error.
Child exits, malformed records, errors, deadline and abort fail closed.
The child is SIGKILLed and reaped on success too: no pooled conversations.

All automatic extensions (including codemode/MCP), skills, prompt templates,
themes, context files, project approval, builtin tools, persistence and automatic
catalog networking are disabled with native flags. Exactly one explicit trusted
extension is loaded, `scripts/ai/host-tools.mjs`. It asserts the active tool set
and model origin, exiting the child on mismatch (extension event exceptions can
be caught by Pi, so merely throwing would not enforce startup policy).
It exposes these first-release capabilities:

- `analytics_summary`
- `analytics_breakdown`
- `analytics_timeseries`
- `analytics_discover` (injected host implementation; metadata only)
- `propose_board` (proposal only; not persistence)

The four read names are an **initial capability subset, not an aggregate-only
permission policy**. Full authorized analytics is allowed by the product contract;
future explicit tools can expand this subset. There are no shell/filesystem/code,
board save/delete/share/permission tools. Parameters are bounded JSON objects;
the authenticated host's injected `executeTool` MUST validate per-tool arguments,
recheck website/account authorization on every read, and bound returned data.
No user or assistant identities are accepted in conversation records. Analytics
strings and history are untrusted data, not instructions. Model text is not
forwarded as raw HTML or logged. Progress events are fixed bounded values.
`propose_board` returns `{message,draft?,questions?}`. The public pure
`validateAiResult` boundary rejects non-JSON prototypes/accessors, unknown keys,
markup/control characters and oversized UTF-8 output (32 KiB), and uses the real
strict `validateBoardDraft` validator. Nothing saves it.

### Contract for the next host/stream slice

```ts
interface AiQuestion {
  id: string;
  question: string;
  options?: { label: string; value: string }[];
}
interface AiResult {
  message: string;
  draft?: BoardParameters;
  questions?: AiQuestion[];
}
type AiPhase = 'start' | 'check' | 'read' | 'prepare' | 'validate' | 'complete';
type AiEvent =
  | { type: 'progress'; phase: AiPhase }
  | { type: 'result'; result: AiResult }
  | { type: 'error'; error: string };
```

These types and `aiQuestionsSchema`, `aiResultSchema`, `analyticsDiscoverSchema`,
`validateAnalyticsDiscoverArgs` and `validateAiResult` are exported from
`src/lib/ai/rpc/contract.ts`; runtime also re-exports the event/result types.
The runtime callback emits **progress only**: start after child launch, check
when host input/configuration/isolation checks have passed, read when an accepted
host read is dispatched (repeatable), prepare when a final proposal arrives,
validate only after strict proposal validation, complete only after correlated
prompt acknowledgement, settled-not-aborted and no pending reads. No timer,
percentage, reasoning, tokens, IDs, tool arguments or analytics payloads enter
callbacks. Optional reads mean phases can be skipped. Observer exceptions cannot
affect settlement. Rejection/cancellation/timeout never emits complete; callbacks
stop after settlement, including late host reads. The promise remains the sole
terminal result/error source: the future HTTP adapter must reauthorize and
validate it before emitting one `result` or sanitized `error` SSE envelope.
Nonstream callers retain the same promise/JSON result shape without required new
fields. This slice does not implement HTTP streaming or host question handling.

Questions are 1..3 records with unique safe 1..64-character IDs (excluding
prototype keys), nonblank question text <=500 units, optional 1..6 options with
nonblank labels/values <=120 units, unique labels and values. Message <=2000
units. Strings are untrusted display text; options contain no action fields and
must never be interpreted as executable actions, authentication or permission.
Follow-up answers are ordinary bounded user messages, reauthorized each turn.
Question content is not a substitute for a supported renderer or query contract.

Discovery arguments are exactly `{websiteId,startAt,endAt}`: strict UUID and
integer Unix milliseconds in 0..8,640,000,000,000,000, ordered non-future range at
most 31 days (same host bounds, including equal endpoints). Runtime validates
before invoking the injected host. The host must still authorize before/after
every read and enforce its own deadline/budget. Discovery's future host result
must contain only bounded event names/counts, property names/types and verifiable
aggregate coverage: never property values, identifiers, raw events or samples.
Metadata is potentially sensitive and untrusted; event names do not establish
login-success semantics. No direct model DB access or ambient skill loading is
introduced. The dedicated trusted guidance/playbook remains a later slice.

Limits: 24 conversation messages, 32 KiB input, 256 KiB total stdout and stderr
(each), 32 KiB tool args/results, 8 reads, 12 turns, 45 seconds, 2 active children
per Node process. Host tool promises cannot be forcibly cancelled; they must
implement their own request deadlines/cancellation. Late results are ignored.
No sensitive diagnostics or model/tool payloads are logged or exposed as errors.

## Deployment boundary — NOT an OS sandbox

The native child now starts with Node `--permission`, read access only to the
pinned installed package's package.json, dist and installed runtime dependencies,
the explicit trusted extension/launcher, and scratch. Writes are scratch-only.
Canonical and lexical scratch aliases cover macOS `/var` symlinks. No child process,
worker, addon, WASI or inspector privilege is granted. Node 22.23.4 supports these
filesystem flags but has no network permission category; Node 26.10.0 has only
boolean `--allow-net`, not destination restrictions. The latter is explicitly
granted only on Node >=25. Neither runtime provides origin confinement here.

Approved discovery exception: Pi 1.4.0's unconditional trust scan probes ancestor
`.agents/skills` despite disabled discovery. Exact ancestor `.agents/skills` and
`.pi` paths are granted, never the ancestor directory itself. Before granting,
the host rejects any such path that already exists (including symlinks); planted
credentials/config/extensions therefore prevent launch. Public extension-loader
workspace fallback probes also require exact sibling agent/tui/ai dist entry files.

**Deployment requirement:** Node directory read grants include descendants, not
just `existsSync` metadata. The preflight check is not atomic with startup. A same-UID
process can plant resources after it runs; absence must be maintained by deployment
ownership/isolation, including the scratch ancestors. Use controlled `/tmp` in the
container with no secret/resource mounts, not a developer HOME scratch location.
This does not provide denial of planted files after launch. Auto-loading remains
disabled. Same-UID interference and these discovery grant races remain residual
risks, not a claimed security boundary. Startup smoke passes on Node22.23.4 and26.10.0.

The CLI and extension run under the same UID as their parent. Node permissions
are not kernel isolation. Deploy in a dedicated unprivileged container with no application/developer
credential mounts, read-only installation, isolated ephemeral writable storage,
CPU/memory/PID limits and enforced network egress. The configured origin check
only checks selected model metadata: it is NOT a firewall, redirect guard or DNS
rebinding defense. Enforce destination restrictions externally, including provider
redirects and telemetry. The supplied provider key is necessarily available to
the trusted CLI. Provider payloads can contain authorized analytics and history;
provider privacy/retention policy must be approved before enabling AI. Per-process
concurrency is not a distributed admission limit.

## Synthetic natural-language release probes

`scripts/ai/release-smoke/run.mjs` defaults to the original exact-JSON TextBlock
probe. Set `RELEASE_SMOKE_SCENARIO=ordinary` for “Create a dashboard showing visits
and popular pages for my website”, or `unsupported` for the reported request for
usernames and login counts. Use `RELEASE_SMOKE_SINGLE_PROBE=1` to bound each
hypothesis to one turn. The ordinary probe requires a visits widget and a path
MetricsTable; the unsupported probe requires a nonempty message without a draft.
These assertions do not prove the semantic quality of the explanation; review
that separately with invented fixtures. The runner uses only disposable synthetic
Postgres fixtures, authenticated non-admin ownership, a loopback app port, and
checks unchanged boards/reports. Provider credentials enter through environment,
not argv. Do not point this harness at a production database.

`RELEASE_SMOKE_DIAGNOSTIC=1` mounts a test-only native-spawn observer. It emits
fixed categories for missing/invalid website UUIDs, noninteger dates, unknown
argument keys, invalid breakdown dimensions/limits, and native lifecycle errors;
it never prints argument values, unknown keys, prompts, identities or provider
error text. This is not production logging.

On image `45255af191b2be5988728fb0da8588153d9c49209697ac5c83a64af2ce8dca9f`,
Node 22.23.4 / Pi 1.4.0, the ordinary probe reproduced HTTP 502 twice and the
unsupported probe reproduced HTTP 502 once using `cx/gpt-6.1-sol`, medium.
The categorized ordinary and unsupported runs each attempted `analytics_summary`
with invalid website and date arguments before termination; stderr was empty.
Unauthenticated requests returned 401 and boards/reports remained unchanged.
The baseline model-facing tools accepted arbitrary records without explaining
strict host arguments. BoardId-only requests also omitted authorized current
board parameters from the runtime. The source fix now publishes strict argument
and supported-widget schemas, reauthorizes selected references immediately before
egress, and supplies selected website IDs plus server-derived current time and
30-day millisecond bounds. Only a draft accepted by `validateBoardDraft` is sent;
legacy unsupported widgets are omitted rather than serialized to the provider.
No-selection guidance asks for a website instead of inventing one. Unsupported
username/login requests are instructed to return a useful message-only proposal,
not substitute traffic reads or invent widgets. Host validation remains strict.

Offline server/runtime tests cover boardId-only context, no-selection context,
pre-egress revoked permission denial, date bounds, strict model-facing arguments,
a valid visits/popular-pages widget proposal, and rejected unsupported metrics
and widgets. MAIN's synthetic-only source-bound candidate
`sha256:e3f722df5fdf9b7c11c270620fd82c9f60f369f9b8f1e1bae5ab75727507c463`
passed post-fix native probes with the same model/reasoning/runtime: ordinary
returned 200 with a visits widget and path MetricsTable; `no-selection` returned
200 with a selection message; unsupported returned 200 with a message mentioning
login/username capability and its limitation, without a draft. All native traces
contained one proposal and zero analytics reads, no stderr, and no model errors.
All probes retained unauthenticated 401 and unchanged synthetic boards/reports.
The first unsupported response was message-only 200 but failed a narrow wording
assertion; a single follow-up with boolean-only semantic categories passed.
Its original explanation text was not retained, so the original assertion failure
cannot be attributed to a specific phrase. No product code changed between runs.
These probes prove supported layout generation, not analytics-read execution.
Set `RELEASE_SMOKE_IMAGE` to an exact `sha256:` digest; tags are rejected.
Fresh review remains required before any production rollout.

Tracked username login counts are outside the three current read contracts.
`analytics_breakdown` accepts only path/title/referrer/hostname; it cannot group a
login event by an event property. The draft validator admits an event-name
MetricsTable but no arbitrary event-property grouping. Fulfilling that request
requires a separately reviewed, authorized bounded event/property aggregation
contract and a renderer/widget contract that can display its result. The actual
tracked event/property names and any identity-display policy must be established
before designing that capability; this diagnosis performs no production reads.

## Offline proof

```
npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/runtime.test.ts
AI_PI_ROOT=/absolute/pinned/pi-coding-agent node scripts/ai/smoke.mjs
```

The synthetic lifecycle tests cover native-shaped response/tool correlation, `agent_end` vs
settlement, invalid drafts using the merged validator, malformed output, byte,
turn and concurrency limits, deadlines, abort, kill/reap, cleanup and env isolation.
Native-shaped regressions cover denied/unknown tools without host UI, failed reads,
malformed tool IDs/names/error flags, proposal followed by aborted settlement,
malformed/missing abort flags, and a successful tool outcome.
Confinement tests additionally exercise strict reasoning selection and generated configuration rejection,
preflight rejection of planted ancestor credentials/models/extensions, and
real Node permission denials for app/repository/home reads, outside writes,
subprocesses and workers. The suite also attempts the installed native CLI smoke
(the local integration test's installation path is explicit). The smoke has no provider key and never sends a
prompt. It verifies `get_state` ID/command/success, idle state, extension startup,
exactly the four active tools and clean stderr, then kills/reaps and cleans up.
The same smoke separately invokes the pinned public Pi OpenAI-completions adapter
with an injected offline fetch and synthetic SSE response. It captures the actual
serialized request URL/body, asserting `reasoning_effort: "medium"`, `stream: true`,
`max_tokens`, no `store`/developer role, and parsed assistant text/stop. Native
`get_state` also confirms `thinkingLevel: "medium"`. No external provider/model
request or production analytics was tested. Reasoning parity is not proof that
this configuration resolves any live gateway 503; live acceptance is separate.

Implementation references read from installed Pi 1.4.0: README; docs/rpc.md,
docs/sdk.md, docs/extensions.md; CLI flags and resource controls (cli.md), RPC
commands, JSON events, extension-UI, configuration/security, environment variables,
models/providers, settings, sessions/session-format/message-types. Relevant source
checks: dist/modes/rpc/rpc-mode.js (native UI input/response and get_state),
dist/core/extensions/loader.js (explicit extension imports and typebox alias),
dist/core/extensions/runner.js (caught event exceptions), extension declarations.
