import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { importFailure, safeDiagnostic } from '../src/contacts/import-diagnostics.js';
import { callWorkerSocket } from '../src/contacts/worker-ipc.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { parseLocalDocument } from '../src/contacts/document-worker.js';
import { fileURLToPath } from 'node:url';
import { GraphClientError } from '../src/contacts/graph-client.js';

it('identifies known Rust storage rejection while keeping the terminal write code', () => {
  expect(importFailure('persist', new GraphClientError('VALIDATION_ERROR'), 'IMPORT_STATE_WRITE_FAILED'))
    .toMatchObject({ code: 'IMPORT_STATE_WRITE_FAILED', diagnostic: { root_code: 'VALIDATION_ERROR' } });
});

it('exposes terminal write failure without replacing the parser cause or skipping cleanup', async () => {
  const original = new Error('CONVERSION_FAILED');
  const writeError = new Error('VALIDATION_ERROR');
  let released = 0;
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 1000,
    release: async () => { released += 1; } });
  const result = await jobs.start('failure-write', async () => { throw original; },
    async () => undefined, async () => { throw writeError; }).catch(error => error);
  expect(result.message).toBe('IMPORT_FAILED');
  expect(result.cause).toBe(original);
  expect(result.persistenceError).toBe(writeError);
  expect(released).toBe(1);
});

it('does not treat an arbitrary uppercase exception message as a public code', () => {
  expect(importFailure('extract', new Error('PRIVATE_DOCUMENT_NAME')).code).toBe('IMPORT_FAILED');
  expect(safeDiagnostic({ exceptions: [{ type: 'Error', frames: [], message: 'private-token' }] })).toBeUndefined();
  expect(safeDiagnostic({ exceptions: [{ type: 'Error', frames: [{ module: '/tmp/private.py', function: 'parse', line: 1 }] }] })).toBeUndefined();
});

it('preserves worker code and bounded program metadata across the Unix socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-diagnostic-test-'));
  const socket = join(directory, 'worker.sock');
  const diagnostic = { exceptions: [{ type: 'PermissionError', errno: 13,
    frames: [{ module: 'parser.py', function: 'parse', line: 7 }] }], exit_code: 1 };
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 'CONVERSION_FAILED', diagnostic }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    await expect(callWorkerSocket(socket, '/parse', {})).rejects.toMatchObject({
      message: 'CONVERSION_FAILED', diagnostic,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports cleanup failure separately without replacing the original conversion failure', async () => {
  const original = new Error('CONVERSION_FAILED');
  const cleanup = new Error('private cleanup path');
  const observed: unknown[] = [];
  let stored: unknown;
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 1000,
    release: async () => { throw cleanup; }, onCleanup: (_id, error) => observed.push(error) });
  const result = jobs.start('file-1', async () => { throw original; }, async () => undefined,
    async (_code, error) => { stored = error; });
  await expect(result).rejects.toMatchObject({ message: 'IMPORT_FAILED', cause: original });
  expect(stored).toBe(original);
  expect(observed).toEqual([cleanup]);
});

it('keeps later Python diagnostic metadata after oversized stderr noise and pipe closure', async () => {
  const projectDir = fileURLToPath(new URL('./fixtures/contact-diagnostic-worker/', import.meta.url));
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(parseLocalDocument({ pythonBin: '/usr/bin/python3', projectDir,
      filePath: join(projectDir, 'synthetic.pdf'), fileType: 'pdf', documentId: 'synthetic',
      limits: {}, }, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONVERSION_FAILED', diagnostic: { exceptions: [{ type: 'PermissionError', errno: 13,
        frames: [{ module: 'parser.py', function: 'parse', line: 7 }] }] },
    });
    const logs = output.mock.calls.map(call => String(call[0])).join('');
    expect(logs).toContain('"phase":"conversion_started"');
    expect(logs).not.toContain('secret-document');
  } finally { output.mockRestore(); }
});

it('logging failures cannot strand the queue or prevent cleanup', async () => {
  let released = 0;
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 1000,
    release: async () => { released += 1; }, onCleanup: () => { throw new Error('broken sink'); } });
  await jobs.start('f1', async () => [], async () => undefined);
  await jobs.start('f2', async () => [], async () => undefined);
  expect(released).toBe(2);
});

it('retains the model HTTP status without response bodies or credentials', () => {
  const cause = Object.assign(new Error('secret response'), { code: 'REMOTE_HTTP_ERROR', status: 401 });
  const error = Object.assign(new Error('MODEL_REQUEST_FAILED', { cause }), { code: 'MODEL_REQUEST_FAILED' });
  expect(importFailure('extract', error)).toMatchObject({ code: 'MODEL_REQUEST_FAILED',
    diagnostic: { root_code: 'REMOTE_HTTP_ERROR', http_status: 401 } });
  expect(JSON.stringify(importFailure('extract', error))).not.toContain('secret response');
});
