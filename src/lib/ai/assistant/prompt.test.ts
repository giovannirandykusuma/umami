import { describe, expect, it } from 'vitest';
import { assistantPrompt } from './prompt';

describe('assistant chart instructions', () => {
  it('advertises supported comparison metrics and explicit millisecond ranges', () => {
    const prompt = assistantPrompt();
    expect(prompt).toContain("metric:'visitors'|'pageviews'");
    expect(prompt).not.toContain("'visits'");
    expect(prompt).toContain('startAt,endAt');
    expect(prompt).toContain('Unix milliseconds');
    expect(prompt).toContain('global date selection');
  });
});
