# Disposable AI acceptance engines

Prerequisites: macOS Homebrew PostgreSQL 16 at `/opt/homebrew/opt/postgresql@16/bin`, running Docker, `clickhouse/clickhouse-server:24.8` image, curl/lsof, and installed project dependencies/generated Prisma client. No application `.env` is sourced. Fresh setup requires both loopback ports 25432 (PostgreSQL) and 28123 (ClickHouse) to be free. Replay returns success only for the exact owned running pair: container state label/ID and loopback binding, state receipts, PostgreSQL listener PID/data directory/database marker, and authenticated ClickHouse health must all match. Unknown or partial fixtures fail closed without replacing anything. If busy, query `shikumi_ports` before any action; never stop unrelated services.

From the repository root:

```sh
sh scripts/ai/synthetic-engines/setup.sh
AI_SYNTHETIC_ENGINES=1 npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/query.engine.test.ts
npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/server.test.ts
npx --yes pnpm@12.3.4 exec vitest run src/lib/ai
/Users/randy/Developer/personal/shikumi/scripts/affected-tests --base HEAD
```

Setup is a service-lifecycle receipt, not a test. It prints STATE, PostgreSQL PID and container ID; logs, ownership markers and database files live under that unique `/tmp/umami-ai-synthetic.*` path, independent of the worktree. Ports bind only to 127.0.0.1. PostgreSQL uses a fixture-only user/database `ai_synthetic` with trust authentication on this disposable loopback service. ClickHouse uses `ai_synthetic:synthetic-only`. Never put real data here. Tests overwrite database connection variables with these exact loopback endpoints, disable replicas/Redis, verify the PostgreSQL fixture marker and create only synthetic tables. Reruns tolerate their existing fixture tables. No provider calls, production endpoints, persistence tools or real application data are used.

**Leave engines UP through fresh judge replay.** Only after MAIN confirms review completion:

```sh
sh scripts/ai/synthetic-engines/teardown.sh /tmp/umami-ai-synthetic.STATE_FROM_SETUP
```

Teardown validates the ownership marker and exact container ID/label before stopping that container and data-directory postmaster. It retains logs/data for inspection; MAIN can subsequently remove that exact STATE directory. If setup partially fails, use its retained receipts to inspect and stop only its owned resources; do not kill listeners by port.

## What the engine proof covers

Five required tests cover PostgreSQL server statement timeout, read-only rollback/write refusal, active-query cleanup, all four admission recovery after abort, expired callback fencing, actual model reads, actual board authorization helper reads and revocation, concurrent scoped/unscoped statement settings, and ClickHouse deadline/abort/recovery with no residual slow queries. Unit helper forwarding additionally covers website permissions and getQueryFilters; not every auth helper is engine-tested.

PostgreSQL cancellation is a server statement timeout (1s) followed by transaction rollback, not immediate wire cancellation. Separate AI pool acquisition is bounded and ordinary pool settings remain unchanged. ClickHouse `max_execution_time=1` is checkpoint-based; HTTP abort is not KILL QUERY. The test allows time for server cleanup and does not claim hard instantaneous cancellation. Redis/auth network partitions and every network failure mode are not proven bounded by SQL limits. Full TypeScript currently has unrelated baseline errors; changed-path diagnostics are checked separately.
