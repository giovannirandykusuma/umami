// Explicitly trusted TEST extension. Never discovered or selected by production configuration.
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function (pi) {
  process.stderr.write('LEGACY_TEST:ready\n');
  pi.registerProvider('umami-synthetic', {
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic-not-a-credential',
    api: 'umami-synthetic-api',
    models: [
      {
        id: 'offline',
        name: 'Offline integration only',
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
          assert.ok(['success', 'denied-proposal', 'wait', 'error'].includes(scenario.mode));
          assert.ok(payload.context.websiteIds.every(id => typeof id === 'string'));
          assert.ok(payload.context.endAt <= payload.context.now);
          assert.ok(payload.context.startAt < payload.context.endAt);
          if (scenario.mode === 'wait') {
            process.stderr.write('LEGACY_TEST:waiting\n');
            await new Promise(resolve => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', resolve, { once: true });
            });
            throw new Error('Synthetic cancelled');
          }
          if (scenario.mode === 'error') {
            process.stderr.write('LEGACY_TEST:modelError\n');
            throw new Error('Synthetic model failure');
          }
          const results = context.messages.filter(m => m.role === 'toolResult');
          let name;
          let args;
          if (!results.length) {
            name = 'analytics_summary';
            args = {
              websiteId: scenario.websiteId,
              startAt: payload.context.startAt,
              endAt: payload.context.endAt,
            };
          } else if (results.length === 1) {
            assert.equal(results[0].toolName, 'analytics_summary');
            assert.equal(results[0].isError, false);
            const data = JSON.parse(results[0].content.map(c => c.text || '').join(''));
            assert.equal(data.pageviews, 1);
            process.stderr.write('LEGACY_TEST:read\n');
            name = 'propose_board';
            const draft = payload.draft || {
              rows: [
                {
                  id: 'row',
                  columns: [
                    {
                      id: 'col',
                      component: { type: 'TextBlock', props: { text: 'New baseline' } },
                    },
                  ],
                },
              ],
            };
            if (scenario.mode === 'denied-proposal') draft.websiteId = scenario.deniedId;
            draft.rows[0].columns[0].component.props.text = payload.draft
              ? 'Refined after one pageview'
              : 'One authorized pageview';
            args = {
              message: payload.draft
                ? 'Refined from authorized data.'
                : 'Suggested from authorized data.',
              draft,
            };
          } else {
            message.stopReason = 'stop';
          }
          stream.push({ type: 'start', partial: message });
          if (name) {
            if (name === 'propose_board') process.stderr.write('LEGACY_TEST:proposed\n');
            const block = {
              type: 'toolCall',
              id: `synthetic-${results.length}`,
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
        } catch (error) {
          if (!options.signal?.aborted && error.message !== 'Synthetic model failure')
            process.stderr.write('LEGACY_TEST:failed\n');
          message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = error.message;
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
