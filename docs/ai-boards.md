# AI board assistant

The existing board **Design** screen (`/boards/:boardId/design`, also used by the edit route) has an AI assistant above the manual layout editor. Ask for a website summary, a breakdown, or daily pageviews, naming the website to use. The initial analytics tools cover summaries, path/title/referrer/hostname breakdowns, and daily pageviews—not arbitrary analytics, per-row filters, or cross-site aggregates.

Responses are plain text. A supported response draft replaces only the provider's local `parameters`. Review the preview and use the existing **Save** button to persist it. AI never calls a persistence endpoint. Save is disabled while a request is pending, with a second provider-level guard. Manual board editing remains independent of AI availability.

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

**Verification status:** 16 component tests pass (including six-turn ASCII/multibyte history and exact 32,768/32,769-byte boundaries); the affected-test selection passes 21 files / 174 tests with `NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run --changed HEAD~1` (Node 26's experimental global storage otherwise breaks unrelated existing tests). All 6 Playwright tests pass against the managed synthetic server, including ordinary Add board creation and existing-board refinement. Desktop 1280×800 and narrow 390×844 screenshots, snapshots, and reports are in `shots/boards-design-{desktop,narrow}.*`. Both reports record zero console/page errors, zero horizontal overflow and zero assistant-button overlap. Reproduce with `node scripts/ai/capture-ui.mjs` against the same server. No base-commit capture server was supplied; reports explicitly mark baseline percentage unavailable instead of inventing a baseline. Captures cover the shared design component once per requested viewport, not a separate duplicate edit-route capture.
