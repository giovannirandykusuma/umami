// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UMAMI_GUIDANCE } from './guidance';
import { validateAiResult, validateAnalyticsDiscoverArgs } from './rpc/contract';
import { cases } from '../../../scripts/ai/evals/cases.mjs';

const baseline = readFileSync('scripts/ai/guidance/baseline.txt', 'utf8');

describe('trusted guidance loading', () => {
  it('replaces only the reviewed system-prompt text, not resource flags or permission policy', () => {
    const source = readFileSync('src/lib/ai/runtime.ts', 'utf8');
    expect(source).toContain("import { UMAMI_GUIDANCE } from './guidance'");
    expect(source).toContain("'--system-prompt',\n      UMAMI_GUIDANCE");
    for (const flag of ['--no-skills', '--no-mcp', '--no-context-files', '--no-builtin-tools'])
      expect(source).toContain(flag);
    expect(UMAMI_GUIDANCE).toContain('Truncated metadata is not proof of absence');
    expect(UMAMI_GUIDANCE).toContain('human must explicitly Save');
  });
});

// Real pinned native RPC + real trusted host-tools extension + scripted offline provider.
// These tests verify contracts/events, not whether a reasoning model follows the guidance.
async function nativeTrial(scenario: any, prompt: string) {
  const root = process.env.AI_PI_ROOT;
  if (!root) throw new Error('AI_PI_ROOT required for native contract proof');
  const home = await mkdtemp(join(tmpdir(), 'umami-guidance-eval-'));
  await mkdir(join(home, 'agent'));
  const child = spawn(
    process.execPath,
    [
      resolve('scripts/ai/native.mjs'),
      '--mode',
      'rpc',
      '--offline',
      '--no-session',
      '--no-approve',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-builtin-tools',
      '--extension',
      resolve('scripts/ai/host-tools.mjs'),
      '--extension',
      resolve('scripts/ai/evals/provider.mjs'),
      '--provider',
      'umami-guidance-fixture',
      '--model',
      'offline',
      '--thinking',
      'off',
      '--system-prompt',
      prompt,
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        NODE_ENV: 'test',
        PI_CODING_AGENT_DIR: join(home, 'agent'),
        AI_PI_ROOT: root,
        AI_PROVIDER: 'umami-guidance-fixture',
        AI_MODEL: 'offline',
        AI_BASE_URL: 'https://synthetic.invalid',
        AI_EGRESS_ORIGINS: 'https://synthetic.invalid',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  const sequence: string[] = [];
  const nativeEvents: string[] = [];
  let proposal: any;
  let buffer = '';
  let invalidArgs = 0;
  let forbiddenReads = 0;
  child.stderr.resume(); // Never retain provider diagnostics or private configuration.
  try {
    await new Promise<void>((resolveDone, reject) => {
      const timer = setTimeout(() => reject(new Error('Native trial deadline')), 15000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('close', () => fail(new Error('Native trial exited before settling')));
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'tool_execution_end') {
              if (event.isError) throw new Error('Native tool failed');
              nativeEvents.push(event.toolName);
            }
            if (event.type === 'extension_ui_request' && event.title === 'umami-host-tool') {
              const { name, args } = JSON.parse(event.placeholder);
              sequence.push(name);
              let response: any;
              try {
                if (name === 'analytics_discover') {
                  validateAnalyticsDiscoverArgs(args, Date.now());
                  expect(args).toEqual({
                    websiteId: scenario.context.websiteIds[0],
                    startAt: scenario.context.startAt,
                    endAt: scenario.context.endAt,
                  });
                  response = scenario.metadata;
                } else if (name === 'propose_board') {
                  proposal = validateAiResult(args);
                  response = { ok: true };
                } else {
                  forbiddenReads++;
                  throw new Error('Unexpected tool');
                }
              } catch (error) {
                invalidArgs++;
                throw error;
              }
              child.stdin.write(
                JSON.stringify({
                  type: 'extension_ui_response',
                  id: event.id,
                  value: JSON.stringify(response),
                }) + '\n',
              );
            }
            if (event.type === 'response' && event.success === false)
              throw new Error('Native prompt rejected');
            if (event.type === 'agent_settled') {
              if (event.aborted || !proposal) throw new Error('No completed proposal');
              clearTimeout(timer);
              resolveDone();
            }
          } catch (error) {
            fail(error as Error);
          }
        }
      });
      child.stdin.write(
        JSON.stringify({ type: 'prompt', id: 'trial', message: JSON.stringify(scenario) }) + '\n',
      );
    });
    expect(sequence).toEqual(
      scenario.discovery ? ['analytics_discover', 'propose_board'] : ['propose_board'],
    );
    expect(nativeEvents).toEqual(sequence);
    expect(Boolean(proposal.draft)).toBe(scenario.draft);
    expect(Boolean(proposal.questions)).toBe(scenario.questions);
    return {
      sequence,
      nativeEvents,
      questionCount: proposal.questions?.length || 0,
      invalidArgs,
      forbiddenReads,
      unnecessaryQuestions: scenario.questions ? 0 : proposal.questions?.length || 0,
      hallucinatedWidget: 0,
      pass: true,
    };
  } finally {
    child.kill('SIGKILL');
    await closed;
    await rm(home, { recursive: true, force: true });
  }
}

it.skipIf(!process.env.AI_PI_ROOT)(
  'repeats six natural-language scenarios in both arms through native events (scripted model only)',
  async () => {
    const trials: any[] = [];
    for (const [arm, prompt] of [
      ['baseline', baseline],
      ['candidate', UMAMI_GUIDANCE],
    ]) {
      for (let run = 1; run <= 3; run++)
        for (const scenario of cases) {
          try {
            trials.push({
              arm,
              run,
              scenario: scenario.id,
              ...(await nativeTrial(scenario, prompt)),
            });
          } catch {
            trials.push({
              arm,
              run,
              scenario: scenario.id,
              pass: false,
              failure: 'native-contract-failure',
            });
          }
        }
    }
    const artifact = {
      model: 'scripted-offline-provider',
      kind: 'native-contract-only',
      behaviorEvidence: false,
      liveTrialsExecuted: 0,
      trials,
    };
    if (process.env.AI_EVAL_ARTIFACT)
      await writeFile(process.env.AI_EVAL_ARTIFACT, JSON.stringify(artifact, null, 2) + '\n');
    expect(trials.filter(trial => !trial.pass)).toEqual([]);
  },
  120000,
);
