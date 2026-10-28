# Trusted Umami guidance and evaluation receipts

## Loading and authority

`src/lib/ai/guidance.ts` is a reviewed compiled constant. The server passes its text
through the existing native CLI `--system-prompt` argument in `runtime.ts`. No skill
folder, user-supplied prompt path, resource discovery, or new permission is enabled.
The existing tool authorization, cancellation, model configuration, and authentication
are unchanged. Instructions do not enforce authorization: the host remains the gate.
A preview is not persisted; a human must explicitly Save.

Mechanism: a role-prompt-sized compiled instruction is the least mechanism that
reaches every isolated board turn; a documentation-only line would not reach the
model. Rejected the more powerful skill/resource loader and extension changes:
this is advice, not new capability or an enforcement boundary.

The guidance routes known visits/pages requests directly to supported board
widgets. Unknown events/properties route to bounded metadata discovery before
semantic questions. Names remain untrusted, `login` does not mean successful
authentication, and truncated results do not prove absence. Unsupported username
aggregations require future read/renderer capabilities, not relabelled traffic.
Defaults come only from host context and are explained in the final message.

## Public sources

Reviewed installed public Pi documentation:

- [CLI resources, prompts, and modes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md):
  `--system-prompt` accepts text; `--no-skills`, `--no-extensions`, `--no-mcp`,
  `--no-context-files` isolate resources while explicit extensions still load.
- [Configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md):
  agent/project resources and ambient context-file discovery explain why isolation
  must remain explicit.
- [Public Pi](https://github.com/earendil-works/pi): native CLI/RPC rather than an
  alternate SDK transport. The repository bridge checks pinned Pi 1.4.0.

Local contracts are documented in [ai-discovery.md](ai-discovery.md).

## Offline contract evidence — not behavior evidence

`scripts/ai/evals/cases.mjs` has six invented natural-language scenarios:
standard website board, missing website, ambiguous successful-login semantics,
empty event/property metadata (including missing username), truncated/injection-bearing metadata, and unsupported
login grouping as a refinement of an existing board. Combining grouping and
refinement keeps the planned matrix at 6 × 3 × 2 = 36 trials.

`src/lib/ai/guidance.test.ts` launches actual pinned native Pi with the real
`host-tools.mjs` schemas and an explicitly loaded offline scripted provider.
It validates discovery arguments against the real host validator, structured
clarification output against the host schema, and native `tool_execution_end`
followed by `agent_settled`. It does not fake those native events.

The scripted provider intentionally produces the same actions in both arms.
`offline-results.json` records 18/18 passing contract trials in each arm, zero
invalid arguments, forbidden reads, unnecessary questions, and schema-invalid
widgets. These counts establish protocol compatibility only. They establish
neither prompt-following nor baseline-to-candidate behavioral improvement.
The fixture does not run the production permission sandbox or host analytics
adapter; those remain separate runtime/server tests.

All failures are retained in `offline-initial-failure.json`: 24/36 failed when
the harness omitted the discovery validator's mandatory `now` argument. The
harness was fixed, not the cases. An earlier test import failed before trials
because the worktree dependency alias resolved Vitest's CommonJS entry; the
alias now resolves its ESM entry. Neither failure was a model result.

Run with Node 22.23.4 and installed project dependencies:

```sh
AI_PI_ROOT=<pinned-public-pi-install> \
AI_EVAL_ARTIFACT=scripts/ai/evals/offline-results.json \
pnpm exec vitest run src/lib/ai/guidance.test.ts
```

A separate worktree without dependencies may use `scripts/ai/evals/config.mjs`
with `AI_EVAL_DEPENDENCIES` pointing at an existing project install. This changes
no package manifest or lockfile. Without `AI_PI_ROOT` the native proof is visibly
skipped; the loading assertion still runs.

## Actual-model application gate — measured improvement with two failures

MAIN approved adapting the author gate to application behavior: this is an
application system prompt, not an agent skill selector. Skill-routing on luna
would not test this application's discovery/clarification behavior. The approved
route is exactly `cx/gpt-6.1-sol`, medium reasoning. This adapts applicability,
not the requirement for measured baseline/candidate behavior and fresh review.

`scripts/ai/evals/live.test.ts` executed the entire approved 36-trial matrix
sequentially through actual pinned native Pi and the production permission
arguments, with the actual gateway configuration kept in memory and transient
private scratch. Each trial had a 45-second deadline and eight-tool ceiling;
there were no retries or fallback calls. Inputs contained only invented user
language, selected context/draft, and synthetic tool responses, never rubric or
expected-action flags. Fixtures use the actual discovery response shape,
including separate truncation flags and unavailable coverage.

### Harness configuration correction and fail-fast preflight

`live-results.json` preserves all 36 original error outcomes unchanged and labels
them historical harness endpoint misconfiguration: the launcher passed the gateway
origin without the required `/v1`. This was a harness bug, not evidence of a
provider outage. No behavioral output came from that matrix.

The shared `scripts/ai/gateway-config.mjs` now canonicalizes an origin, `/v1`, or
`/v1/` to exactly one `/v1`. It rejects other paths, query/userinfo, incorrect
model IDs, non-medium reasoning, missing/mismatched keys, and mismatched origins.
It reuses production `gatewayConfig` validation without changing production.
Live eval and release-smoke launchers share the resolver; the latter remain
environment-only and never discover operator configuration. Credential equality
is checked without logging credential values. Synthetic offline transport smoke
retains its deliberately invented model rather than selecting a live route.

MAIN authorized one corrected preflight, then one fresh 36-trial matrix upon
success. `preflight-results.json` records a schema-valid native proposal from the
corrected `/v1` configuration. Matrix execution requires that green preflight,
refuses overwriting evidence, stops on the first systemic failure, and records
the remaining unexecuted count rather than attributing failures to the model.

### Corrected live results

`live-corrected-results.json` retains every corrected trial, including failures.
No systemic error occurred, all 36 proposals passed host schema validation, and
no retry, fallback, or post-result prompt tuning occurred.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Rubric passes / trials | 5/18 | 16/18 |
| Discovery-first semantic trials | 0/12 | 12/12 |
| Invalid arguments | 0 | 0 |
| Forbidden/substitute traffic reads | 0 | 0 |
| Unnecessary questions | 0 | 0 |
| Draft-presence mismatches | 1 | 0 |
| Native assistant completion events | 36 | 48 |
| Input tokens | 92,195 | 182,963 |
| Output tokens | 2,047 | 4,256 |

Candidate failures: `absent-username` runs 1 and 3 did not match the predeclared
capability-honesty wording check. They discovered empty metadata, returned no
draft, and passed semantic clarification, but did not match the regex requiring
an explicit unsupported-capability explanation. Because text was not retained,
these cannot be adjudicated as semantic omission versus wording false negative
from this artifact alone. Preserve them as failures, not presumed passes.
All other candidate cases passed all three repetitions. The baseline's single
draft-presence mismatch is absence of a requested supported draft, not proof of
an invented widget; the historical field name `hallucinatedWidget` is broader
than the observation. Schema-invalid widgets were rejected by host validation.

Reported cost is zero because generated model configuration has no pricing;
it is not proof of zero billing. Native completion counts are not independently
verified HTTP request counts. The runner exits green when the full matrix is
recorded, not when every behavior passes. The strict author-style requirement
that all changed cases pass remains unmet (16/18); independent review must not
silently waive the two retained failures.

The predeclared rubric checks discovery order, semantic questions, unsupported
capability explanations, bounded/unnecessary questions, unsafe value requests,
truncated-absence claims, and draft presence. Host schema validation rejects
invalid arguments/widgets; unsupported traffic reads are counted separately.
Rubric regression tests reject representative unsafe/incorrect responses.
Regex-based semantic checks are limited and require fresh author judge review;
they are not a substitute for a model judge or human semantic inspection.
Those historical matrices did not retain final response text; their semantic
failures cannot be retrospectively resolved.

No analytics database, production image, real values, private endpoint,
credentials, or raw provider output was captured. The live evidence file is
write-once: the runner refuses an existing file rather than silently overwriting
failures. Further inference requires a newly authorized budget. The fresh author
judge must review both actual-model gains and retained candidate failures; neither
offline parity nor a green matrix-runner exit is behavior acceptance. Dependencies
were installed with pnpm 12.3.4 and frozen lockfile, without manifest/lock changes.
Actual affected tests passed (120 tests, five skips); separate gateway and
release-smoke contract tests passed (seven tests).

## Frozen semantic-review follow-up

Independent adjudication found the two historical failures unadjudicable: the
legacy regex conflates metadata absence with unsupported product capability and
cannot reliably verify semantic clarification. It also confirmed that the
existing guidance already states the intended capability requirement. MAIN
therefore authorized at most 37 new sessions: one endpoint preflight followed
only on success by a complete 36-trial matrix, with no retries or selective
reruns. Neither guidance nor fixtures were tuned. Historical 16/18 stays intact.

Before inference, `semantic-rubric.json` froze separate metadata-evidence,
current-capability, clarification, unsupported-fulfillment, privacy/authority,
and supported/missing-website control criteria. Semantic judgment is independent
review, not another keyword score. The historical regex is retained unchanged
and reported separately. Arm order is interleaved and counterbalanced by case
and repetition, rather than all baseline then all candidate.

`followup-results.json` contains prompt, fixture, runner, and rubric SHA-256
hashes plus a nonsecret provider-configuration fingerprint. That fingerprint
covers generic provider/model/reasoning/API compatibility and credential
presence/equality booleans, excluding credentials and private origin. Every
final validated synthetic proposal was screened for credentials, URLs, operator
paths, email-like values, and unexpected UUIDs. Suspicious content would be
withheld and marked an evidence gap; zero records were withheld. No reasoning,
provider diagnostics, environment/config dump, or raw native stream is retained.

### Portable runner provenance

The frozen follow-up receipt identifies the historical runner, not the formatted
working copy. `scripts/ai/evals/provenance/followup-runner.ts.txt` preserves only
that public historical source (18,344 characters, 422 lines); its non-code suffix
keeps automatic TypeScript formatting from altering the evidence. Its SHA-256 is
`511ee99bd978a9fa4e1154b99d45c888a9ec7d4831e0f5a1f4dcd96be06e7c82`,
matching the unchanged `followup-results.json` runnerHash. The current
`live.test.ts` hashes to
`7a6863a987a0d5ff6fe2fe73607c06e31378f35a9d0b1dc65331e2925a4bfc4c`.

`provenance.test.ts` verifies both identities and pipes the historical bytes into
Biome 2.5.13 `format --stdin-file-path=scripts/ai/evals/live.test.ts` using the
repository configuration. Its stdout equals the current runner byte-for-byte,
including line wrapping and regex flag ordering (`ig` to `gi`). This establishes
a deterministic formatter transformation, not the exact process or time of the
original formatting; those remain unknown. No historical hash, frozen arm record,
or blind semantic judgment was replaced, and no inference was rerun for this
repair. Run the offline proof with:

```sh
pnpm exec vitest run --config scripts/ai/evals/config.mjs scripts/ai/evals/provenance.test.ts
```

The preflight passed. All 36 matrix sessions completed without systemic error,
fallback or retries. New legacy-regex results, not semantic adjudications:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Legacy regex passes | 3/18 | 18/18 |
| Discovery-first semantic cases | 0/12 | 12/12 |
| Invalid arguments / forbidden reads | 0 / 0 | 0 / 0 |
| Native assistant completion events | 36 | 48 |
| Input / output tokens | 88,790 / 1,620 | 179,548 / 4,159 |

Pricing remains unavailable; zero reported cost is not zero billing. The budget
counts native sessions, not independently measured HTTP requests or completion
counts. Fixed fixtures and three repeats do not establish generalization.

`followup-blind-review.json` shuffles all 36 finals by opaque review ID, omits arm
and regex grades, and includes fixture context and tool sequence. An independent
reviewer judged every trial against the frozen rubric, cited supporting passages,
and locked all judgments before MAIN unblinded through an exact reviewId join.
Portable `semantic-adjudication.json` preserves those locked per-criterion
judgments, passages and notes with repo-relative sources, plus the separate
post-lock arm mapping. The rubric hash and all 36 joins were verified locally.

| Independent semantic judgment | Baseline | Candidate |
| --- | ---: | ---: |
| PASS | 3 | 18 |
| FAIL | 3 | 0 |
| UNKNOWN | 12 | 0 |

The twelve baseline UNKNOWNs concern unobserved metadata-evidence handling when
no discovery was performed; they are not automatic failures or proof of a global
absence claim. The candidate has no failed or unresolved judgments across all
three repetitions of every fixed case. Semantic counts are independent judgments,
not regex reclassification, and the historical 16/18 remains unchanged and
unadjudicable. One reviewer was used; inter-reviewer agreement was not measured.
These results establish the application behavior gate for these invented cases,
not generalization or production analytics correctness. Fresh code/author review
remains required before merge. No further inference was performed or authorized.
