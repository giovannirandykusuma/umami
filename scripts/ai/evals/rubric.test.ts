import { expect, it } from 'vitest';
import { grade, screenedProposal } from './live.test';
import { cases } from './cases.mjs';

it('retains only synthetic finals and withholds private configuration or unexpected identifiers', () => {
  const env = {
    AI_BASE_URL: 'https://private.invalid/v1',
    AI_PROVIDER_KEY: 'invented-private-key',
  };
  expect(
    screenedProposal({ message: 'The current renderer cannot aggregate usernames.' }, env)
      .evidenceGap,
  ).toBe(null);
  for (const message of [
    'invented-private-key',
    'https://private.invalid',
    '/Users/operator/config',
    '22222222-2222-4222-8222-222222222222',
  ])
    expect(screenedProposal({ message }, env).final).toBe(null);
});

it('rejects premature questions, unsupported drafts, traffic substitution and unsafe samples', () => {
  const login = cases.find(c => c.id === 'ambiguous-login');
  expect(
    grade(login, { message: 'Which event?', questions: [{ question: 'Which event?' }] }, [
      'propose_board',
    ]).pass,
  ).toBe(false);
  expect(
    grade(login, { message: 'Here are logins.', draft: {} }, ['analytics_summary', 'propose_board'])
      .pass,
  ).toBe(false);
  expect(
    grade(
      login,
      {
        message: 'Cannot support this. Please provide actual usernames?',
        questions: [{ question: 'Which event?' }],
      },
      ['analytics_discover', 'propose_board'],
    ).pass,
  ).toBe(false);
  expect(
    grade(
      login,
      {
        message: 'The renderer cannot support username grouping.',
        questions: [{ question: 'Which event means successful authentication?' }],
      },
      ['analytics_discover', 'propose_board'],
    ).pass,
  ).toBe(true);
});

it('does not accept absence claims from truncated metadata or interview a known website board', () => {
  const truncated = cases.find(c => c.id === 'truncated-metadata');
  expect(
    grade(
      truncated,
      { message: 'Cannot support this. The username property does not exist. Which event?' },
      ['analytics_discover', 'propose_board'],
    ).pass,
  ).toBe(false);
  const supported = cases.find(c => c.id === 'supported-board');
  expect(
    grade(
      supported,
      { message: 'Which event?', draft: {}, questions: [{ question: 'Which event?' }] },
      ['propose_board'],
    ).pass,
  ).toBe(false);
});
