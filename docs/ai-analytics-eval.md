# Assistant analytics evaluation

## Status

**Live acceptance item 5 is DEFERRED. Randy has not approved model spend.**
Baseline pass rate: **not run**. Candidate pass rate: **not run**. No live results
are implied by the offline self-test. This lane does not deploy, start engines,
modify the assistant protocol, or use production data.

`node scripts/ai/eval-analytics.mjs` defaults to a local JSON plan: six cases,
expected series, a stable SHA-256 fixture/prompt fingerprint, and null live rates.
It makes no requests. Node built-ins only; no dependency installation is needed.

## Synthetic fixture and six prompts

The oracle follows the seed in
`src/lib/ai/assistant/analytics.integration.test.ts` (spec §5B), not real analytics.
"B fixture" in the evaluation spec means that integration fixture, including both
sites A and B. All ranges are inclusive milliseconds, daily Asia/Jakarta buckets.
The plan prints the exact ranges and expected bucket timestamps.

| Case | Site | Jakarta dates | Metric and selection | Expected buckets | Total |
| --- | --- | --- | --- | --- | --- |
| person-week | A | Jan 1–7, 2026 | Dewi Anggraini (`u_1`), ui.element_clicked events | 1,2,3,0,5,6,7 | 24 |
| person-first-three | A | Jan 1–3 | Same person/event | 1,2,3 | 6 |
| person-empty-day | A | Jan 4 | Same person/event | 0 | 0 |
| other-person | A | Jan 1–7 | Dewi Ayu (`u_2`), login events | 1,0,0,0,0,0,0 | 1 |
| event-only-pageviews | A | Jan 1–7 | Native pageviews; no event substitution | 0,0,0,0,0,0,0 | 0 |
| jakarta-boundary | B | Dec 31, 2025–Jan 1, 2026 | Native pageviews either side of Jakarta midnight | 1,1 | 2 |

Dewi Anggraini has three sessions but is one identified person. Names reside in
session data, not distinct IDs. Login counts are tracked events, not evidence of
successful authentication. Site B events are at the Jan 1 Jakarta boundary minus
and plus one second. The seven-day site-A range starts Jan 1 00:00:00+07:00.

Each live prompt includes the task from the plan, the mapped website ID, exact
range, timezone, daily unit, one result-chart requirement, and a `TOTAL: <number>`
final-answer instruction. Expected totals and `u_1`/`u_2` IDs are **not** given to
the model. Each case gets a fresh chat to avoid history leakage.

Pass requires a completed assistant message, exactly one correct text `TOTAL:`
marker, and exactly one result-chart. The chart must match expected metric, unit,
range, timezone, encoded applied filters, every ordered timestamp/value bucket,
and total; bucket sum must equal total. The chart must use a supported kind,
include a nonempty label, and fit the 8 KiB protocol bound. Legacy widget charts,
wrong filters, empty/malformed series and failed messages do not pass. This is
stricter than merely finding the expected number somewhere in prose. It checks
serialized result-chart parity, not browser rendering or tool provenance.

## Offline acceptance (no provider or HTTP calls)

```sh
node --check scripts/ai/eval-analytics.mjs
node scripts/ai/eval-analytics.mjs --self-test
node scripts/ai/eval-analytics.mjs --plan
git diff --check
```

The self-test grades six locally constructed good messages, then rejects nine
independent mutations: wrong text total, wrong chart total, altered bucket,
missing filters, wrong timezone, null buckets, legacy chart, failed status and
null message. It also rejects an incorrect transcript count. These are validator
checks, not model pass rates. Inputs are cloned so mutations cannot alter the
oracle. No fixture file is committed.

For a saved or scratch transcript:

```sh
node scripts/ai/eval-analytics.mjs --offline /tmp/synthetic-transcript.json
```

Shape: `{ "messages": [ ...six final AssistantMessage objects in plan order... ] }`.
This prints per-case rejection reasons and returns 1 if any case fails. Malformed
outer JSON/counts throw and return nonzero. Use only synthetic transcripts; output
can contain synthetic message content. Offline rates are never labeled live.

## Future approved live replay — do not run without Randy's approval

The evaluator calls the real assistant REST/SSE API, not a provider directly.
That API can spend model credits. Approval is checked **before any fetch**, even
local metadata requests. An arbitrary localhost app is not sufficient isolation:
use a dedicated synthetic app/database and synthetic non-admin session, with no
production credentials, reverse proxy, database replica or production websites.
The script additionally requires `syntheticOnly: true`, a matching fixture hash,
loopback HTTP origin with an explicit port, and both website domains exactly
`synthetic.invalid`. Those checks are safeguards, not database ownership proof.

1. Obtain separate model-spend approval. Do not set the approval variable now.
2. Follow `docs/ai-discovery-integration.md` for receipt-checked synthetic engines
   (analytics uses schema `analytics_integration`, not `discovery_integration`).
   Never stop shared engines or substitute a production connection.
3. Provision a **persistent isolated copy** of the §5B seed above and a signed
   non-admin owner session. The integration test removes its randomly generated
   rows during cleanup, so simply running that test does not leave usable site
   IDs. This harness intentionally does not create database rows or credentials.
   Record a seed receipt (seed/version, owner marker verification and row-count
   checks), and preserve that same seeded dataset for both app revisions.
4. Build/run baseline master and candidate against that copy, serially. Pin each
   full revision SHA, the exact provider/model/version, generation settings and
   runtime configuration. Configure the model in the application, not this script.
   `model` and `revision` in config are operator attestations, not API-discovered
   values. Record any provider nondeterminism; six cases are not statistical proof.
5. Create a private config outside the repository, with no provider key:

```json
{
  "syntheticOnly": true,
  "fixtureHash": "copy fixtureHash from --plan",
  "origin": "http://127.0.0.1:3318",
  "sites": { "A": "seeded-site-A-UUID", "B": "seeded-site-B-UUID" },
  "model": "exact-provider/model-version-and-settings",
  "revision": "full-baseline-or-candidate-SHA",
  "seedReceipt": "same-verified-synthetic-seed-receipt-for-both-runs"
}
```

Only **after approval**, the commands are:

```sh
# Inject the synthetic owner's session token privately; never use a production token.
export AI_ANALYTICS_SYNTHETIC_TOKEN='<synthetic-session-token>'
export AI_ANALYTICS_APPROVE_SPEND='Randy-approved-synthetic-only'
node scripts/ai/eval-analytics.mjs --live /private/baseline-config.json baseline /private/baseline.json
node scripts/ai/eval-analytics.mjs --live /private/candidate-config.json candidate /private/candidate.json
unset AI_ANALYTICS_APPROVE_SPEND AI_ANALYTICS_SYNTHETIC_TOKEN
node scripts/ai/eval-analytics.mjs --compare /private/baseline.json /private/candidate.json
```

The runs create six chats each and delete each chat in `finally`; they do not
answer confirmations or clarification questions. Operational failures stop the
run instead of inventing missing scores. A completed evaluation exits 0 even for
model-quality failures (informational gate). Reports include terminal transcripts,
per-case results, rates, revision/model/seed receipt and fixture hash. Output files
are private (0600) and refuse overwrite. Do not commit reports or credentials.
Comparison regrades saved transcripts and refuses different model settings,
fixture hashes or seed receipts. MAIN records real baseline/candidate rates and
revisions in `wiki/log.md` only after approved runs. Until then both are **not run**.

The live orchestration has not been exercised here. Offline validation does not
prove live model behavior, deployed isolation, engine parity or UI rendering.
