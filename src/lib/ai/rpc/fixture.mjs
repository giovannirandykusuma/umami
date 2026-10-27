import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const send = value =>
  process.stdout.write(
    `${JSON.stringify(value.type === 'agent_settled' ? { aborted: false, ...value } : value)}\n`,
  );
const input = createInterface({ input: process.stdin });
let mode;
const propose = args =>
  send({
    type: 'extension_ui_request',
    method: 'input',
    title: 'umami-host-tool',
    id: 'proposal-1',
    placeholder: JSON.stringify({ name: 'propose_board', args }),
  });
const proposal = () => propose({ message: 'A bounded suggestion.' });
input.on('line', line => {
  try {
    const command = JSON.parse(line);
    if (command.type === 'extension_ui_response') {
      if (command.id === 'proposal-1') return;
      if (command.id !== 'read-1' || JSON.parse(command.value)?.ok !== true) process.exit(2);
      proposal();
      send({ type: 'agent_settled' });
      return;
    }
    mode = JSON.parse(command.message.split('\n').slice(1).join('\n')).messages[0].content;
    if (process.env.FIXTURE_RECORD)
      writeFileSync(
        process.env.FIXTURE_RECORD,
        JSON.stringify({ cwd: process.cwd(), env: process.env, pid: process.pid }),
      );
    const ack = () =>
      send({
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: true,
        data: { disposition: mode === 'handled' ? 'handled' : 'started' },
      });
    if (mode === 'wrong-id') {
      send({ type: 'response', id: 'other', command: 'prompt', success: true });
      return;
    }
    if (mode === 'malformed') {
      process.stdout.write('{invalid\n');
      return;
    }
    if (mode === 'exit') {
      process.exit(0);
    }
    if (mode === 'settled-first') {
      proposal();
      send({ type: 'agent_settled' });
      setTimeout(ack, 25);
      return;
    }
    ack();
    if (mode === 'timeout' || mode === 'handled') return;
    if (mode.startsWith('native-')) {
      const end = {
        type: 'tool_execution_end',
        toolCallId: 'native-1',
        toolName: 'analytics_summary',
        result: { content: [{ type: 'text', text: 'data' }] },
        isError: false,
      };
      const variants = {
        'native-denied': { ...end, toolName: 'bash', isError: true },
        'native-failed': { ...end, isError: true },
        'native-unknown-success': { ...end, toolName: 'bash' },
        'native-error-string': { ...end, isError: 'false' },
        'native-error-missing': { ...end, isError: undefined },
        'native-name-malformed': { ...end, toolName: 3 },
        'native-id-malformed': { ...end, toolCallId: {} },
        'native-id-empty': { ...end, toolCallId: '' },
      };
      // Unknown/denied native tools never enter the host extension UI path.
      if (mode === 'native-success' || variants[mode]) send(variants[mode] || end);
      proposal();
      if (mode === 'native-aborted') send({ type: 'agent_settled', aborted: true });
      else if (mode === 'native-aborted-string') send({ type: 'agent_settled', aborted: 'false' });
      else if (mode === 'native-aborted-missing')
        send({ type: 'agent_settled', aborted: undefined });
      else send({ type: 'agent_settled' });
      return;
    }
    if (mode === 'denied' || mode === 'read' || mode === 'large-read' || mode === 'pending') {
      send({
        type: 'extension_ui_request',
        method: 'input',
        title: 'umami-host-tool',
        id: 'read-1',
        placeholder: JSON.stringify({
          name: mode === 'denied' ? 'bash' : 'analytics_summary',
          args: {},
        }),
      });
      if (mode === 'pending') {
        proposal();
        send({ type: 'agent_settled' });
      }
      return;
    }
    if (mode === 'too-many-turns') {
      for (let i = 0; i < 13; i++) send({ type: 'turn_start' });
      return;
    }
    if (mode === 'large') {
      process.stdout.write('x'.repeat(300_000));
      return;
    }
    if (mode === 'bad-draft') {
      propose({ message: 'Draft', draft: { admin: true } });
      send({ type: 'agent_settled' });
      return;
    }
    if (mode === 'empty') {
      send({ type: 'agent_settled' });
      return;
    }
    proposal();
    send({ type: 'agent_end' });
    if (mode === 'end-only') return;
    setTimeout(() => send({ type: 'agent_settled' }), 25);
  } catch {
    process.exit(2);
  }
});
