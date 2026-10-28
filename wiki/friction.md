# Workflow friction

## 2026-10-27 — AI boards API review orchestration

- Replayed command receipts must not depend on lane-only scratch environment variables; use portable node subprocess diagnostic capture.
- Engine fixture teardown before independent review destroyed reproducibility. Keep explicitly owned disposable services available through judge and merged-tree gates; lifecycle setup/teardown are not test receipts. Idempotent setup must verify exact ownership before accepting occupied ports.
- Prisma formatting drift survived two worker attempts and cost fresh-worker cycles after functional gates were green. Restore exact known base hunks, inspect pinned diff, and do not rerun whole-file formatting on the shared correction. Preserve security gates without reimplementing already verified behavior.
- Route-group parentheses in Owns are parsed as explanatory notes, while wildcard substitutes conservatively overlap API paths. UI/API serialized rather than overriding ownership safety.

## 2026-10-28 — Route-group Owns

- `?main?` globs pass launch-overlap parsing but completion triage does not match them against `(main)` paths, so an in-scope worker is failed "outside owns". Literal `(main)` is eaten as a note. No Owns spelling works for Next route groups; MAIN verified the diff manually and judged directly.

## 2026-10-28 — Never clean up a rejected lane before its diff is safely exported

- Ran patch export and shikumi_lane_cleanup(force) in the same parallel batch; export failed (shots ignored by git add) and cleanup deleted the only copy of uncommitted worker output. Recovered from the Pi session log by replaying edits — lossy. Rule: export, verify file size, THEN cleanup, sequentially; or commit in the worktree first.

## 2026-10-28 — Merge gate friction (assistant-ui-r2)

- VERDICT_DIRS is colon-separated; a code+ui judge pair cannot both be bound (activeReview is single), so MAIN rebinds activeReview by hand.
- A failed gate after the lane-side commit leaves the worktree committed; retry fails with empty scope until MAIN soft-resets it.
- New lane deps are not installed in MAIN node_modules before the merged-tree tests: install from the lane lockfile first.
- Full affected run under machine load ~22 times out child-process tests; use VITEST_MAX_WORKERS=4.
