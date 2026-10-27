import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// No subprocess, worker, addon, WASI or inspector permission is granted.
export function permissionArgs({ root, scratch, bridge, extension }) {
  const canonicalScratch = realpathSync(scratch);
  const reads = [scratch, canonicalScratch, bridge, extension];
  // Approved discovery exception: exact ancestor probe paths, never ancestor roots.
  // Node directory grants also cover descendants; automatic loading stays disabled.
  for (let ancestor = dirname(canonicalScratch); ; ancestor = dirname(ancestor)) {
    for (const probe of [join(ancestor, '.agents/skills'), join(ancestor, '.pi')]) {
      try {
        lstatSync(probe);
        throw new Error(`AI discovery probe must not exist: ${probe}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      reads.push(probe);
    }
    if (dirname(ancestor) === ancestor) break;
  }
  if (root) {
    if (!isAbsolute(root)) throw new Error('Absolute AI_PI_ROOT required');
    const installed = realpathSync(root);
    // Public extension loader probes workspace sibling entries before package imports.
    for (const entry of [
      'agent/dist/index.js',
      'tui/dist/index.js',
      'ai/dist/compat.js',
      'ai/dist/models.js',
      'ai/dist/oauth.js',
      'ai/dist/providers/all.js',
    ]) {
      reads.push(join(dirname(installed), entry));
    }
    reads.push(
      join(installed, 'package.json'),
      join(installed, 'dist'),
      join(installed, 'node_modules'),
    );
  }
  const args = [
    '--disable-warning=ExperimentalWarning',
    '--permission',
    ...reads.map(path => `--allow-fs-read=${resolve(path)}`),
    `--allow-fs-write=${scratch}`,
    `--allow-fs-write=${canonicalScratch}`,
  ];
  // Node 22 has no network permission category. Newer Node only offers a boolean,
  // NOT destination rules: this is not an OS egress boundary.
  if (Number(process.versions.node.split('.')[0]) >= 25) args.push('--allow-net');
  return args;
}

export function gatewayConfig(env) {
  const {
    AI_PROVIDER: provider,
    AI_MODEL: model,
    AI_BASE_URL: baseUrl,
    AI_EGRESS_ORIGINS: origin,
  } = env;
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(provider || '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,199}$/.test(model || '')
  )
    throw new Error('Invalid AI provider/model');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid AI endpoint');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    origin !== url.origin ||
    /[%\\\s]/.test(baseUrl)
  )
    throw new Error('Invalid AI endpoint/origin');
  // Construct the entire schema, rather than accepting arbitrary native settings,
  // headers, commands, paths, overrides or client-controlled model fields.
  return {
    providers: {
      [provider]: {
        baseUrl,
        api: 'openai-completions',
        apiKey: '$AI_PROVIDER_KEY',
        authHeader: true,
        models: [
          {
            id: model,
            input: ['text'],
            reasoning: false,
            compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
          },
        ],
      },
    },
  };
}
