# Assistant and boards

The board-design AI panel has been retired. Board Design remains the manual layout editor; its existing Save workflow is unchanged.

Use the global **Assistant** entry at `/assistant` for private, persistent conversations about analytics and boards. The browser renders the committed contract in `src/lib/ai/assistant/protocol.ts`; backend behavior is documented in [ai-assistant.md](ai-assistant.md).

Model-generated link parts and markdown links navigate only to same-origin app paths beginning with a single `/` and containing no backslash. External markdown links are rendered as plain text; raw HTML is not rendered.

The Assistant supports streaming markdown, full collapsible thinking, expandable tool arguments/results, inline board components, links, confirmation requests and questions. Enter sends, Shift+Enter inserts a newline, and Stop or Escape cancels the active turn. History supports new conversations, rename, and deletion with confirmation, grouped by local calendar day. Scrolling up pauses automatic following until the reader returns to the bottom.

## Isolated verification

The browser tests fulfill `/api/**` with synthetic fixtures, without a database or model provider:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx --yes pnpm@12.3.4 exec vitest run 'src/app/(main)/assistant'
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3317 PLAYWRIGHT_SKIP_WEB_SERVER=1 \
  npx --yes pnpm@12.3.4 exec playwright test --config=playwright.config.ts tests/e2e/assistant.spec.ts
node scripts/ai/capture-ui.mjs
```

Start the isolated server with `paseo script start ai-ui-fixture`. The capture script uses agent-browser and writes desktop/narrow empty, streaming and completed states, plus a dark desktop completed state and a pending desktop confirmation card, to ignored `shots/assistant-*.png` and `.report.json`. Reports include snapshots, page/console errors, document/conversation overflow, visible conversation height, and full chart visibility measurements. At 1280×800 the message viewport is 596px tall; at 390×844 it is 560px. The composer starts as one line and grows to eight lines. The slim chat header replaces the large page title. Capture reports compare against the approved round-1 PNGs in `/Users/randy/Developer/work/umami/.shikumi/assistant-ui-r1-shots/`, recording the percentage of pixels with an RGB channel difference greater than 16 (Python Pillow required).
