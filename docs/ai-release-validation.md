# AI release synthetic validation

## Result: authenticated strict proposals passed

Actual reviewed image `umami-ai:reasoning-release`, ID `sha256:45255af191b2be5988728fb0da8588153d9c49209697ac5c83a64af2ce8dca9f`, source `b13e11bb9`, ran as amd64 with Node **v22.23.4** and Pi **1.4.0**. No rebuild, production data, SSH, backup, deployment or private source copy was used. `SKIP_BUILD_GEO=1` remains an image limitation: this is not geo-asset parity evidence.

The final live run used the exact authorized advertised model **`cx/gpt-6.1-sol`**, alias `nine-router`, and `AI_REASONING_LEVEL=medium`, with the same operator credential and HTTPS base URL supplied only in memory.

| Check | Final result |
| --- | --- |
| Image startup and migrations against isolated synthetic PostgreSQL | Ready |
| Unsigned POST `/api/ai/boards/chat` | 401 |
| Signed non-admin one-turn request | 200; 1 exact strict TextBlock draft |
| Two concurrent requests, separate signed non-admin users, same app process | 200 / 200; 2 exact strict TextBlock drafts |
| Complete board/report snapshots after each phase | Unchanged |
| Native proposal tool observations | 3 proposals, each with a draft object |
| Analytics reads | 0 |

Each user owns a separate invented website and board. The harness signs HMAC-SHA256 JWTs with the application's secret derivation and PBKDF2/AES-256-GCM envelope; authentication/authorization and database reads remain real. Response validation requires exactly `message` and `draft`, a message string, and deep equality with the requested website-preserving single-row/single-column TextBlock draft. Message-only responses fail. The invented instruction explicitly requires separate top-level `message` and `draft` tool arguments; it does not accept a JSON draft embedded in message. Nothing is saved by proposal execution.

## Reproduction and safety

Run from the repository root with Docker, the pinned image loaded, and `postgres:16-alpine` available. The current harness requires repository dependencies (`zod`) and a host Node version providing `stripTypeScriptTypes`; dependency installation is shown below. Supply the following from an operator-controlled environment source, never a command-line key or committed private endpoint:

- `AI_PROVIDER=nine-router`
- `AI_MODEL=cx/gpt-6.1-sol` — preserve **both hyphens** exactly
- `AI_BASE_URL`: authorized HTTPS origin plus `/v1`
- `AI_EGRESS_ORIGINS`: that exact HTTPS origin
- `AI_PROVIDER_KEY`: dedicated authorized credential

The harness fixes `AI_REASONING_LEVEL=medium` inside the app container.

```sh
node --check scripts/ai/release-smoke/run.mjs
node --test scripts/ai/release-smoke/diagnostic.test.mjs
RELEASE_SMOKE_DIAGNOSTIC=1 node scripts/ai/release-smoke/run.mjs
```

Exit 0 from `run.mjs` requires all executed proposal and persistence assertions to pass. Default execution tests one and two concurrent turns. `RELEASE_SMOKE_SINGLE_PROBE=1` restricts diagnosis to one turn and is not full capacity validation. The final successful evidence used the default one-and-two phases.

The harness creates randomly named owned containers/network, with no published database port. Docker allocates an unused loopback HTTP port; no fixed port takeover or unknown-process kill occurs. A `shikumi_ports` tool was unavailable. The provider receives invented text/generated fixture identifiers only. TLS verification stays enabled. No host credential directory or private source tree is mounted. Only the dedicated provider key enters through an ephemeral mode-0600 env file deleted immediately after launch. Normal/caught-error completion removes owned containers, network and temporary directory. Hard kills cannot execute JS cleanup; confirm ownership before removing any leftover generated `release-smoke-` resources. Docker administrators can inspect container environments.

Optional diagnostic mode read-only mounts the public owned `diagnostic.cjs` preload in the app. It observes real native spawn output without changing native argv, environment or permission grants. Only allowlisted event counts, fixed error categories, numeric statuses and memory are emitted; no prompts, payloads, raw child logs, keys or provider bodies. Final successful native observations had zero stderr bytes and invalid JSON records. Child termination after settlement is host cleanup, not a failed proposal.

## Successful-turn memory evidence

Final successful run, bytes; app cgroup observation limit **2 GiB**, not a production recommendation:

| Phase | Sampled cgroup current peak | Kernel cgroup lifetime peak | Sampled app RSS peak | Sampled Pi RSS peak | Samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| One successful turn | 413097984 | 426373120 | 301404160 | 69234688 | 14 |
| Two successful concurrent turns | 525987840 | 530788352 | 278257664 | 69238784 | 14 |

The final lifetime peak was about **506 MiB**. Lifetime peak is cumulative since container startup, not reset per phase. Other peaks are sampled maxima; the 250 ms delay follows Docker exec overhead. The sampler itself starts a small Node process in the cgroup and adds overhead. At most one native child was matched by RSS sampling, so simultaneous two-child RSS was not witnessed even though both requests were issued concurrently and succeeded. RSS and cgroup accounting are not interchangeable. PostgreSQL, host OS, Docker VM and other services are outside these app figures.

**Recommendation:** use **768 MiB as a provisional app-only cap** for synthetic/staging evaluation (about 262 MiB above this observed app high-water), not the whole production host budget. That cap was not tested here: the observed limit was 2 GiB. Do **not** approve a shared **1 GB production host** from this check alone: OS/database/other services and realistic analytics/traffic need additional headroom. Prefer at least a 2 GiB host for the same-process app topology pending representative host-wide measurement, rather than moving Pi into a new production service. No claim is made about production load, long-running growth, analytics-heavy turns or OOM behavior at the provisional cap.

## Earlier failures and correction

Earlier runs accidentally used **`cx/gpt6.1sol`**, missing both hyphens. These returned unsupported-model/server-error categories (400/503 in model error text) and masked application 502 responses. A single historical direct plain request also returned 503. Those results do **not** establish a gateway outage and do not apply to the correct model ID. Exact-model regression coverage now guards all three public harness scripts against that spelling regression. No model fallback was used: this was correction to the authorized selected ID.

The first corrected-ID run reached HTTP 200 but returned message-only proposals. A bounded prompt hypothesis explicitly requiring both top-level tool arguments then produced the three valid drafts above. No product change or permission broadening was needed in this lane.

`direct.mjs` is a separately authorized bounded diagnostic (one plain request, then one invented tool-schema request only on success); its exit 0 means status reporting completed, not that a proposal passed. `metadata.mjs` performs one metadata GET and emits selected-model numeric/boolean fields only. Neither is needed for normal release smoke execution, and neither is a retry loop.

## Discovery/questions SSE probe (spaced live chain passed; immediate UX fails)

The generic runner now defaults to discovery-release image ID
`sha256:e19f66d2fb480b7c3912662157e5530d6546f59a48745dc03e40c428b7b9d01a`
(operator-supplied source revision: `3cc6fc0da`). Before inference it checks the exact
`cx/gpt-6.1-sol` entry through the shared `/v1` resolver and compares image copies
of the public result and board validators with this checkout. This comparison binds
those files only; it does not attest every image source file.

MAIN approved an operator launcher that injects the gateway configuration and
current Pi credential into the child environment without printing either.
The child command is:

```sh
RELEASE_SMOKE_SCENARIO=discovery-question RELEASE_SMOKE_DIAGNOSTIC=1 node scripts/ai/release-smoke/run.mjs
```

This mode runs **at most three sequential authenticated non-admin HTTP requests**:
an ordinary tracked-login request, an ordinary-text answer choosing `login`, then
the known visits/popular-pages request. It stops after a failed phase; there are
no inference retries or model fallbacks. The first response must include bounded
questions, a read progress phase, no draft, and an explanation of the unsupported
username/login grouping. The follow-up must remain draft-free and explain the
limitation; the last request must produce a shared-schema-valid metrics/pages
draft. Questions are display data only and confer no executable authority.

Only disposable synthetic tables are seeded: `login`, `login_page`, and the
`username` property with `CANARY_INVENTED_USERNAME_NEVER_EXPOSE`. No real analytics
or production access is involved. The runner rejects that canary anywhere in the
final result, compares board/report and analytics/session snapshots, and removes
its containers, network, and temporary environment file in cleanup. All requests
accept SSE; the parser checks UTF-8, total/frame/progress bounds, a single result,
strict shared result validation, and clean EOF before considering a draft valid.
Error frames fail the probe without exposing their contents.

Local verification:

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
node --test scripts/ai/release-smoke/diagnostic.test.mjs
node --check scripts/ai/release-smoke/run.mjs
```

Eight Node tests pass, including categorical discovery observation, fragmented
canary detection, fragmented UTF-8, optional questions, malformed
and missing terminals, duplicate/post-terminal frames, error frames, unknown
question authority, invalid progress, and oversized frames. The mandatory
`affected-tests --base HEAD` still selects no tests because Vitest excludes `.mjs`;
its exit 1 is not an application test failure, and is not counted as green proof.

**Actual image run:** exact-model metadata preflight returned 200; both public
validator hashes matched; image runtime was Node v22.23.4 / Pi 1.4.0; unsigned
request returned 401. The first signed non-admin discovery request returned 200,
1405 SSE bytes, one valid terminal, clean EOF, all six progress phases including
`read`, one bounded question, an honest capability limitation, and no draft.
Board/report and synthetic analytics/session snapshots remained unchanged.
The categorical observer witnessed exactly one `analytics_discover` request and
one proposal. Host-to-native input was observed; the invented canary was absent
from both that input and observed native output. This observes the protocol
boundary, not private provider internals. No payloads were emitted.

The immediate follow-up returned **429**: the app retains a 60-second per-user
admission window even after the first stream ends. The run stopped there; the
third request was not sent. No retries or fallback were made. This original
partial receipt is retained at
`.pi/tasks/01a180e0-deac-7433-8442-6f606ab4d82a-14142/bbf1e0b82.output`.

MAIN then explicitly authorized one additional three-call run with planned
61-second same-user spacing. That run **passed** in 155 seconds, with no retries,
fallback or fourth call. Sanitized receipt:
`.pi/tasks/01a180e0-deac-7433-8442-6f606ab4d82a-14142/bb67edb2e.output`.

| Planned turn | HTTP / SSE bytes | Validated result | Discovery observations |
| --- | --- | --- | --- |
| Ordinary tracked-login request | 200 / 1485 | One bounded question, honest limitation, no draft | `analytics_discover`: 1 |
| Ordinary-text answer selecting login | 200 / 1071 | Honest unsupported-grouping explanation, no draft | `analytics_discover`: 1 |
| Known visits/popular-pages request | 200 / 1231 | Valid metrics/pages draft | No analytics read requested |

Each stream reached one validated terminal and clean EOF. Each phase preserved
board/report and analytics/session snapshots. All three native input boundaries
were observed and all three had canary=false on input and output. No stderr bytes
or invalid native JSON were observed. Native processes were signalled after
successful proposal handling; the harness does not claim normal native exit.
Second-run peak sampled cgroup was 414281728 bytes, lifetime peak 423931904,
app RSS 301477888, native RSS 69136384. Owned resources were removed.

**Severe immediate clarification UX issue, not fixed here:**
`src/lib/ai/server.ts:146-149` removes user entries only after expiry, rejects
`users.has(auth.user.id)` with 429, and sets expiry to `now + 60_000`.
Stream completion at `:428-430` decrements global `turns` but does not delete the
user entry; non-stream cleanup at `:463-464` likewise only decrements `turns`.
Thus the observed immediate answer after a successful question is blocked until
the original admission expires. The spaced chain proves provider/image/contracts
integration, **not instant interactive clarification usability**. MAIN must
separately evaluate and review an in-flight-only admission policy or a bounded
rate policy permitting clarification before deployment; no server file was changed.

The run removed its owned containers and network. First-turn sampled app cgroup
peak was 473763840 bytes; lifetime peak 484540416 bytes, app RSS 301793280,
native RSS 69128192. These are partial-run observations, not new deployment
sizing recommendations. The new spaced chain is the follow-up/known-metrics
proof; the historical scripted runs above are separate evidence.

## Other checks and limits

Frozen dependency install with `npx --yes pnpm@12.3.4 install --frozen-lockfile` succeeded. Three targeted Node tests passed: exact advertised model spelling plus two sanitizer tests. Required affected-tests was invoked after changes; it exits 1 with `No test files found` because configured Vitest include patterns exclude this owned Node harness. No full suite was run. Cleanup inspection found no owned containers or network remaining. This proves the bounded authenticated proposal flow and unchanged persistence, not deployment approval or complete security/load/geo validation.
