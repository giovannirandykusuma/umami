// Synthetic analyst app on its own loopback port, booted from a SANITIZED fixture project:
// a fresh temp directory holding only allowlisted sources (never any .env* file), so Next's
// automatic .env loading (and the `dotenv/config` import in next.config.ts) has nothing to
// discover. The child receives an explicit env allowlist: no host secrets or credentials.
// The assistant runs the synthetic-only offline provider (no live provider, no fallback), and
// the verifier uses the restricted Docker launcher when its local image exists.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  statSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const FIXTURE_DATABASE =
  'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=analyst_fixture';
const ENTRIES = [
  'src',
  'public',
  'prisma',
  'scripts/ai',
  'next.config.ts',
  'package.json',
  'tsconfig.json',
  'postcss.config.js',
  'prisma.config.ts',
];
const isEnvFile = name => /^\.env(\..*)?$|\.env\./.test(name);

/**
 * Platform system temp, chosen WITHOUT trusting $TMPDIR (a lane may point it inside the repo,
 * whose ancestors hold .pi/.agents discovery dirs). macOS: the per-user confstr temp; Linux:
 * /tmp. The root must be a real directory owned by us or root-sticky, and no ancestor of it may
 * contain .pi or .agents/skills (the native discovery guard stays unchanged and would refuse).
 */
export function systemTemp({ platform = process.platform, confstr = darwinUserTemp } = {}) {
  const root = realpathSync(platform === 'darwin' ? confstr() : '/tmp');
  const stat = statSync(root);
  const uid = process.getuid();
  if (!stat.isDirectory() || !(stat.uid === uid || (stat.uid === 0 && stat.mode & 0o1000)))
    throw new Error(`Refusing untrusted system temp: ${root}`);
  for (let dir = root; ; dir = dirname(dir)) {
    for (const probe of ['.pi', '.agents/skills'])
      if (existsSync(join(dir, probe)))
        throw new Error(`Refusing system temp with discovery ancestor: ${join(dir, probe)}`);
    if (dirname(dir) === dir) break;
  }
  return root;
}
function darwinUserTemp() {
  const out = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  const dir = out.stdout?.trim();
  if (out.status !== 0 || !dir || !isAbsolute(dir)) throw new Error('No system temp');
  return dir;
}

/** Builds the sanitized project; refuses if any .env* file would be copied. */
export function sanitizedProject(checkout, nonce) {
  const dir = mkdtempSync(join(systemTemp(), 'umami-analyst-fixture-'));
  for (const entry of ENTRIES)
    cpSync(join(checkout, entry), join(dir, entry), {
      recursive: true,
      dereference: true,
      filter: source => !isEnvFile(basename(source)) && !source.includes('/node_modules'),
    });
  // Dependencies are shared read-only (symlink); nothing is written through it.
  symlinkSync(join(checkout, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, '.home'));
  writeFileSync(
    join(dir, '.analyst-fixture-receipt.json'),
    JSON.stringify({ mode: 'analyst-synthetic-v1', nonce }),
  );
  const leaked = readdirSync(dir, { recursive: true }).filter(
    p => !String(p).startsWith('node_modules') && isEnvFile(basename(String(p))),
  );
  if (leaked.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Refusing: env files in fixture project: ${leaked}`);
  }
  return dir;
}

export function fixtureEnv({ dir, port, nonce, piRoot, verifier }) {
  return {
    PATH: process.env.PATH,
    // Fixture-owned home/tmp: Pi scratch ancestors never include shared host dirs like /tmp/.pi.
    HOME: join(dir, '.home'),
    TMPDIR: join(dir, '.home'),
    NODE_ENV: 'development',
    PORT: port,
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: FIXTURE_DATABASE,
    APP_SECRET: 'synthetic-analyst-fixture-only',
    AI_ANALYST_ENABLED: 'true',
    AI_OFFLINE_FIXTURE: 'analyst-synthetic-v1',
    AI_OFFLINE_FIXTURE_NONCE: nonce,
    AI_PI_ROOT: piRoot,
    ...(verifier
      ? { AI_ANALYST_VERIFIER_ENABLED: 'true', AI_ANALYST_VERIFIER_LAUNCHER: 'docker' }
      : {}),
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = process.env.ANALYST_FIXTURE_PORT ?? '3327';
  if (!/^\d+$/.test(port) || ['3000', '3317'].includes(port))
    throw new Error('Refusing shared port');
  const piRoot = process.env.AI_PI_ROOT;
  if (!piRoot) throw new Error('AI_PI_ROOT (pinned Pi install) required for the offline turn');
  const verifier =
    spawnSync('docker', ['image', 'inspect', 'umami-analyst-verifier:local'], { stdio: 'ignore' })
      .status === 0;
  const nonce = randomBytes(32).toString('hex');
  const dir = sanitizedProject(resolve('.'), nonce);
  // The generated Prisma client is gitignored; generate it inside the sanitized project.
  const generated = spawnSync(join(dir, 'node_modules/.bin/prisma'), ['generate'], {
    cwd: dir,
    stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: '/tmp', DATABASE_URL: FIXTURE_DATABASE },
  });
  if (generated.status !== 0) throw new Error('prisma generate failed');
  console.log(JSON.stringify({ fixtureProject: dir, verifier }));
  const child = spawn(
    join(dir, 'node_modules/.bin/next'),
    ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', port],
    { cwd: dir, stdio: 'inherit', env: fixtureEnv({ dir, port, nonce, piRoot, verifier }) },
  );
  const stop = signal => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
  child.on('exit', code => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(code ?? 1);
  });
}
