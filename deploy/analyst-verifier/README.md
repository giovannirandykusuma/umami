# Verifier boundary (stage 2)

This slice implements fixture verification, not AnalysisWidget integration. No model
calls, application auth impersonation, widget registration or shared flag changes
are included. Default dispatcher flags are false. Receipts explicitly say
`rendered_not_inspected`; this code cannot mint visual `verified` status.

## Local deterministic acceptance

Run serially with Node 22:

```sh
npx --yes --package=node@22 node --test scripts/ai/verifier/*.test.mjs
PLAYWRIGHT_WEB_SERVER_COMMAND='node scripts/ai/verifier/fixture-server.mjs' \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4319 PORT=4319 \
npx --yes --package=node@22 --package=pnpm@12.3.4 pnpm exec playwright test \
  -c playwright.config.ts tests/e2e/analyst-verifier.spec.ts --workers=1
```

Existing Playwright environment overrides suffice; MAIN need not edit shared config.
The server on 4319 is just config readiness; each test owns a separate ephemeral
loopback listener. It accepts no public token issuance or fixture-control endpoint.
Synthetic scope, widget IDs, hashes and executions are deterministic test inputs,
not evidence of real saved query execution. The child-process test exercises actual
Chromium through private IPC with an explicit environment allowlist and no app
secrets. It is **not** proof of OS/container egress isolation.

## Disposable Docker OS-egress proof

Run `sh scripts/ai/verifier/docker-proof.sh`. The script builds the packaged
Playwright 1.63 browser/fonts image, creates an internal-only network with exactly
two inspected peers (synthetic fixture and verifier), runs the real renderer inside
the restricted verifier, and removes its own containers/network/image afterward.
It prints inspect evidence, bounded raw TCP/HTTP probes and desktop/narrow hashes;
it prints no screenshot bytes. Both peers use UID 10001, read-only rootfs, no mounts,
no privileges or added capabilities, no-new-privileges, bounded memory/pids/tmpfs.
The verifier has 128 MiB shared memory and no extra networks or published ports.
Raw sockets to Internet IP/hostname, metadata, link-local and host gateway must fail
from the same container that successfully captures the internal fixture. Browser
external resources and a real external redirect also fail. No host fork fallback
is used by this proof. Build-time package downloads happen before runtime isolation.

Docker internal networks allow their peers to communicate; this two-service
boundary is not safe if arbitrary extra peers are attached. Membership is asserted
before starting and while the verifier runs. The fixture serves only synthetic
content and is not a forwarding proxy. Its hardcoded one-use synthetic bootstrap
and redirect endpoint exist only in `container-app.mjs`, never application auth.
This validates local HTTP service-name topology only, not production HTTPS,
certificate/ingress/proxy topology or Kubernetes CNI enforcement. Production needs
its own evidence and trusted authority adapter before any flag can be enabled.

## Deployment gate (not deployed or certified here)

`network-policy.yaml` is default-deny ingress/egress for a dedicated namespace.
Only the labeled internal verification listener on TCP 4319 is reachable. No DNS,
Internet, metadata or other application ports are allowed. It requires a CNI which
enforces NetworkPolicy. Apply namespace labels carefully; no unrelated pods belong
in this namespace. The internal listener must reject every path except exchange,
canvas and receipt and enforce scoped read-only sessions on each request.

The production launcher must run `scripts/ai/verifier/child.mjs` under a distinct
non-root identity with a read-only root filesystem, no service-account token,
no production environment/secrets/host mounts, dropped capabilities, seccomp and
private bounded tmpfs for Chromium. Install packaged browser/fonts/assets in its
image; no runtime downloads. Its private IPC transport must enforce the same bounded
image response contract as the host dispatcher. Do not set `isolated: true` until
that launch path and real egress probes are validated. The local fork is a test
transport, not an application-host fallback. `launch` is host configuration only.

Release still requires MAIN's authenticated scope/authority adapter bound to current
board, task, principal and exact analysis revisions/hashes, on exchange, render and
artifact release. A boolean supplied by a caller/model is not authority. The host
must call artifact cleanup when a task/chat is deleted or cancelled and dispose
artifacts on downstream model failure. Artifact bytes stay memory-only and have an
active 15-minute deletion timer; fetch capabilities expire at 60 seconds. No durable
receipt contains tokens or images. Do not persist IPC bodies, raw browser messages,
artifacts or capability material in logs. Child stdout/stderr are discarded.

Pi image transport budgets, model image preflight, session/image redaction and
actual native/AnalysisWidget instrumentation are later integration gates. This
slice does not modify or certify those paths. The renderer accepts PNG only; it
validates framing/CRC, bounded decompression, dimensions and scanline filters before
release. Unsupported formats fail closed.

## Stage-4 integration (MAIN) — what exists and what B3 still needs

- **Adapter:** `src/lib/analyst-verifier/port.mjs`. `analystDeps().verifier` is non-null only when
  `AI_ANALYST_VERIFIER_ENABLED=true` AND trusted bootstrap called
  `registerIsolatedLauncher({ launch, origin })` with the restricted-identity launcher. Nothing
  registers one by default, so production stays `null` (fail closed, no host-browser fallback).
  Authority (`verifierAuthority` in `analyst/deps.ts`) re-reads the task, user, board and analysis
  rows on every capability/session/artifact use and requires an active task plus exact revisions.
- **Fixture:** `sh scripts/ai/synthetic-engines/setup.sh && sh scripts/ai/analyst-fixture/setup.sh`
  creates and migrates a schema-comment-receipted `analyst_fixture` schema on PG 25432 and seeds
  admin/umami plus one synthetic website. It refuses other databases and unreceipted schemas.
  `node scripts/ai/analyst-fixture/app.mjs` runs the app on 127.0.0.1:3327 with an explicit env
  allowlist (`AI_ENABLED=false`, so no model calls, and no host secrets). Then
  `node scripts/ai/analyst-fixture/smoke.mjs` performs a real login, analysis create and native execute.
- **Widget receipt contract (UI worker, BoardViewColumn/AnalysisWidget, NOT yet wired):** each widget
  root carries `data-analysis-widget=<board widget id>`, `data-analysis-state` ∈
  `loading|rendered|empty|error|denied|unsupported` from `queryRenderState()` (query result only),
  and `data-execution-id`/`data-definition-hash` only from the execute envelope
  (`receiptAttributes()`; native charts get them via the `Chart` `receipt` prop). The verifier
  canvas page must expose `window.__verifierReceipt = {boardId, boardRevision,
  analysisRevisions, widgets:[{id,state,executionId,definitionHash}], complete}` built from those
  attributes, inside one `[data-verifier-canvas]` root, after every widget has left `loading`.
- **Pending (not passed):** the canvas route that serves the real board under the exchanged session
  (`/exchange`, `/canvas`, `/receipt` on the internal origin), B3, and D2. Do not report them from
  B2/fixture evidence.


## Restricted launcher and offline fixture (integration round 2)

- `src/lib/analyst-verifier/launcher.mjs` is the trusted launcher. For each job it starts one
  `umami-analyst-verifier:local` container (`--network none`, uid 10001, `--cap-drop ALL`,
  `--read-only`, `no-new-privileges`, no mounts, no env, tmpfs `/tmp`). The only channel is
  stdio JSON lines. The capability exchange and the canvas/receipt GETs are answered by the host
  (`canvas.mjs`) over that channel. No network proxy exists, and the browser aborts every other
  request. `createVerifierPort` accepts only launchers built by `createDockerLauncher`; a
  `{launch, origin}` callback object yields no port.
- Bootstrap: with `AI_ANALYST_VERIFIER_ENABLED=true` AND `AI_ANALYST_VERIFIER_LAUNCHER=docker`,
  `deps.ts` registers the docker launcher. Both are default-off and there is no host fallback.
- Receipt binding: `prepareVerifierWidgets` re-executes each widget's saved analysis (widget ->
  analysis from the stored board at the captured revision) with the task principal. The
  receipt must match those exact `executionId`/`definitionHash` values, and stale or foreign
  values are rejected.
- PRE-B3: the canvas is a query-backed data table, NOT the real board/AnalysisWidget route.
  Real-widget capture (B3) and visual acceptance (D2) stay pending until the UI checkpoint
  is restored.
- Build the image: `sh scripts/ai/verifier/build-image.sh`. Proof (real container, raw egress
  probe): `node scripts/ai/verifier/docker-launcher-proof.mjs`.
- Fixture placement: `app.mjs#systemTemp` ignores `$TMPDIR`. A lane may point it at a
  repo-internal scratch dir whose ancestors hold `.pi`, and the native discovery guard
  (unchanged) would refuse that. It uses the platform temp (macOS
  `getconf DARWIN_USER_TEMP_DIR`, Linux `/tmp`). The temp must be a real directory owned by the
  user (or root with the sticky bit), and no ancestor may contain `.pi`/`.agents/skills`. Each run
  takes a unique `mkdtemp` 0700 directory holding the project, HOME and TMPDIR. Owned cleanup:
  app.mjs removes exactly that directory on exit (also on an env-leak refusal). No global env or
  shared files are modified.
- Runnable smoke (any TMPDIR, e.g. a repo scratch dir):
  `AI_PI_ROOT=/abs/pi sh scripts/ai/analyst-fixture/run-smoke.sh 3338`.
- Offline fixture: `scripts/ai/analyst-fixture/app.mjs` boots Next from a sanitized temp
  project (no `.env*`; env canary in `app.test.mjs`). The assistant uses the synthetic-only
  `offline-provider.mjs` through native Pi RPC. `runtime.ts#offlineFixtureRuntime` refuses
  unless the env is non-production, uses the exact synthetic DB URL, has no live provider keys,
  and carries a nonce matching the launcher-written receipt.
