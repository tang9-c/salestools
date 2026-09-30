import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SandboxMode = 'hardened' | 'test-only';

// System tools use physical tree traversal with directory-relative operations, so a
// malicious tree may exceed PATH_MAX without growing JS paths or following symlinks.
// Keep traversal out of the broker event loop and bound each trusted helper.
async function removeScratch(directory: string): Promise<Error | undefined> {
  const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
    execFile(file, args, {timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024,
      env: {PATH: '/usr/bin:/bin', LANG: 'C'}, cwd: '/'}, error => error ? reject(error) : resolve());
  });
  try {
    await run('/bin/chmod', ['-R', '--', 'u+rwx', directory]);
    await run('/bin/rm', ['-rf', '--', directory]);
    return undefined;
  } catch { return new Error('SCRATCH_CLEANUP_FAILED'); }
}

export function parserEnvironment(projectDir: string, scratch = '/tmp'): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch,
    PYTHONPATH: projectDir, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
    HF_HOME: '/opt/contact-models/hf', XDG_CACHE_HOME: '/opt/contact-models/cache',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LANG: 'C.UTF-8',
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', TOKENIZERS_PARALLELISM: 'false' };
}

/** One detached group and scratch directory per request. Completion waits for pipe closure. */
export function spawnParser(options: { pythonBin: string; projectDir: string; filePath: string;
  fileType: string; limits: object; sandboxMode?: SandboxMode; maxRuntimeMs?: number },
operation: 'parse' | 'preflight', requestId: string,
onTimeout: () => void): { child: ChildProcessWithoutNullStreams; kill: () => void; cleanup: Promise<Error | undefined> } {
  const mode = options.sandboxMode ?? 'hardened';
  if (mode === 'test-only' && process.env.NODE_ENV !== 'test') throw new Error('SANDBOX_UNAVAILABLE');
  const duration = Math.min(options.maxRuntimeMs ?? (operation === 'parse' ? 120_000 : 30_000), 120_000);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error('INVALID_LIMIT');
  const scratch = mkdtempSync(join(tmpdir(), 'contact-parser-'));
  const env = parserEnvironment(options.projectDir, scratch);
  if (mode === 'test-only') {
    env.CONTACT_SANDBOX_TESTING = '1';
    // Explicit local test runtime may use pre-downloaded developer model caches.
    env.HF_HOME = process.env.HF_HOME;
    env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
    env.HOME = process.env.HOME;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.pythonBin, ['-B', '-m', 'contact_worker.launcher', mode, operation,
      options.filePath, scratch, options.fileType, JSON.stringify(options.limits), requestId], {
      cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
  } catch (error) { rmSync(scratch, {recursive: true, force: true}); throw error; }
  let groupStopped = false;
  const kill = () => {
    if (groupStopped) return;
    if (child.pid) {
      groupStopped = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  const timer = setTimeout(onTimeout, duration); timer.unref();
  // exit fires even if a descendant holds a pipe open; kill descendants before waiting for close.
  child.once('exit', kill);
  const cleanup = new Promise<Error | undefined>(resolve => child.once('close', () => {
    clearTimeout(timer); kill();
    void removeScratch(scratch).then(resolve);
  }));
  child.stderr.on('data', () => undefined);
  return { child, kill, cleanup };
}
