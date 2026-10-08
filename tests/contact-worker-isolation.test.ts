import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseLocalDocument, parserEnvironment } from '../src/contacts/document-worker.js';
import { UploadStore } from '../src/contacts/upload-store.js';
import { createWorkerServer } from '../src/contacts/worker-server.js';
import { callWorkerSocket } from '../src/contacts/worker-ipc.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });

it('passes no service credentials to a parser process', () => {
  const original = process.env.ARK_CREDENTIAL;
  process.env.ARK_CREDENTIAL = 'must-not-reach-parser';
  try {
    const environment = parserEnvironment('/opt/contact-worker');
    expect(environment.ARK_CREDENTIAL).toBeUndefined();
    expect(environment.HF_HUB_OFFLINE).toBe('1');
  } finally {
    if (original === undefined) delete process.env.ARK_CREDENTIAL;
    else process.env.ARK_CREDENTIAL = original;
  }
});

it('runs preflight and parsing over the isolated worker socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-isolation-'));
  const uploadDirectory = join(directory, 'uploads');
  const socket = join(directory, 'worker.sock');
  const pythonBin = new URL('../python/.venv/bin/python', import.meta.url).pathname;
  const server = createWorkerServer({ uploadDirectory, pythonBin });
  server.listen(socket);
  await new Promise(resolve => server.once('listening', resolve));
  const uploads = new UploadStore({ directory: uploadDirectory, maxPendingFiles: 2,
    maxFileBytes: 20 * 1024 * 1024, maxTempBytes: 40 * 1024 * 1024,
    workerSocket: socket });
  cleanup.push(async () => { await uploads.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true }); });
  const fixture = new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url).pathname;
  const id = await uploads.reserve('alice');
  const file = await uploads.receive(id, createReadStream(fixture), 'resume.pdf');
  await expect(callWorkerSocket(socket, '/preflight', { filePath: join(directory, 'other', id),
    fileType: 'pdf', limits: {} })).rejects.toThrow('INVALID_PATH');
  await uploads.preflight(file);
  const blocks = await parseLocalDocument({ pythonBin, projectDir: new URL('../python/', import.meta.url).pathname,
    workerSocket: socket, filePath: file.tempPath, fileType: 'pdf', documentId: file.fileId,
    limits: { max_file_bytes: 20 * 1024 * 1024, max_pages: 50, max_page_pixels: 25_000_000 } },
  new AbortController().signal);
  expect(blocks.length).toBeGreaterThan(0);
}, 30_000);
