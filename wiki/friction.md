# Workflow friction

## 2026-10-27 — AI boards API review orchestration

- Replayed command receipts must not depend on lane-only scratch environment variables; use portable node subprocess diagnostic capture.
- Engine fixture teardown before independent review destroyed reproducibility. Keep explicitly owned disposable services available through judge and merged-tree gates; lifecycle setup/teardown are not test receipts. Idempotent setup must verify exact ownership before accepting occupied ports.
- Prisma formatting drift survived two worker attempts and cost fresh-worker cycles after functional gates were green. Restore exact known base hunks, inspect pinned diff, and do not rerun whole-file formatting on the shared correction. Preserve security gates without reimplementing already verified behavior.
- Route-group parentheses in Owns are parsed as explanatory notes, while wildcard substitutes conservatively overlap API paths. UI/API serialized rather than overriding ownership safety.

## 2026-10-28 — Route-group Owns

- `?main?` globs pass launch-overlap parsing but completion triage does not match them against `(main)` paths, so an in-scope worker is failed "outside owns". Literal `(main)` is eaten as a note. No Owns spelling works for Next route groups; MAIN verified the diff manually and judged directly.
