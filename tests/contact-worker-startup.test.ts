import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startWorker, formatWorkerStartupFailure } from '../src/contacts/worker-server.js';
import { callWorkerSocket } from '../src/contacts/worker-ipc.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-startup-'));
  directories.push(dir);
  const uploadDirectory = join(dir, 'uploads');
  mkdirSync(uploadDirectory);
  const pythonBin = join(dir, 'python');
  // Only replace the external executable for lifecycle tests; real hardened
  // preflight is exercised by the production-container gate.
  writeFileSync(pythonBin, `#!/bin/sh\nprintf 'SANDBOX_UNAVAILABLE\\n'\nexit ${exitCode}\n`);
  chmodSync(pythonBin, 0o700);
  return { uploadDirectory, pythonBin, socket: join(dir, 'worker.sock') };
}

it('does not advertise readiness until startup preflight has passed', async () => {
  const options = setup();
  const server = await startWorker(options);
  try {
    await expect(callWorkerSocket(options.socket, '/healthz', {})).resolves.toEqual({ ready: true });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('leaves no ready socket when sandbox preflight fails', async () => {
  const options = setup(1);
  await expect(startWorker(options)).rejects.toThrow('SANDBOX_UNAVAILABLE');
  expect(existsSync(options.socket)).toBe(false);
});

it('reports missing deployment paths before starting the parser', async () => {
  const options = setup();
  await expect(startWorker({ ...options, uploadDirectory: join(options.uploadDirectory, 'missing') }))
    .rejects.toThrow('WORKER_UPLOAD_DIR_UNREADABLE');
  await expect(startWorker({ ...options, pythonBin: join(options.uploadDirectory, 'missing') }))
    .rejects.toThrow('WORKER_PYTHON_UNAVAILABLE');
  await expect(startWorker({ ...options, socket: join(options.uploadDirectory, 'missing', 'worker.sock') }))
    .rejects.toThrow('WORKER_SOCKET_DIR_UNWRITABLE');
  expect(existsSync(options.socket)).toBe(false);
});

it('gives actionable startup errors without echoing paths, credentials or arbitrary messages', () => {
  const safe = formatWorkerStartupFailure(new Error('SANDBOX_UNAVAILABLE'));
  expect(safe).toContain('SANDBOX_UNAVAILABLE');
  expect(safe).toContain('Landlock');
  const unknown = formatWorkerStartupFailure(new Error('/private/resume.pdf secret-token'));
  expect(unknown).toContain('WORKER_STARTUP_FAILED');
  expect(unknown).not.toContain('secret-token');
  expect(unknown).not.toContain('/private');
});
