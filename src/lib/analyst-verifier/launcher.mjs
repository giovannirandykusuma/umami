// Trusted restricted-identity launcher: one disposable Docker container per render job.
// The container has NO network (--network none), runs as uid 10001 with every capability
// dropped, a read-only root, no-new-privileges, no host mounts and no env/secrets. Its only
// channel is stdio carrying the bounded JSON-lines job protocol (see dispatch.mjs); the canvas
// and capability exchange are answered by the host in-process, never by a network proxy.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const VERIFIER_IMAGE = 'umami-analyst-verifier:local';
/** Never resolvable: the container has no network; requests to it are intercepted in-browser. */
export const VERIFIER_ORIGIN = 'http://verifier-canvas.internal';
const LINE_LIMIT = 16 * 1024 * 1024;

export function dockerArgs(name) {
  return [
    'run',
    '-i',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--shm-size',
    '128m',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=128m',
    VERIFIER_IMAGE,
    'node',
    'scripts/ai/verifier/container-worker.mjs',
  ];
}

const launchers = new WeakSet();
/** True only for launchers built here (the dispatcher's isolation precondition). */
export const isRestrictedLauncher = launcher => launchers.has(launcher);

/** @param {{ spawn?: typeof nodeSpawn }} [options] `spawn` is an exec seam for argv tests. */
export function createDockerLauncher({ spawn = nodeSpawn } = {}) {
  const launch = () => {
    const name = `umami-verifier-${randomBytes(8).toString('hex')}`;
    const proc = spawn('docker', dockerArgs(name), {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      shell: false,
    });
    const child = new EventEmitter();
    let buffer = '';
    let exited = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > LINE_LIMIT) return child.kill();
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n');
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          if (line) child.emit('message', JSON.parse(line));
        } catch {
          child.kill();
        }
      }
    });
    proc.stdin.on('error', () => undefined);
    proc.on('error', error => child.emit('error', error));
    proc.on('exit', code => {
      exited = true;
      child.emit('exit', code);
    });
    child.send = message => {
      if (!exited) proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.kill = () => {
      if (exited) return;
      proc.kill('SIGTERM');
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore', shell: false }).on('error', () => {});
    };
    return child;
  };
  const launcher = Object.freeze({ launch, origin: VERIFIER_ORIGIN });
  launchers.add(launcher);
  return launcher;
}
