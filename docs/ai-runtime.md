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
- `propose_board` (proposal only; not persistence)

The three read names are an **initial capability subset, not an aggregate-only
permission policy**. Full authorized analytics is allowed by the product contract;
future explicit tools can expand this subset. There are no shell/filesystem/code,
board save/delete/share/permission tools. Parameters are bounded JSON objects;
the authenticated host's injected `executeTool` MUST validate per-tool arguments,
recheck website/account authorization on every read, and bound returned data.
No user or assistant identities are accepted in conversation records. Analytics
strings and history are untrusted data, not instructions. Model text is not
forwarded as raw HTML or logged. Status events are fixed bounded values.
`propose_board` returns a bounded plain message and optional draft; the host uses
the real strict `validateBoardDraft` validator before returning. Nothing saves it.

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
