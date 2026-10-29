import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAnalystEnabled, isAnalystVerifierEnabled } from './flags';

afterEach(() => vi.unstubAllEnvs());

describe('analyst feature opt-ins', () => {
  it.each([undefined, '', 'false', '0', '1', 'TRUE', ' true', 'true '])(
    'keeps features disabled for %s',
    value => {
      vi.stubEnv('AI_ANALYST_ENABLED', value);
      vi.stubEnv('AI_ANALYST_VERIFIER_ENABLED', value);
      expect(isAnalystEnabled()).toBe(false);
      expect(isAnalystVerifierEnabled()).toBe(false);
    },
  );

  it('requires independent explicit opt-ins', () => {
    vi.stubEnv('AI_ANALYST_ENABLED', 'true');
    vi.stubEnv('AI_ANALYST_VERIFIER_ENABLED', 'false');
    expect(isAnalystEnabled()).toBe(true);
    expect(isAnalystVerifierEnabled()).toBe(false);
    vi.stubEnv('AI_ANALYST_ENABLED', 'false');
    vi.stubEnv('AI_ANALYST_VERIFIER_ENABLED', 'true');
    expect(isAnalystEnabled()).toBe(false);
    expect(isAnalystVerifierEnabled()).toBe(true);
  });
});
