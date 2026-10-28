// Explicit offline protocol fixture, NOT a reasoning/behavior model or production resource.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function (pi) {
  pi.registerProvider('umami-guidance-fixture', {
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'not-a-credential',
    api: 'guidance-fixture',
    models: [
      {
        id: 'offline',
        name: 'Scripted protocol fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2000,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          content: [],
          stopReason: 'stop',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const user = context.messages.find(m => m.role === 'user');
        const text =
          typeof user.content === 'string'
            ? user.content
            : user.content.map(c => c.text || '').join('');
        const scenario = JSON.parse(text);
        const results = context.messages.filter(m => m.role === 'toolResult');
        let call;
        if (scenario.discovery && !results.length) {
          call = {
            name: 'analytics_discover',
            arguments: {
              websiteId: scenario.context.websiteIds[0],
              startAt: scenario.context.startAt,
              endAt: scenario.context.endAt,
            },
          };
        } else if (!results.some(m => m.toolName === 'propose_board')) {
          call = {
            name: 'propose_board',
            arguments: scenario.discovery
              ? {
                  message:
                    'The current renderer cannot group successful logins by username. Metadata names do not establish success; truncated metadata does not prove absence.',
                  questions: [
                    {
                      id: 'meaning',
                      question: 'Which tracked event represents successful authentication?',
                    },
                  ],
                }
              : scenario.context.websiteIds.length
                ? {
                    message:
                      'Selected website and date range from host context. Preview only; explicitly Save to persist.',
                    draft: {
                      websiteId: scenario.context.websiteIds[0],
                      rows: [
                        {
                          id: 'row',
                          columns: [
                            { id: 'visits', component: { type: 'WebsiteChart' } },
                            {
                              id: 'pages',
                              component: { type: 'MetricsTable', props: { type: 'path' } },
                            },
                          ],
                        },
                      ],
                    },
                  }
                : { message: 'Select a website first.' },
          };
        }
        stream.push({ type: 'start', partial: message });
        if (call) {
          const block = { type: 'toolCall', id: `fixture-${results.length}`, ...call };
          message.content.push(block);
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({
            type: 'toolcall_delta',
            contentIndex: 0,
            delta: JSON.stringify(call.arguments),
            partial: message,
          });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
          message.stopReason = 'toolUse';
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
