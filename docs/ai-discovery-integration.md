# Offline native discovery integration

`src/lib/ai/discovery.integration.test.ts` is opt-in. A skipped suite is **not** an
integration pass. It calls the actual exported board-chat POST with encrypted,
signed non-admin sessions, real ownership checks and PostgreSQL metadata queries.
It runs the installed, version-checked Pi 1.4.0 CLI and real host-tools extension.
No application runtime, auth, permission, SQL, or host-result implementation is
replaced. No HTTP listener or browser is involved.

The single test composition seam wraps `node:child_process.spawn`, preserving
production executable, argv, isolated environment, cwd and stdio. It adds an
explicit trusted offline provider extension and one exact `--allow-fs-read` grant
for that asset. All production permission flags remain intact. The provider uses
Pi's streaming model API and real agent loop to call `analytics_discover`, assert
the exact aggregate metadata shape, then call `propose_board`. It never connects
to a provider or uses production credentials. Production never selects this file.

This proves tool/result/protocol integration, **not live model behavior quality**,
semantic discovery accuracy, or deployed egress isolation. Future prompt guidance
does not change this deterministic provider's decisions. Event names do not
establish login success; the fixture returns clarification rather than asserting
that meaning. Property values, identifiers and samples are excluded by exact
provider-side assertions. Coverage remains explicitly unavailable.

## Replay

Install the package-manager dependencies and Pi 1.4.0 locally first. Set
`AI_PI_ROOT` to that installation (the example uses a user-prefix npm install).
The setup script reuses only its exact owned fixture pair after checking receipts,
PID, data directory, ports and container labels. It fails rather than stopping an
unknown service. The PostgreSQL URL and public marker are checked again by the
test before writing uniquely named synthetic rows. The dedicated schema keeps
Prisma schema synchronization away from the ownership marker.

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
sh scripts/ai/synthetic-engines/setup.sh
export DATABASE_URL='postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=discovery_integration'
export AI_PI_ROOT="$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent"
npx --yes pnpm@12.3.4 exec prisma generate
npx --yes pnpm@12.3.4 exec prisma db push
AI_DISCOVERY_INTEGRATION=1 npx --yes node@22.23.4 node_modules/vitest/vitest.mjs run src/lib/ai/discovery.integration.test.ts
```

Do not substitute a production database. Do not use `--accept-data-loss` or drop
the public schema. The existing setup script is a macOS-local fixture launcher;
container-image replay is a separate release gate. Native local Node 22.23.4
matches the pinned production Node version and is exercised by the command above.

## Assertions and cleanup

Seven scenarios cover exact metadata-only reads and bounded clarification;
follow-up untrusted history yielding a strict supported traffic draft through
JSON compatibility; missing authentication without native launch; unknown
website tool arguments failing closed; revocation after native settlement but
before a backpressured SSE terminal delivery; cancellation; and the real
45-second host deadline. Successful streamed output has ordered
start/check/read/prepare/validate/complete phases, one result and EOF. Failed
streams have one error, no result, and EOF. The JSON unknown-website case also
requires the actual extension request for that exact unauthorized target before
the generic 502; a provider startup failure cannot satisfy it. Revocation waits
for observed propose_board and non-aborted settlement before changing ownership.
The timeout requires provider readiness, verified SQL metadata, an explicit waiting
state and 44–52 seconds elapsed, not merely any error. Fixed stderr status markers
carry no payload; a provider assertion-failure marker fails suite cleanup even in
negative scenarios. An always-run negative-control test proves immediate startup
errors and provider assertion failures cannot satisfy deadline evidence.
No raw protocol payloads are logged.
A fresh synthetic non-admin identity per scenario respects the real per-user
60-second admission policy without faking time or resetting production modules.

Fixture rows are removed, children are awaited and isolated homes must disappear.
No suggestion is saved; persisted board/report counts must match the initial
baseline, including after the JSON draft case. The fixture engines stay running for independent review;
MAIN should use the existing receipt-checked teardown script after the judge.
ClickHouse is started by the shared fixture launcher but this suite covers only
PostgreSQL. It does not claim rendered UI coverage, ClickHouse parity, a live
provider turn, or Node 22 image validation.
