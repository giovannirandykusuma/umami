// Synthetic analyst app on its own loopback port, booted from a SANITIZED fixture project:
// a fresh temp directory holding only allowlisted sources (never any .env* file), so Next's
// automatic .env loading (and the `dotenv/config` import in next.config.ts) has nothing to
// discover. The child receives an explicit env allowlist: no host secrets or credentials.
// The assistant runs the synthetic-only offline provider (no live provider, no fallback), and
// the verifier uses the restricted Docker launcher when its local image exists.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Limit webpack's development footprint only in this disposable copy. Do not
  // retain every compiled route: that exhausted heap/swap with two dev instances.
  const config = join(dir, 'next.config.ts');
  const source = readFileSync(config, 'utf8');
  if (!source.includes('reactStrictMode: false,')) throw new Error('Fixture config anchor missing');
  writeFileSync(
    config,
    source.replace(
      'reactStrictMode: false,',
      'reactStrictMode: false,\n  webpack: (config) => { config.cache = false; config.parallelism = 1; return config; },',
    ),
  );
  // Dependencies are shared read-only (symlink); nothing is written through it.
  // Real path: workspace links (@umami/* -> ../../packages) must resolve to the built packages.
  symlinkSync(realpathSync(join(checkout, 'node_modules')), join(dir, 'node_modules'));
  mkdirSync(join(dir, '.home'));
  writeReceipt(dir, nonce);
  const leaked = readdirSync(dir, { recursive: true }).filter(
    p => !String(p).startsWith('node_modules') && isEnvFile(basename(String(p))),
  );
  if (leaked.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Refusing: env files in fixture project: ${leaked}`);
  }
  return dir;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
/**
 * Launcher-owned synthetic marker (runtime.ts offlineFixtureRuntime verifies every field): binds
 * the nonce by hash, this exact root, the packaged provider file and its issue time; in built
 * mode also the BUILD_ID of the Next build made here. Only this launcher writes it.
 */
export function writeReceipt(dir, nonce, buildId) {
  writeFileSync(
    join(dir, '.analyst-fixture-receipt.json'),
    JSON.stringify({
      mode: 'analyst-synthetic-v1',
      nonceSha256: sha256(nonce),
      root: realpathSync(dir),
      providerSha256: sha256(
        readFileSync(join(dir, 'scripts/ai/analyst-fixture/offline-provider.mjs')),
      ),
      issuedAt: Date.now(),
      ...(buildId ? { buildId } : {}),
    }),
    { mode: 0o600 },
  );
}

/**
 * `built`: production Next build/start of the sanitized project (NODE_ENV=production); the
 * offline runtime then additionally requires the receipt's BUILD_ID binding.
 * `flagsOff`: explicit synthetic default-off mode (AI_ANALYST_ENABLED and the verifier flag unset,
 * so lifecycle creation is disabled while saved-analysis execution stays available). The offline
 * fixture runtime is analyst-only, so it is also omitted; there is no live fallback either way.
 */
export function fixtureEnv({
  dir,
  port,
  nonce,
  piRoot,
  verifier,
  flagsOff = false,
  built = false,
}) {
  return {
    PATH: process.env.PATH,
    // Fixture-owned home/tmp: Pi scratch ancestors never include shared host dirs like /tmp/.pi.
    HOME: join(dir, '.home'),
    TMPDIR: join(dir, '.home'),
    NODE_ENV: built ? 'production' : 'development',
    NODE_OPTIONS: '--max-old-space-size=2048',
    PORT: port,
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: FIXTURE_DATABASE,
    APP_SECRET: 'synthetic-analyst-fixture-only',
    ...(flagsOff
      ? {}
      : {
          AI_ANALYST_ENABLED: 'true',
          AI_OFFLINE_FIXTURE: 'analyst-synthetic-v1',
          AI_OFFLINE_FIXTURE_NONCE: nonce,
          AI_PI_ROOT: piRoot,
        }),
    ...(verifier && !flagsOff
      ? { AI_ANALYST_VERIFIER_ENABLED: 'true', AI_ANALYST_VERIFIER_LAUNCHER: 'docker' }
      : {}),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.ANALYST_FIXTURE_PORT ?? '3327';
  if (!/^\d+$/.test(port) || ['3000', '3317'].includes(port))
    throw new Error('Refusing shared port');
  const flagsOff = process.env.ANALYST_FIXTURE_FLAGS === 'off';
  const built = process.env.ANALYST_FIXTURE_BUILT === '1';
  const piRoot = process.env.AI_PI_ROOT;
  if (!piRoot && !flagsOff)
    throw new Error('AI_PI_ROOT (pinned Pi install) required for the offline turn');
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
  console.log(JSON.stringify({ fixtureProject: dir, verifier, flagsOff, built }));
  const env = { dir, port, nonce, piRoot, verifier, built };
  const next = join(dir, 'node_modules/.bin/next');
  const children = [];
  if (built) {
    // next.config validateSourceUrl requires a source pointer in production (build AND start).
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const sourceUrl = `https://github.com/giovannirandykusuma/umami/tree/${head}`;
    // Build once, synthetic-only env (no host secrets); then start flags-on and, when asked,
    // a flags-off server from the SAME build. Production servers stay small, unlike dev.
    const build = spawnSync(next, ['build', '--webpack'], {
      cwd: dir,
      stdio: 'inherit',
      env: {
        ...fixtureEnv({ ...env, flagsOff: true }),
        NODE_OPTIONS: '--max-old-space-size=4096',
        BUILD_WORKERS: '1',
        NEXT_PUBLIC_SOURCE_URL: sourceUrl,
      },
    });
    if (build.status !== 0) throw new Error('next build failed');
    writeReceipt(dir, nonce, readFileSync(join(dir, '.next/BUILD_ID'), 'utf8').trim());
    const offPort = process.env.ANALYST_FIXTURE_FLAGS_OFF_PORT;
    if (offPort && (!/^\d+$/.test(offPort) || ['3000', '3317', port].includes(offPort)))
      throw new Error('Refusing shared port');
    for (const [p, off] of [[port, flagsOff], ...(offPort ? [[offPort, true]] : [])])
      children.push(
        spawn(next, ['start', '--hostname', '127.0.0.1', '--port', p], {
          cwd: dir,
          stdio: 'inherit',
          env: {
            ...fixtureEnv({ ...env, port: p, flagsOff: off }),
            NEXT_PUBLIC_SOURCE_URL: sourceUrl,
          },
        }),
      );
  } else
    children.push(
      spawn(next, ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', port], {
        cwd: dir,
        stdio: 'inherit',
        env: fixtureEnv({ ...env, flagsOff }),
      }),
    );
  const [child] = children;
  const stop = signal => {
    for (const c of children) c.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
  child.on('exit', (code, signal) => {
    if (code === 0) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      // Retain synthetic-only compiler traces on failure; never print the nonce,
      // auth tokens or request bodies. MAIN can inspect and remove this owned temp.
      console.error(JSON.stringify({ fixtureFailure: { code, signal, project: dir } }));
    }
    process.exit(code ?? 1);
  });
}
