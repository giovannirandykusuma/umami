// Explicitly trusted offline TEST provider. Not production discovery or model-quality evidence.
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function (pi) {
  pi.registerProvider('umami-discovery-test', {
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic-not-a-credential',
    api: 'umami-discovery-test-api',
    models: [
      {
        id: 'offline',
        name: 'Offline discovery integration only',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2000,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
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
        try {
          const user = context.messages.find(m => m.role === 'user');
          const text =
            typeof user.content === 'string'
              ? user.content
              : user.content.map(c => c.text || '').join('');
          const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
          const scenario = JSON.parse(payload.messages.at(-1).content);
          process.stderr.write('DISCOVERY_TEST:ready\n');
          const results = context.messages.filter(m => m.role === 'toolResult');
          let name;
          let args;
          if (!results.length) {
            name = 'analytics_discover';
            args = {
              websiteId: scenario.target || payload.context.websiteIds[0],
              startAt: payload.context.startAt,
              endAt: payload.context.endAt,
            };
          } else if (results.length === 1) {
            assert.equal(results[0].toolName, 'analytics_discover');
            assert.equal(results[0].isError, false);
            const data = JSON.parse(results[0].content.map(c => c.text || '').join(''));
            // Exact shape: identifiers, values, samples and unverified coverage cannot leak.
            assert.deepEqual(data, {
              events: [{ name: 'login-unverified', count: '1' }],
              properties: [
                { eventName: 'login-unverified', name: 'account-label', type: 'string' },
              ],
              truncated: { events: false, properties: false },
              coverage: 'unavailable',
            });
            process.stderr.write('DISCOVERY_TEST:metadata-verified\n');
            if (scenario.mode === 'wait') {
              process.stderr.write('DISCOVERY_TEST:waiting\n');
              await new Promise(resolve => {
                if (options.signal.aborted) resolve();
                else options.signal.addEventListener('abort', resolve, { once: true });
              });
              throw new Error('Synthetic cancelled');
            }
            name = 'propose_board';
            args =
              scenario.mode === 'answer'
                ? {
                    message: 'Traffic widgets only; event names do not prove successful logins.',
                    draft: {
                      websiteId: payload.context.websiteIds[0],
                      rows: [
                        {
                          id: 'traffic',
                          columns: [
                            { id: 'chart', component: { type: 'WebsiteChart', props: {} } },
                            {
                              id: 'pages',
                              component: {
                                type: 'MetricsTable',
                                props: { type: 'path', limit: 5 },
                              },
                            },
                          ],
                        },
                      ],
                    },
                  }
                : {
                    message: 'The tracked event alone does not establish login success.',
                    questions: [
                      {
                        id: 'intent',
                        question: 'Do you want supported website traffic instead?',
                        options: [
                          { label: 'Website traffic', value: 'traffic' },
                          { label: 'Explain limits', value: 'limits' },
                        ],
                      },
                    ],
                  };
          }
          stream.push({ type: 'start', partial: message });
          if (name) {
            const block = {
              type: 'toolCall',
              id: `discovery-${results.length}`,
              name,
              arguments: args,
            };
            message.content.push(block);
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: JSON.stringify(args),
              partial: message,
            });
            stream.push({
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall: block,
              partial: message,
            });
            message.stopReason = 'toolUse';
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch {
          process.stderr.write(
            options.signal?.aborted ? 'DISCOVERY_TEST:cancelled\\n' : 'DISCOVERY_TEST:failed\\n',
          );
          message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = 'Synthetic discovery assertion or cancellation';
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
