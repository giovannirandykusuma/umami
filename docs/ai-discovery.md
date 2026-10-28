# AI discovery and HTTP streaming

The existing `POST /api/ai/boards/chat` remains JSON by default, including its existing
status/error behavior. A client may opt into SSE with `Accept: text/event-stream`.
Authentication (session user only), body byte/schema limits, draft validation and
initial reference authorization run before stream headers. Preflight failures are
still JSON with their normal status. Responses are not cached.

## Dialogue admission

Admission is process-local staging protection, not a durable or distributed quota.
An authenticated user may have only one in-flight turn, with at most two turns
across the process. The in-flight guard is released once on JSON completion or
failure, SSE terminal delivery, disconnect/cancel, or host deadline. A stream
waiting for terminal delivery under backpressure still holds admission; no database
transaction is held during that wait.

Separately, each user may start six admitted turns per sliding 60-second window.
This fixed burst allows immediate clarification answers after a completed response
without allowing unlimited retries. A seventh turn or overlapping turn receives
only the generic JSON 429 busy response before stream headers. Unauthenticated or
admission-denied requests do not consume a turn; once admitted, malformed bodies,
scope denials and provider failures do consume one. Rejected attempts do not extend
the window. The timestamp map holds at most 1,000 users with at most six timestamps
each; expired timestamps/users are pruned on admission. At capacity, existing users
can still use their remaining burst, while new users wait for expiry. No prompts,
credentials, analytics or user IDs are logged for admission, and no database
migration or persistent per-user limit is introduced.

## Discovery

`analytics_discover` accepts **only** `{ websiteId, startAt, endAt }`, with Unix
milliseconds. Dates must be ordered, nonnegative, not future, at most 31 days,
and within the host's selected context. The site must belong to that selected
context. The host rechecks site existence and user-only authorization before and
after SQL, before final output, and again when a backpressured stream can deliver.
Administrative permission never bypasses existence checks. Tool/read admission,
turn timeout, cancellation and the existing scoped database budgets also apply.

Output shape:

```json
{
  "events": [{ "name": "synthetic-login", "count": "123" }],
  "properties": [{ "eventName": "synthetic-login", "name": "method", "type": "string" }],
  "truncated": { "events": false, "properties": false },
  "coverage": "unavailable"
}
```

Counts are decimal strings (including UInt64 counts) to avoid rounding. Limits are
50 event names and 100 event/property/type combinations, each name at most 500
UTF-8 bytes, and the existing 32 KiB tool response bound. SQL fetches one additional
aggregate row to detect truncation; truncation is not proof of absence. Unsupported
or invalid metadata fails closed. Types are string, number, boolean, date, array,
or unknown. Coverage denominators are not verified consistently across engines,
so coverage is explicitly unavailable rather than fabricated.

The AI-only adapter uses parameterized PostgreSQL and ClickHouse queries through
the existing scoped raw-query primitives, never the event-data helpers that also
fetch property values. It requires an active AI read scope, has explicit unsupported
engine failure, and does not change global database settings. PostgreSQL uses the
existing read-only scoped transaction and statement timeout; ClickHouse uses the
existing scope abort signal and server execution timeout. No values, samples, raw
records, session IDs or user IDs are selected. Names themselves may contain PII or
prompt injection: they remain private, untrusted metadata, never instructions or
log fields. No production metadata was used in the synthetic tests.

Discovery is evidence, not semantic authority. A name resembling “login” does not
prove successful authentication. Missing/ambiguous metadata should lead to a useful
clarification question, not inferred login semantics or an unsupported renderer.
There is no additional persistence or database migration.

## SSE frames

Each frame is UTF-8, `event: progress|result|error`, followed by a single JSON `data:`
line and a blank line. JSON data uses the shared tagged event contract:

```text
event: progress
data: {"type":"progress","phase":"read"}

event: result
data: {"type":"result","result":{"message":"Which event means successful login?","questions":[{"id":"login","question":"Which event should be used?"}]}}

```

Only fixed runtime progress phases `start`, `check`, `read`, `prepare`, `validate`
are forwarded (at most 20). Tool names, arguments, IDs, prompts, data and runtime
errors are never progress fields. Runtime terminal events are ignored. The host
emits `complete` only after strict shared final validation and final authorization,
then exactly one result; failures produce one generic safe error instead. A
connection abort/cancel closes without further writes. A host deadline instead sends
one bounded generic terminal error to a still-connected reader, including when
progress has filled the queue, then closes. Questions and drafts use
shared strict validation, including prototype/accessor rejection and byte limits.

Progress is dropped when the one-frame queue has no demand. Final delivery waits
for demand and rechecks authorization. The complete/result pair is bounded by
32 KiB plus framing; total stream bytes are bounded by 256 KiB. Disconnection via
both `Request.signal` and stream cancellation aborts the runtime and query scope.
No database transaction is held while waiting on a stream reader. A slow consumer
is ultimately closed by the turn deadline. JSON clients receive the same validated
result shape, with optional `questions` now supported.

## Offline evidence

`pnpm exec vitest run src/lib/ai/server.test.ts src/lib/ai/discovery.test.ts`
exercises scoped host permissions (including real website permission logic with
synthetic ownership/team membership), revocation, existence, metadata allowlists,
parameterization, bounds, truncation, exact large counts, SSE sequence, malformed
questions, cancellation, oversized output, progress floods and JSON compatibility.
Opt-in real-engine acceptance uses the disposable local fixture pair from
`scripts/ai/synthetic-engines/setup.sh` (ports 25432 and 28123), not production:

```sh
AI_DISCOVERY_ENGINES=1 npx --yes pnpm@12.3.4 exec vitest run src/lib/ai/discovery.test.ts
```

It creates isolated timestamp-named synthetic schemas, executes the actual discovery
adapter through real read scopes against PostgreSQL and ClickHouse, and verifies
aggregate names/types/counts without property values in output. Fixture schemas are
retained for review; teardown belongs to the owned synthetic-engine script after
review. The server tests also exercise the real 45-second host deadline with both
a reading consumer and a backpressured consumer, plus admission release.
