// No SDK transport: execute the installed, version-pinned standard Pi CLI.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';
export const PI_VERSION = '1.4.0';
const root = process.env.AI_PI_ROOT;
if (!root || !isAbsolute(root)) throw new Error('Absolute AI_PI_ROOT required');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== PI_VERSION) {
  throw new Error('Unsupported Pi installation');
}
// Resolve only the allowed CLI path: the JS realpath walker also probes the
// package symlink root, which would require an unnecessarily recursive grant.
await import(pathToFileURL(realpathSync.native(join(root, 'dist/cli.js'))).href);
