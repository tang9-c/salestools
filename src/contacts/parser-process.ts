import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeDiagnostic, type Diagnostic } from './import-diagnostics.js';

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
    HF_HOME: process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    HF_DEACTIVATE_ASYNC_LOAD: '1',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LANG: 'C.UTF-8',
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', TOKENIZERS_PARALLELISM: 'false' };
}

/** One detached group and scratch directory per request. Completion waits for pipe closure. */
export function spawnParser(options: { pythonBin: string; projectDir: string; filePath: string;
  fileType: string; limits: object; maxRuntimeMs?: number },
operation: 'parse' | 'preflight', requestId: string,
onTimeout: () => void): { child: ChildProcessWithoutNullStreams; kill: () => void;
  cleanup: Promise<Error | undefined>; diagnostic: () => Diagnostic | undefined } {
  const duration = Math.min(options.maxRuntimeMs ?? (operation === 'parse' ? 120_000 : 30_000), 120_000);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error('INVALID_LIMIT');
  const scratch = mkdtempSync(join(tmpdir(), 'contact-parser-'));
  const env = parserEnvironment(options.projectDir, scratch);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.pythonBin, ['-B', '-m', 'contact_worker.launcher', operation,
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
  let metadata: Diagnostic | undefined;
  let pending = '';
  let droppingLine = false;
  child.stderr.on('data', (chunk: Buffer) => {
    // Bound each line, not the lifetime of stderr: library noise must not hide
    // a later trusted diagnostic. Do not retain oversized partial lines.
    const parts = chunk.toString('utf8').split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (pending.length + part.length > 8192) { pending = ''; droppingLine = true; }
      if (!droppingLine) pending += part;
      if (index === parts.length - 1) break;
      const line = pending; pending = '';
      if (droppingLine) { droppingLine = false; continue; }
      if (!line.startsWith('CONTACT_DIAGNOSTIC ')) continue;
      try { metadata = safeDiagnostic(JSON.parse(line.slice('CONTACT_DIAGNOSTIC '.length))) ?? metadata; }
      catch { /* Discard arbitrary stderr, including parser/library messages. */ }
    }
  });
  return { child, kill, cleanup, diagnostic: () => metadata };
}
