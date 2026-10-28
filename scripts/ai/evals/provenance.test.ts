import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const historicalHash = '511ee99bd978a9fa4e1154b99d45c888a9ec7d4831e0f5a1f4dcd96be06e7c82';
const formattedHash = '7a6863a987a0d5ff6fe2fe73607c06e31378f35a9d0b1dc65331e2925a4bfc4c';
const historical = readFileSync('scripts/ai/evals/provenance/followup-runner.ts.txt');
const current = readFileSync('scripts/ai/evals/live.test.ts');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('frozen follow-up runner provenance (offline)', () => {
  it('preserves the exact source identified by the frozen receipt', () => {
    const receipt = JSON.parse(readFileSync('scripts/ai/evals/followup-results.json', 'utf8'));
    expect(receipt.runnerHash).toBe(historicalHash);
    expect(sha256(historical)).toBe(historicalHash);
    expect(historical.toString().length).toBe(18344);
    expect(historical.toString().trimEnd().split('\n')).toHaveLength(422);
    expect(sha256(current)).toBe(formattedHash);
  });

  it('reproduces the current runner byte-for-byte with the pinned formatter', () => {
    const require = createRequire(resolve(process.env.AI_EVAL_DEPENDENCIES || '.', 'package.json'));
    expect(require('@biomejs/biome/package.json').version).toBe('2.5.13');
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('@biomejs/biome/bin/biome'),
        'format',
        '--stdin-file-path=scripts/ai/evals/live.test.ts',
      ],
      { input: historical, maxBuffer: 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stdout.equals(current)).toBe(true);
    expect(sha256(result.stdout)).toBe(formattedHash);
  });
});
