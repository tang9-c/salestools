import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import type { UploadedFile, UploadStore } from '../src/contacts/upload-store.js';

it('persists a person with failed optional education and reads context after bridge restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-education-'));
  const options = { command: fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url)), dbPath: join(directory, 'graph.sqlite') };
  let graph = new ContactGraphClient(options);
  let releases = 0;
  const file: UploadedFile = { fileId: 'education-file', actor: 'alice', fileName: 'synthetic.pdf', mime: 'application/pdf', sha256: 'a'.repeat(64), tempPath: join(directory, 'synthetic.pdf'), uploadedAt: '2026-10-09T00:00:00.000Z' };
  const fact = (field_path: string, value: string, quote = '本人就读学校') => ({ field_path, value, evidence: [{ block_id: 'b1', quote }], uncertain: false });
  const model = { subject_status: 'single', person: [fact('properties.name', '本人'), fact('properties.telephone', '13800138000')],
    education: [{ local_id: 'ed1', organization: [fact('properties.name', '学校'), fact('properties.major', '软件工程', '不存在的引文')],
      attendance: { evidence: [{ block_id: 'b1', quote: '本人就读学校' }], uncertain: false },
      details: [fact('properties.educationLevel', '本科'), fact('properties.startDate', '2022'), fact('properties.endDate', '2026')] }], employment: [], projects: [], organization_clues: [] };
  const extractor = new DocumentExtractor({ url: 'https://example.test', model: 'fixture', credential: 'fixture', fileName: file.fileName, fileSha256: file.sha256,
    skillSupplement: false, projectSupplement: false,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(model) } }] })) });
  const service = new ContactImportService({ graph, uploads: { get: () => file, markSubmitted: () => undefined } as unknown as UploadStore,
    jobs: new ImportJobs({ concurrency: 1, timeoutMs: 5000, release: async () => { releases += 1; } }),
    parse: async () => [{ block_id: 'b1', text: '本人就读学校 电话13800138000 软件工程', page: 1 }],
    extract: (blocks, _file, signal) => extractor.extract(blocks, signal) });
  try {
    const { import_id: id } = await service.start({ file_id: file.fileId, operation_id: 'start-education' }, 'alice');
    await expect.poll(() => releases, { timeout: 4000 }).toBe(1);
    const job = await graph.request<{ version: number; data: { candidates: Array<{ candidate_id: string; label: string }> } }>('get_import_job', { import_id: id });
    const result = await service.commit({ import_id: id, preview_version: job.version, operation_id: `contact-import:${id}`, auto_create: true }, 'alice');
    expect(result).toBeDefined();
    const person = job.data.candidates.find(c => c.label === 'Person')!;
    const school = job.data.candidates.find(c => c.label === 'Organization')!;
    // Read the committed mapping rather than guessing graph IDs.
    const mappings = result.results as Array<{ candidate_id: string; entity_id: string }>;
    const personId = mappings.find(item => item.candidate_id === person.candidate_id)!.entity_id;
    const schoolId = mappings.find(item => item.candidate_id === school.candidate_id)!.entity_id;
    await graph.close();
    graph = new ContactGraphClient(options);
    const personSaved = await graph.request<{ entity: { properties: Record<string, unknown> }; relations: Array<{ relation_type: string; properties: unknown }>; unverified_claims: Array<{ kind: string; relation_type: string; target_id: string; value: unknown }> }>('get_contact', { entity_id: personId });
    expect(personSaved.entity.properties).toMatchObject({ name: '本人', skills: [] });
    expect(personSaved.unverified_claims).toContainEqual(expect.objectContaining({ kind: 'relation', relation_type: 'alumniOf', target_id: schoolId, value: expect.objectContaining({ properties: expect.objectContaining({ major: '软件工程' }) }) }));
    expect(personSaved.relations).toContainEqual(expect.objectContaining({ relation_type: 'alumniOf', properties: { educationLevel: '本科', startDate: '2022', endDate: '2026' } }));
    const schoolSaved = await graph.request<{ entity: { properties: Record<string, unknown> }; unverified_claims: unknown[] }>('get_contact', { entity_id: schoolId });
    expect(schoolSaved.entity.properties).not.toHaveProperty('major');
    expect(schoolSaved.unverified_claims).toEqual([]);
  } finally {
    await graph.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
