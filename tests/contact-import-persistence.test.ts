import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import type { UploadedFile, UploadStore } from '../src/contacts/upload-store.js';

it('persists a parser failure through the real Rust bridge and reads it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-failure-'));
  const options = { command: fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url)),
    dbPath: join(directory, 'graph.sqlite') };
  let graph = new ContactGraphClient(options);
  let releases = 0;
  let extractions = 0;
  const file: UploadedFile = { fileId: 'synthetic-file', actor: 'alice', fileName: 'synthetic.pdf',
    mime: 'application/pdf', sha256: 'a'.repeat(64), tempPath: join(directory, 'synthetic.pdf'),
    uploadedAt: '2026-10-06T00:00:00.000Z' };
  const failure = { stage: 'parse', code: 'CONVERSION_FAILED', message: '文档解析失败',
    diagnostic: { exceptions: [{ type: 'RuntimeError', frames: [] }], root_code: 'CONVERSION_FAILED' } };
  // Only the external parser and upload metadata are fixtures; the queue, service,
  // protocol, Rust validation and SQLite persistence are production components.
  const service = new ContactImportService({ graph,
    uploads: { get: () => file, markSubmitted: () => undefined } as unknown as UploadStore,
    jobs: new ImportJobs({ concurrency: 1, timeoutMs: 5000, release: async () => { releases += 1; } }),
    parse: async () => { throw Object.assign(new Error('private-document-text'), {
      code: 'CONVERSION_FAILED', diagnostic: failure.diagnostic }); },
    extract: async () => { extractions += 1; throw new Error('must not extract'); },
  });
  try {
    const { import_id: importId } = await service.start({ file_id: file.fileId, operation_id: 'start' }, 'alice');
    await expect.poll(() => releases, { timeout: 4000 }).toBe(1);
    expect(await service.get(importId, 'alice')).toMatchObject({ status: 'failed', version: 3,
      failure, warnings: ['IMPORT_FAILED'], total_candidates: 0 });
    expect(extractions).toBe(0);
    await graph.close();
    graph = new ContactGraphClient(options);
    expect(await graph.request('get_import_job', { import_id: importId })).toMatchObject({
      status: 'failed', version: 3, data: { failure, candidates: [] },
    });
  } finally {
    await graph.close();
    await rm(directory, { recursive: true, force: true });
  }
});
