# AI board suggestions: staging evidence and release gates

## Offline full-chain receipt

The test-only launch shim and trusted synthetic provider now exercise the actual
exported POST handler, default `runAiTurn`, pinned Pi 1.4.0 standard CLI RPC agent
loop and existing host-tools extension. Identity is not mocked: encrypted signed
session tokens resolve real non-admin users from a disposable PostgreSQL fixture.
Permission helpers, scoped SQL reads, tool UI exchanges, draft validation and
response authorization are real. The synthetic model checks that the host returned
exactly one pageview before issuing `propose_board`.

Run only against the owned local fixture:

```sh
sh scripts/ai/synthetic-engines/setup.sh
DATABASE_URL='postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=integration' \
  npx --yes pnpm@12.3.4 exec prisma generate
DATABASE_URL='postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=integration' \
  npx --yes pnpm@12.3.4 exec prisma db push
AI_INTEGRATION=1 AI_PI_ROOT=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent \
  npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/integration.test.ts
```

The harness hardcodes the local synthetic database and checks its public ownership
marker before creating rows. Never use a production database URL. It inserts and
removes uniquely identified fixture users, websites, sessions and events; compares
all boards/reports before and after; waits for child exit and ephemeral HOME
cleanup, including after cancellation. Leave fixture engines alive through review;
use the fixture teardown script and its retained state receipt for later cleanup.
A dedicated `integration` schema avoids altering the public ownership marker.

Four tests cover launch guard rejection, new suggestion without a draft, refinement from a supplied
draft, unchanged persisted boards/reports, missing authentication (401), unauthorized
draft reference (403 before CLI launch), unauthorized final proposal reference
(403 after native proposal), unauthorized model-requested read (502, fail closed), synthetic model error (502), and HTTP abort (499). No network HTTP
listener/browser is involved: tests call the actual exported POST with Request.
Only PostgreSQL analytics are covered; ClickHouse fixture startup is not evidence
of ClickHouse endpoint parity. Browser new/edit behavior remains separate UI work.

The sole mocked primitive is `node:child_process.spawn`: it validates the native
bridge path, expected provider and isolation flags, then calls real spawn with
only an additional absolute `--extension` pointing at
`scripts/ai/integration/provider.mjs`. Original executable, arguments, cwd, stdio
and isolated environment are preserved. Unexpected launches fail assertions.
There is no fake RPC child, canned runtime callback, mocked identity/permission/SQL,
or injected host response. The explicitly trusted TEST extension registers an
in-process deterministic provider and emits model stream events consumed by Pi's
real agent loop. It never fetches or opens sockets. This is launch-boundary test
composition, **not an unmodified production provider launch**. `AI_INTEGRATION`
selects this test suite only; production code never reads it or discovers the test
extension. With the flag or installation path missing, tests skip and provide no
integration receipt.

The native turn/provider boundary is deterministic, not a live model quality or
provider compatibility test. Network denial is a deployment requirement, not
proven by this in-process provider. No production credentials or external provider
calls are needed. Pi `--offline` alone is not a network sandbox.

## Source constraint resolved by explicit test composition

`runAiTurn.configuration()` accepts only the explicit installation, provider,
model, key and egress settings. `runIsolatedTurn` creates a fresh private HOME,
writes only `agent/auth.json`, and executes native CLI RPC with discovery disabled
and exactly one explicit extension, `scripts/ai/host-tools.mjs`. That extension
registers tools, not providers. No custom `models.json`, provider extension, or
ambient developer configuration reaches the child. Selecting an invented provider
therefore cannot run a turn. `--offline` prevents discovery/update work; it is not
a synthetic model engine or an OS-level network firewall. Stock built-in provider
selection must not be used as an alleged credential-free offline integration test.

Pi's documented `registerProvider` custom streaming API supports the trusted test
extension. MAIN explicitly authorized only test-side launch argument composition;
production runtime/native/host-tools and authorization were not changed. Do not
add a production request field, environment switch or discovery hook for test code.

## Deployment requirements (not supplied by these tests)

Required server settings are `AI_ENABLED`, absolute `AI_PI_ROOT`, `AI_PROVIDER`,
`AI_MODEL`, `AI_PROVIDER_KEY`, and comma-separated HTTPS origins in
`AI_EGRESS_ORIGINS`. Pi must match the package name and version pinned by
`scripts/ai/native.mjs` (currently 1.4.0). Provider/model choices are server-owned,
not browser input. Install only reviewed trusted runtime code and extension assets.

The application-side origin check is not a network sandbox. Run the subprocess
under an unprivileged container/user with enforced network policy: allow only the
chosen model origin, deny internal/metadata services and arbitrary outbound
traffic. The host process alone retains database access. Verify DNS, redirects,
proxy behavior and the actual provider transport under deployment network policy.

Use a read-only installation and application filesystem with a bounded writable
ephemeral temp volume. Do not mount personal homes, credential stores, SSH agents,
cloud credentials, project secrets or persistent Pi session directories. Runtime
creates a private per-turn HOME and removes it after killing the child; its auth
file is mode 0600. That lifecycle is not equivalent to kernel filesystem isolation.
Keep the provider key in server secret storage, rotate it, and avoid prompt,
analytics, cookie, key, tool-result and child diagnostic logging. Enforce resource
limits and observe only sanitized operational signals.

First-release tools are `analytics_summary`, `analytics_breakdown`, and
`analytics_timeseries`, plus the non-persisting `propose_board`. This is a documented
capability subset, not coverage of every analytics query. Host authorization must
apply to every read and every referenced entity; the model is not an authorization
boundary. Suggestions remain drafts until explicit user save through normal board
flows. Process-local admission control does not provide distributed quotas. Verify
multi-instance capacity, cancellation cleanup, timeout behavior, data retention,
and provider data handling before a public rollout.

## License and release gates

Audit the resolved dependency tree and shipped artifacts, including transitive
licenses and notices. In particular `ua-parser-js` 2.x is an AGPL/commercial-license
release gate: establish the applicable license and distribution/service obligations
with qualified review before shipping. The root MIT declaration is not legal
clearance for all dependencies. Neither synthetic tests nor this document assert
production readiness, security certification, or legal clearance. No production
read, deployment, external provider call, or public release is authorized by this
procedure.
