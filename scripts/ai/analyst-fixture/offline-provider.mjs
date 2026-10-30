// SYNTHETIC FIXTURE ONLY. Deterministic offline model for the analyst fixture app: a scripted
// create -> readback -> repair -> verify turn that drives the real native Pi tool/stream path.
// It performs no network I/O and has no live-provider fallback. runtime.ts loads it only after
// positively verifying the synthetic fixture context (see offlineFixtureRuntime).
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export const OFFLINE_PROVIDER = 'umami-offline-fixture';
export const OFFLINE_MODEL = 'analyst-script-v1';
export const OFFLINE_BASE_URL = 'https://offline-fixture.invalid';
export const FIXTURE_WEBSITE = 'a11a1a00-0000-4000-8000-000000000001';

const definition = metric => ({
  schemaVersion: 1,
  source: { websiteId: FIXTURE_WEBSITE },
  operation: 'totals',
  metric: 'pageviews',
  datePolicy: { type: 'fixed', startAt: Date.UTC(2026, 9, 1), endAt: Date.UTC(2026, 9, 15) },
  timezone: 'UTC',
  semanticBinding: {
    label: metric,
    unit: 'pageviews',
    population: 'all synthetic visitors',
    meaningSource: 'observed_only',
  },
});
const bundle = (label, boardId, expectedRevision) => ({
  ...(boardId ? { boardId, expectedRevision } : {}),
  board: {
    type: 'mixed',
    name: 'Offline fixture board',
    parameters: {
      rows: [
        {
          id: 'r1',
          columns: [
            {
              id: 'w1',
              component: {
                type: 'AnalysisWidget',
                props: { analysisRef: 'a1', visualization: 'table' },
              },
            },
          ],
        },
      ],
    },
  },
  analyses: [{ ref: 'a1', name: 'Fixture pageviews', definition: definition(label) }],
});

const parse = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Next scripted step from the transcript's tool results (pure, exported for tests). */
export function nextStep(messages) {
  const results = messages.filter(m => m.role === 'toolResult');
  const last = results.at(-1);
  const json = last ? parse(last.content?.find(c => c.type === 'text')?.text ?? '') : null;
  const committed = results
    .filter(r => r.toolName === 'analyst_commit_draft')
    .map(r => parse(r.content?.find(c => c.type === 'text')?.text ?? ''))
    .filter(r => r?.ok);
  const board = committed.at(-1)?.board;
  switch (results.length) {
    case 0:
      return { tool: 'analyst_discover', args: { websiteId: FIXTURE_WEBSITE } };
    case 1:
      return {
        tool: 'analyst_commit_draft',
        args: { ...bundle('Synthetic pageviews'), operationKey: 'offline-create' },
      };
    case 2:
      if (!board) return { text: `Create failed: ${json?.code ?? 'unknown'}` };
      return { tool: 'analyst_readback', args: { boardId: board.id } };
    case 3:
      return {
        tool: 'analyst_commit_draft',
        args: {
          ...bundle('Synthetic pageviews (repaired label)', board.id, board.revision),
          operationKey: 'offline-repair',
          repair: { widgetId: 'w1', reason: 'Clarify label' },
        },
      };
    case 4:
      if (!board || committed.length < 2)
        return { text: `Repair failed: ${json?.code ?? 'unknown'}` };
      return { tool: 'analyst_verify_render', args: { boardId: board.id } };
    default:
      return {
        text: `Offline fixture turn complete; render status: ${
          json?.ok === false ? (json.visualStatus ?? json.code) : 'rendered_not_inspected'
        }`,
      };
  }
}

function stream(model, context, options) {
  const out = createAssistantMessageEventStream();
  const message = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      const aborted = { ...message, stopReason: 'aborted', errorMessage: 'aborted' };
      out.push({ type: 'error', reason: 'aborted', error: aborted });
      return out.end(aborted);
    }
    const step = nextStep(context.messages ?? []);
    out.push({ type: 'start', partial: { ...message } });
    if (step.tool) {
      const call = {
        type: 'toolCall',
        id: `offline-${(context.messages ?? []).length}`,
        name: step.tool,
        arguments: step.args,
      };
      message.content = [call];
      message.stopReason = 'toolUse';
      out.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message } });
      out.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: { ...message } });
    } else {
      message.content = [{ type: 'text', text: step.text }];
      out.push({ type: 'text_start', contentIndex: 0, partial: { ...message } });
      out.push({ type: 'text_delta', contentIndex: 0, delta: step.text, partial: { ...message } });
      out.push({ type: 'text_end', contentIndex: 0, content: step.text, partial: { ...message } });
    }
    out.push({ type: 'done', reason: message.stopReason, message });
    out.end(message);
  });
  return out;
}

export default function (pi) {
  pi.registerProvider(OFFLINE_PROVIDER, {
    name: 'Umami offline analyst fixture',
    baseUrl: OFFLINE_BASE_URL,
    apiKey: 'offline-fixture-no-credential',
    api: 'umami-offline-fixture',
    streamSimple: stream,
    models: [
      {
        id: OFFLINE_MODEL,
        name: 'Offline analyst script',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
