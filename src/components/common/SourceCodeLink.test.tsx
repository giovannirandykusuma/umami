import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { validateSourceUrl } from '../../../next.config';
import { getSourceCodeUrl, SourceCodeLink } from './SourceCodeLink';

const releaseUrl = 'https://github.com/giovannirandykusuma/umami/tree/source-release-20261028';

test('ships MIT grants, UAParser attribution and the complete AGPL notice', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  expect(read('LICENSE')).toContain('Permission is hereby granted, free of charge');
  expect(read('LICENSE')).toContain('Copyright (c) 2022 Umami Software, Inc.');
  const notice = read('NOTICE.md');
  expect(notice).toContain('Copyright © 2012-2026 Faisal Salman');
  expect(notice).toContain('not an MIT-only distribution');
  expect(notice).toContain('LICENSES/AGPL-3.0-only.txt');
  const license = read('LICENSES/AGPL-3.0-only.txt');
  expect(license).toContain('5. Conveying Modified Source Versions.');
  expect(license).toContain('6. Conveying Non-Source Forms.');
  expect(license).toContain(
    '13. Remote Network Interaction; Use with the GNU General Public License.',
  );
  expect(read('LICENSES/ua-parser-js-LICENSE.md')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

test('offers a visible, keyboard-accessible source link to the configured public release', async () => {
  vi.stubEnv('NEXT_PUBLIC_SOURCE_URL', releaseUrl);
  render(<SourceCodeLink />);
  const link = screen.getByRole('link', { name: 'Source code' });
  expect(link).toBeVisible();
  expect(link).toHaveAttribute('href', releaseUrl);
  await userEvent.setup().tab();
  expect(link).toHaveFocus();
});

test('accepts an exact commit or reviewed release tag without hardcoding a stale deployed revision', () => {
  expect(() => validateSourceUrl(releaseUrl, true)).not.toThrow();
  const url = `https://github.com/giovannirandykusuma/umami/tree/${'a'.repeat(40)}`;
  expect(() => validateSourceUrl(url, true)).not.toThrow();
  expect(getSourceCodeUrl(url)).toBe(url);
});

test('labels development fallback and rejects missing production binding at config load', () => {
  vi.stubEnv('NEXT_PUBLIC_SOURCE_URL', '');
  expect(getSourceCodeUrl()).toBe('https://github.com/giovannirandykusuma/umami');
  expect(() => validateSourceUrl(undefined, false)).not.toThrow();
  expect(() => validateSourceUrl(undefined, true)).toThrow('before building production');
  render(<SourceCodeLink />);
  expect(screen.getByRole('link', { name: 'Source code (development)' })).toBeVisible();
});

test.each([
  'https://github.com/giovannirandykusuma/umami/tree/abcdef1',
  'https://github.com/giovannirandykusuma/umami/tree/arbitrary-branch',
  'https://github.com/giovannirandykusuma/umami/tree/main',
  'https://github.com/giovannirandykusuma/umami/tree/master',
  'https://github.com/giovannirandykusuma/umami/tree/HEAD',
  'https://github.com/giovannirandykusuma/umami/tree/latest',
  'https://github.com/giovannirandykusuma/umami',
  'https://private.invalid/source',
  'https://user:secret@github.com/giovannirandykusuma/umami/tree/v1',
  `${releaseUrl}?token=secret`,
  `${releaseUrl}#fragment`,
  'javascript:alert(1)',
])('rejects unsafe or unversioned source URL %s', url => {
  expect(() => validateSourceUrl(url, true)).toThrow('before building production');
});
