import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const dir = args[args.indexOf('--session-dir') + 1];
const session = args.includes('--session')
  ? args[args.indexOf('--session') + 1]
  : join(dir, 'test.jsonl');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'prompt') {
    if (!args.includes('--session')) writeFileSync(session, '{"type":"session","id":"test"}\n');
    appendFileSync(session, JSON.stringify({ type: 'message', text: request.message }) + '\n');
    emit({ type: 'response', id: request.id, command: 'prompt', success: true });
    if (request.message === 'hang') return;
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Thinking' },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello ' },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'world' },
    });
    if (request.message === 'tool') {
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'umami_api',
        args: { method: 'GET', path: '/api/websites' },
      });
      emit({
        type: 'extension_ui_request',
        id: 'bridge-1',
        method: 'input',
        title: 'umami-assistant-tool',
        placeholder: JSON.stringify({
          name: 'umami_api',
          args: { method: 'GET', path: '/api/websites' },
        }),
      });
    } else emit({ type: 'agent_settled' });
  } else if (request.type === 'extension_ui_response') {
    emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'umami_api',
      result: request.value,
      isError: false,
    });
    emit({ type: 'agent_settled' });
  }
});
