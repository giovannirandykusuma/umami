# AI board assistant

The existing board **Design** screen (`/boards/:boardId/design`, also used by the edit route) has an AI assistant above the manual layout editor. Ask for a website summary, a breakdown, or daily pageviews, naming the website to use. The initial analytics tools cover summaries, path/title/referrer/hostname breakdowns, and daily pageviews—not arbitrary analytics, per-row filters, or cross-site aggregates.

Responses are plain text. The assistant opts into the documented SSE contract with `Accept: text/event-stream`; preflight JSON errors and successful JSON fallback remain supported. The incremental reader uses fatal UTF-8 decoding, a 256 KiB total stream budget, bounded frames/progress, and strict tagged frames. It waits for clean EOF after exactly one validated result before applying anything: host `complete` progress alone is not success. Malformed/truncated streams, duplicate results, unknown phases, unsafe questions and cancellation leave the local draft unchanged. Both SSE and JSON results pass `validateAiResult` before application.

Only fixed runtime phase labels are shown: starting, checking context, reading authorized analytics, preparing, validating, and waiting for the result. No raw thinking, tool arguments, identifiers or property values appear in progress. Up to three schema-validated questions can have up to six options each. Selecting an option fills the ordinary editable prompt and focuses it; **Ask AI** sends the answer, while **Write my own answer** supports free text. Questions are display data, not permissions or executable actions, and their metadata is not forwarded as chat history. The working-context note derives website selection only from the current board. It explicitly leaves dates and event meanings unconfirmed; the HTTP result does not expose verified selected dates.

A supported response draft replaces only the provider's local `parameters`. Review the preview and use the existing **Save** button to persist it. AI never calls a persistence endpoint. Save is disabled while a request is pending, with a second provider-level guard. Manual board editing remains independent of AI availability.

**Cancel AI** aborts the request and ignores late responses. Manual provider updates cancel pending assistance synchronously. Leaving the design screen clears the bounded chat; refreshing loses chat and unsaved edits, not saved boards. At most 23 recent messages are sent, with prompts limited to 4,000 characters. The actual serialized request (board ID, messages, and draft together) is limited to 32,768 UTF-8 bytes; oldest history is trimmed before sending. If the current prompt and draft alone exceed that limit, no request is made: the assistant asks you to shorten the prompt or simplify the board manually, clears retained history, and preserves your prompt and draft. Ctrl/Cmd+Enter submits; all actions also work through ordinary keyboard focus.

AI is off by default. A 503 response disables chat for the editing session and explains that manual editing and Save remain available. Authentication, website access, unsupported-selection, busy, and upstream failures have visible messages and do not change the draft. No browser provider key or model call is used.

## Supported layouts

The browser uses the same strict draft validator as the server as a UI boundary, not authorization. WebsiteMetricsBar, WebsiteChart, and WorldMap support no widget props; MetricsTable requires a supported type and optionally a 5/10/20 limit; TextBlock accepts text. Pixel/link entities and unsupported manual widgets remain editable manually, with an explanation rather than silent stripping.

A completely blank mixed board omits the optional request `draft` because native manual placeholders (`component: null`) are outside the strict AI draft schema. A populated supported board includes its current draft, and an existing board always includes its ID. **Current limitation:** blank website boards and partially populated manual layouts cannot be sent through the strict incoming draft validator, so the UI disables assistance for them. This requires a server input-contract decision rather than silently replacing manual content.

## Isolated verification

Component tests (no database or provider):

```sh
npx --yes pnpm@12.3.4 exec vitest run 'src/app/(main)/boards/BoardProvider.test.tsx' 'src/app/(main)/boards/[boardId]/BoardAiChat.test.tsx'
```

`tests/e2e/ai-boards.spec.ts` targets the **actual design route and production components**, intercepting browser `/api/**` requests with synthetic session/config/board data and AI HTTP responses. It does not use the repository's database-backed login fixtures. There are no skips or production-auth bypasses. With an isolated, already-running Next server:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3317 PLAYWRIGHT_SKIP_WEB_SERVER=1 \
  npx --yes pnpm@12.3.4 exec playwright test --config=playwright.config.ts tests/e2e/ai-boards.spec.ts
```

Use a synthetic loopback DATABASE_URL for generated Prisma/server initialization, disable telemetry, and leave provider secrets absent. The browser fixtures fulfill HTTP requests; they do not make a real provider or database call. MAIN launched the isolated server through the managed `ai-ui-fixture` Paseo script on port 3317 with loopback port-1 synthetic DATABASE_URL and AI_ENABLED=false. Browser fixtures prove production UI behavior, not the authenticated API/native-runtime integration chain.

**Discovery UI verification:** 37 affected component/parser tests pass using `NODE_OPTIONS=--no-experimental-webstorage /Users/randy/Developer/personal/shikumi/scripts/affected-tests --base HEAD`. They include incremental one-byte UTF-8/CRLF framing, malformed/oversized/truncated streams, one-final enforcement, progress allowlists, unsafe HTML/questions, cancellation, selected-answer serialization, JSON fallback and retained exact request/history byte budgets. All 10 Playwright tests pass against the managed synthetic server: the six prior cases plus structured/free answers, explicit Save, real incremental HTTP progress, midstream cancel, truncated stream, and manual edit cancelling a stale result. The stream fixture is a disposable local Node HTTP server; the browser still uses the actual production fetch and component. No production provider/database was exercised. Node 26 checks use `NODE_OPTIONS=--no-experimental-webstorage`.

**Discovery captures:** run `node scripts/ai/capture-ui.mjs` against the managed synthetic server on 3317 (or set `PLAYWRIGHT_BASE_URL`). With MAIN's explicit capture-script ownership expansion, the script now produces each question and pending-progress state once at desktop 1280×800 and narrow 390×844: `shots/boards-design-{desktop,narrow}-{questions,progress}.{png,report.json,snapshot.txt}`. Agent-browser captures the actual production route; questions use synthetic SSE and pending progress uses a disposable incremental HTTP server. All four reports record zero console/page errors, zero document/conversation horizontal overflow, no assistant-button overlap, and two structured questions. Progress reports contain the fixed “Reading authorized analytics” label. Snapshots record disabled question groups and Save during pending progress. Shots stay local and ignored. The app uses an internal scrolling layout, so a screenshot records the current scrolled viewport rather than expanding that container; the narrow progress shot prioritizes questions, the live phase and Cancel. No actual base-commit synthetic server was supplied: baseline/diff fields are null, with the additive assistant intent and reason recorded rather than a fabricated percentage. Fresh code/visual review is still required.
