import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ContactGraphClient, GraphClientError, type GraphClient, type GraphOp } from '../src/contacts/graph-client.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { ImportCandidateSchema, type ImportCandidate } from '../src/contracts/index.js';
import type { UploadedFile, UploadStore } from '../src/contacts/upload-store.js';

const binary = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));
const collectedAt = '2026-09-26T00:00:00.000Z';
const sha = 'a'.repeat(64);
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(cleanup => cleanup()));
});

function candidate(id: string, name: string, phone?: string): ImportCandidate {
  return ImportCandidateSchema.parse({
    candidate_id: id, label: 'Person', properties: { name, ...(phone ? { telephone: [phone] } : {}) },
    extensions: { hobbies: [], instantMessaging: [] },
    evidence: [{ evidence_id: `ev_${id}`, subject_kind: 'entity', subject_id: id,
      field_path: 'properties.name', value: name, source_type: 'file',
      file_name: 'invented.pdf', file_sha256: sha, quote: name, page: 2,
      locator_status: 'located', collected_at: collectedAt },
    ...(phone ? [{ evidence_id: `ev_${id}_phone`, subject_kind: 'entity', subject_id: id,
      field_path: 'properties.telephone', value: phone, source_type: 'file',
      file_name: 'invented.pdf', file_sha256: sha, quote: phone, page: 2,
      locator_status: 'located', collected_at: collectedAt }] : [])],
    relation_suggestions: [], warnings: [], can_commit: true,
  });
}

async function harness(fileId = 'file-import-1', candidates: ImportCandidate[] = [candidate('c_1', 'Robin Vale')],
  onCommitted?: (entityIds: string[]) => Promise<void> | void, failIdentityLookup = false) {
  const directory = await mkdtemp(join(tmpdir(), 'contact-import-e2e-'));
  const dbPath = join(directory, 'graph.sqlite');
  let worker = new ContactGraphClient({ command: binary, dbPath });
  const statuses: string[] = [];
  const files = new Map<string, UploadedFile>();
  const file: UploadedFile = { fileId, fileName: 'invented.pdf', sha256: sha,
    mime: 'application/pdf', tempPath: join(directory, 'invented.pdf'), uploadedAt: collectedAt };
  files.set(fileId, file);
  let parseCount = 0;
  const uploads = { get: (id: string) => files.get(id) ?? null,
    markSubmitted: (id: string) => {
      const uploaded = files.get(id);
      if (!uploaded) throw new Error('FILE_NOT_FOUND');
      return uploaded;
    } } as UploadStore;
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 10_000,
    release: async id => { files.delete(id); } });
  let parseGate: Promise<void> | undefined;
  const graph: GraphClient = {
    request: <T>(op: GraphOp, payload: unknown, signal?: AbortSignal): Promise<T> => {
      if (op === 'put_import_job') statuses.push((payload as { status: string }).status);
      if (op === 'find_identity_candidates' && failIdentityLookup) {
        return Promise.reject(new Error('identity index unavailable'));
      }
      return worker.request<T>(op, payload, signal);
    },
    close: () => worker.close(),
  };
  const service = new ContactImportService({ graph, uploads, jobs, onCommitted,
    parse: async (_file, signal) => {
      parseCount += 1;
      if (parseGate) await Promise.race([parseGate, new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))]);
      return [{ block_id: 'b_1', text: 'private full OCR transcript Robin Vale', page: 2,
        source_ref: '#/texts/0' }];
    },
    extract: async () => ({ candidates, warnings: [], processedBlockIds: ['b_1'], unprocessedBlockIds: [] }),
  });
  resources.push(async () => { await jobs.recover(); await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, graph, files, file, statuses, get parseCount() { return parseCount; },
    pauseParse: (gate: Promise<void>) => { parseGate = gate; },
    restart: async () => { await worker.close(); worker = new ContactGraphClient({ command: binary, dbPath }); },
  };
}

async function waitForStatus(service: ContactImportService, importId: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const preview = await service.get(importId, 'reviewer');
    if (preview?.status === status) return preview;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Import did not reach ${status}`);
}

it('imports a nameless resume, finds it by school, then confirms a name on the same id', async () => {
  const anonymous = ImportCandidateSchema.parse({
    candidate_id: 'anonymous', label: 'Person', properties: { skills: ['Python'] },
    extensions: { hobbies: [], instantMessaging: [] },
    evidence: [{ evidence_id: 'ev-skill', subject_kind: 'entity', subject_id: 'anonymous',
      field_path: 'properties.skills', value: 'Python', source_type: 'file',
      file_name: 'invented.pdf', file_sha256: sha, quote: 'Python', page: 1,
      locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [{ source_candidate_id: 'anonymous', target_candidate_id: 'school',
      relation_type: 'alumniOf', properties: {}, uncertain: false,
      evidence: [{ evidence_id: 'ev-school', subject_kind: 'relation', subject_id: 'anonymous:school',
        field_path: '$relation', value: { relation_type: 'alumniOf', source_id: 'anonymous', target_id: 'school' },
        source_type: 'file', file_name: 'invented.pdf', file_sha256: sha,
        quote: '曾就读星辰大学', page: 1, locator_status: 'located', collected_at: collectedAt }] }],
    warnings: [], can_commit: true,
  });
  const school = ImportCandidateSchema.parse({
    candidate_id: 'school', label: 'Organization', properties: { name: '星辰大学' },
    evidence: [{ evidence_id: 'ev-org', subject_kind: 'entity', subject_id: 'school',
      field_path: 'properties.name', value: '星辰大学', source_type: 'file',
      file_name: 'invented.pdf', file_sha256: sha, quote: '星辰大学', page: 1,
      locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [], warnings: [], can_commit: true,
  });
  const h = await harness('file-anonymous', [anonymous, school]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-anonymous' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(preview).toMatchObject({ total_candidates: 2, candidates: [{ can_commit: true }, { can_commit: true }] });
  expect(preview.match_suggestions).toEqual([]);
  const committed = await h.service.commit({ import_id: started.import_id,
    preview_version: preview.version as number, operation_id: `contact-import:${started.import_id}`,
    choices: [{ candidate_id: 'anonymous', action: 'create' }, { candidate_id: 'school', action: 'create' }],
    relation_choices: [{ source_candidate_id: 'anonymous', target_candidate_id: 'school',
      relation_type: 'alumniOf', properties: {} }] }, 'reviewer') as {
      results: Array<{ candidate_id: string; entity_id: string }> };
  const personId = committed.results.find(item => item.candidate_id === 'anonymous')!.entity_id;
  const saved = await h.graph.request<{ entity: { properties: { name?: string; skills: string[] } };
    evidence: Array<{ field_path: string }>; relations: Array<{ relation_type: string }> }>(
    'get_contact', { entity_id: personId });
  expect(saved.entity.properties).not.toHaveProperty('name');
  expect(saved.entity.properties.skills).toEqual(['Python']);
  expect(saved.evidence).toContainEqual(expect.objectContaining({ field_path: 'properties.skills' }));
  expect(saved.relations).toContainEqual(expect.objectContaining({ relation_type: 'alumniOf' }));
  const page = await new ContactSearch(h.graph).search({ query: '星辰大学' });
  expect(page.items).toContainEqual(expect.objectContaining({ entity_id: personId, name: null,
    display_name: expect.stringContaining('未具名候选') }));
  const named = await h.graph.request<{ entity_id: string }>('save_contact', {
    operation_id: 'name-anonymous', actor: 'reviewer', entity_id: personId, expected_version: 1,
    label: 'Person', set_properties: { name: '陈晓' },
    evidence: [{ field_path: 'properties.name', value: '陈晓', source_type: 'manual',
      locator_status: 'not_applicable', collected_at: collectedAt }],
  });
  expect(named.entity_id).toBe(personId);
  expect((await new ContactSearch(h.graph).search({ name: '陈晓' })).items)
    .toContainEqual(expect.objectContaining({ entity_id: personId, name: '陈晓', display_name: '陈晓' }));
});

it('uses the real graph for preview, correction, merge, skip and durable replay', async () => {
  const people = [candidate('c_create', 'Robin Vale'), candidate('c_merge', 'Mira Chen'),
    candidate('c_skip', 'Alex Sample')];
  const notified: string[][] = [];
  const h = await harness('file-three-people', people, ids => {
    notified.push(ids);
    throw new Error('index queue unavailable');
  });
  const existing = await h.graph.request<{ entity_id: string }>('save_contact', {
    operation_id: 'existing-mira', actor: 'reviewer', label: 'Person',
    set_properties: { name: 'Mira Chen' },
    evidence: [{ field_path: 'properties.name', value: 'Mira Chen', source_type: 'manual',
      locator_status: 'not_applicable', collected_at: collectedAt }],
  });
  const initiated = { file_id: h.file.fileId, operation_id: 'start-three-people' };
  let responseLost!: { import_id: string };
  await expect((async () => {
    responseLost = await h.service.start(initiated, 'reviewer');
    throw new Error('simulated lost response');
  })()).rejects.toThrow('simulated lost response');
  const started = await h.service.start(initiated, 'reviewer');
  expect(started).toEqual(responseLost);
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(h.statuses[0]).toBe('queued');
  expect(h.statuses).toContain('processing');
  expect(h.statuses.at(-1)).toBe('ready_for_review');
  expect(ready).toMatchObject({ version: 3, total_candidates: 3, source: { file_name: 'invented.pdf' } });
  expect(await h.service.get(started.import_id, 'reviewer', 1, 1)).toMatchObject({
    candidates: [{ candidate_id: 'c_merge' }], total_candidates: 3,
  });
  await expect(h.service.get(started.import_id, 'someone-else')).rejects.toThrow('IMPORT_ACCESS_DENIED');
  expect(JSON.stringify(await h.graph.request('get_import_job', { import_id: started.import_id })))
    .not.toContain('private full OCR transcript');
  expect(await h.graph.request('get_contact', { entity_id: 'c_create' })).toBeNull();
  expect(await h.service.start(initiated, 'reviewer')).toEqual(started);
  expect(h.parseCount).toBe(1);
  await h.restart();
  expect(await h.service.start(initiated, 'reviewer')).toEqual(started);
  await expect(h.service.start({ ...initiated, operation_id: 'different-start' }, 'reviewer'))
    .rejects.toThrow('FILE_ALREADY_USED');
  await expect(h.service.start(initiated, 'another-user')).rejects.toThrow('OPERATION_CONFLICT');
  const choices = [
    { candidate_id: 'c_create', action: 'create', set_properties: { jobTitle: 'Sales Lead' },
      evidence: [{ field_path: 'properties.jobTitle', value: 'Sales Lead', source_type: 'manual',
        locator_status: 'not_applicable', collected_at: collectedAt }] },
    { candidate_id: 'c_merge', action: 'merge', target_id: existing.entity_id,
      expected_target_version: 1, keep_name: true },
    { candidate_id: 'c_skip', action: 'skip' },
  ];
  const input = { import_id: started.import_id, preview_version: 3,
    operation_id: `contact-import:${started.import_id}`, choices };
  await expect(h.service.commit({ ...input, preview_version: 2 }, 'reviewer'))
    .rejects.toThrow('VERSION_CONFLICT');
  const committed = await h.service.commit(input, 'reviewer') as { status: string; replayed: boolean;
    results: Array<{ candidate_id: string; entity_id?: string; action: string }> };
  expect(committed.status).toBe('committed');
  expect(committed.results.map(result => result.action)).toEqual(['create', 'merge', 'skip']);
  expect(committed.results[1]?.entity_id).toBe(existing.entity_id);
  await Promise.resolve();
  expect(notified).toContainEqual([committed.results[0]?.entity_id, existing.entity_id]);
  const created = await h.graph.request<{ entity: { properties: { name: string; jobTitle: string } };
    evidence: Array<{ evidence_id: string; subject_id: string; page?: number }> }>(
    'get_contact', { entity_id: committed.results[0]?.entity_id });
  expect(created.entity.properties).toMatchObject({ name: 'Robin Vale', jobTitle: 'Sales Lead' });
  expect(created.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ evidence_id: 'ev_c_create',
      subject_id: committed.results[0]?.entity_id, page: 2 }),
  ]));
  expect((await new ContactSearch(h.graph).search({ name: 'Robin Vale' })).items)
    .toEqual(expect.arrayContaining([expect.objectContaining({
      entity_id: committed.results[0]?.entity_id, name: 'Robin Vale',
    })]));
  const replay = await h.service.commit(input, 'reviewer') as typeof committed;
  expect(replay.replayed).toBe(true);
  expect(replay.results[0]?.entity_id).toBe(committed.results[0]?.entity_id);
  await h.restart();
  const afterRestart = await h.service.commit(input, 'reviewer') as typeof committed;
  expect(afterRestart.replayed).toBe(true);
  expect(afterRestart.results[0]?.entity_id).toBe(committed.results[0]?.entity_id);
});

it('cancels processing in the real graph and replays only the same cancellation', async () => {
  const h = await harness('file-cancel');
  let release!: () => void;
  h.pauseParse(new Promise<void>(resolve => { release = resolve; }));
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-cancel' }, 'reviewer');
  await waitForStatus(h.service, started.import_id, 'processing');
  const cancelled = await h.service.cancel({ import_id: started.import_id,
    operation_id: 'cancel-once' }, 'reviewer');
  expect(cancelled).toMatchObject({ status: 'cancelled', replayed: false });
  expect(await h.service.get(started.import_id, 'reviewer')).toMatchObject({ status: 'cancelled' });
  expect(await h.service.cancel({ import_id: started.import_id,
    operation_id: 'cancel-once' }, 'reviewer')).toMatchObject({ replayed: true });
  await expect(h.service.cancel({ import_id: started.import_id,
    operation_id: 'cancel-other' }, 'reviewer')).rejects.toThrow('VERSION_CONFLICT');
  await expect(h.service.commit({ import_id: started.import_id, preview_version: 3,
    operation_id: `contact-import:${started.import_id}`,
    choices: [{ candidate_id: 'c_1', action: 'create' }] }, 'reviewer'))
    .rejects.toBeInstanceOf(GraphClientError);
  expect(h.files.has(h.file.fileId)).toBe(false);
  release();
});

it('rejects a candidate proof attributed to another candidate before graph writes', async () => {
  const forged = candidate('c_owner', 'Robin Vale');
  forged.evidence[0]!.subject_id = 'c_other';
  const h = await harness('file-forged-proof', [forged]);
  const started = await h.service.start({ file_id: h.file.fileId,
    operation_id: 'start-forged' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  await expect(h.service.commit({ import_id: started.import_id,
    preview_version: ready.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: [{ candidate_id: 'c_owner', action: 'create' }] }, 'reviewer'))
    .rejects.toThrow('VALIDATION_ERROR');
  expect(await h.service.get(started.import_id, 'reviewer')).toMatchObject({ status: 'ready_for_review' });
});

it('suggests renamed people with the same self phone without choosing a merge', async () => {
  const h = await harness('file-rename', [candidate('c_rename', 'Robin New', '+86 (138) 0013-8000')]);
  const existing = await h.graph.request<{ entity_id: string }>('save_contact', {
    operation_id: 'existing-robin', actor: 'reviewer', label: 'Person',
    set_properties: { name: 'Robin Old', telephone: ['+8613800138000'] },
    evidence: [
      { field_path: 'properties.name', value: 'Robin Old', source_type: 'manual',
        locator_status: 'not_applicable', collected_at: collectedAt },
      { field_path: 'properties.telephone', value: '+8613800138000', source_type: 'manual',
        locator_status: 'not_applicable', collected_at: collectedAt },
    ],
  });
  const started = await h.service.start({ file_id: h.file.fileId,
    operation_id: 'start-rename' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(preview).toMatchObject({ match_suggestions: [{ entityId: existing.entity_id,
    candidateId: 'c_rename', candidateName: 'Robin New', existingName: 'Robin Old',
    reasons: [{ kind: 'self_phone', value: '+8613800138000' }] }],
    match_suggestions_truncated: false });
  const committed = await h.service.commit({ import_id: started.import_id,
    preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: [{ candidate_id: 'c_rename', action: 'create' }] }, 'reviewer') as {
      results: Array<{ entity_id: string }>;
    };
  expect(committed.results[0]?.entity_id).not.toBe(existing.entity_id);
  expect(await h.graph.request('get_contact', { entity_id: existing.entity_id }))
    .toMatchObject({ entity: { properties: { name: 'Robin Old' } } });
});

it('marks a preview when exact identity lookup has more than fifty matches', async () => {
  const phone = '+15550000000';
  const h = await harness('file-crowded', [candidate('c_crowded', 'Possible Match', phone)]);
  for (let index = 0; index < 51; index += 1) {
    const name = `Existing ${index}`;
    await h.graph.request('save_contact', { operation_id: `save-crowded-${index}`, actor: 'reviewer',
      label: 'Person', set_properties: { name, telephone: [phone] },
      evidence: [
        { field_path: 'properties.name', value: name, source_type: 'manual',
          locator_status: 'not_applicable', collected_at: collectedAt },
        { field_path: 'properties.telephone', value: phone, source_type: 'manual',
          locator_status: 'not_applicable', collected_at: collectedAt },
      ] });
  }
  const started = await h.service.start({ file_id: h.file.fileId,
    operation_id: 'start-crowded' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(preview.match_suggestions).toHaveLength(50);
  expect(preview.match_suggestions_truncated).toBe(true);
  expect(preview.warnings).toContain('身份匹配结果已截断，可能遗漏已有联系人');
});

it('preserves preview candidates when identity lookup fails', async () => {
  const h = await harness('file-identity-error', [candidate('c_error', 'Robin New', '+15550000000')],
    undefined, true);
  const started = await h.service.start({ file_id: h.file.fileId,
    operation_id: 'start-identity-error' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(preview).toMatchObject({ candidates: [{ candidate_id: 'c_error' }],
    match_suggestions: [], match_suggestions_truncated: false });
  expect(preview.warnings).toContain('身份匹配查询失败，请人工核对已有联系人');
});

it.each([[false, false], [true, false], [true, true]])('gates structured school suggestions: selected=%s anonymous=%s', async (selected, anonymous) => {
  const extraction = await new DocumentExtractor({ url: 'https://ark.example/chat', model: 'test', credential: 'test',
    fileName: 'invented.pdf', fileSha256: sha, collectedAt,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [
      { candidate_id: 'p', label: 'Person', properties: { name: '陈晓' },
        evidence: [{ field_path: 'properties.name', value: '陈晓', block_id: 'p', quote: '陈晓' }],
        relation_suggestions: [{ source_candidate_id: 'p', target_candidate_id: 's', relation_type: 'alumniOf',
          properties: {}, uncertain: false, evidence: [{ block_id: 's', quote: '星辰大学' }] }] },
      { candidate_id: 's', label: 'Organization', properties: { name: '星辰大学' },
        evidence: [{ field_path: 'properties.name', value: '星辰大学', block_id: 's', quote: '星辰大学' }] },
    ] }) } }] })) }).extract([
      { block_id: 'p', text: '陈晓', page: 1 }, { block_id: 'h', text: '教育经历', page: 1 },
      { block_id: 's', text: '星辰大学', page: 1 },
    ], new AbortController().signal);
  if (anonymous) {
    extraction.candidates[0] = ImportCandidateSchema.parse({ ...extraction.candidates[0],
      properties: { skills: ['Python'] }, evidence: [{ ...extraction.candidates[0].evidence[0],
        field_path: 'properties.skills', value: 'Python', quote: 'Python' }] });
  }
  const h = await harness(`structured-${selected}-${anonymous}`, extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  expect(preview.candidates).toEqual(expect.arrayContaining([expect.objectContaining({
    candidate_id: 'batch1:p', relation_suggestions: [expect.objectContaining({ uncertain: true, review_reason: 'structured_heading' })],
  })]));
  const committing = h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: extraction.candidates.map(item => ({ candidate_id: item.candidate_id, action: 'create' })),
    relation_choices: selected ? [{ source_candidate_id: 'batch1:p', target_candidate_id: 'batch1:s',
      relation_type: 'alumniOf', properties: {} }] : [],
  }, 'reviewer');
  if (anonymous) {
    await expect(committing).rejects.toThrow('VALIDATION_ERROR');
    return;
  }
  const committed = await committing as { results: Array<{ candidate_id: string; entity_id: string }> };
  const personId = committed.results.find(item => item.candidate_id === 'batch1:p')!.entity_id;
  const saved = await h.graph.request<{ relations: unknown[]; evidence: Array<{ quote?: string }> }>('get_contact', { entity_id: personId });
  expect(saved.relations).toHaveLength(selected ? 1 : 0);
  expect(saved.evidence.some(proof => /就读|毕业/.test(proof.quote ?? ''))).toBe(false);
  const search = await new ContactSearch(h.graph).search({ query: '星辰大学' });
  expect(search.items.some(item => item.entity_id === personId)).toBe(selected);
});


it('creates one same-file person while preserving two employment episodes after fragment merge', async () => {
  const blocks = [1, 2].map(page => ({ block_id: `p${page}`, page,
    text: `Riley Moss Mobile: +15550000111 works for Cedar Labs ${page === 1 ? '2020' : '2022'}` }));
  const raw = blocks.flatMap((block, index) => [
    { candidate_id: `p${index}`, label: 'Person', properties: { name: 'Riley Moss', telephone: ['+15550000111'] },
      evidence: [
        { field_path: 'properties.name', value: 'Riley Moss', block_id: block.block_id, quote: 'Riley Moss' },
        { field_path: 'properties.telephone', value: '+15550000111', block_id: block.block_id, quote: 'Mobile: +15550000111' },
      ], relation_suggestions: [{ source_candidate_id: `p${index}`, target_candidate_id: 'o', relation_type: 'worksFor',
        properties: { role: { '@type': 'OrganizationRole', startDate: index === 0 ? '2020' : '2022' } },
        evidence: [{ block_id: block.block_id, quote: block.text }], uncertain: false }] },
    ...(index === 0 ? [{ candidate_id: 'o', label: 'Organization', properties: { name: 'Cedar Labs' },
      evidence: [{ field_path: 'properties.name', value: 'Cedar Labs', block_id: block.block_id, quote: 'Cedar Labs' }] }] : []),
  ]);
  const extraction = await new DocumentExtractor({ url: 'https://ark.example/chat', model: 'test', credential: 'test',
    fileName: 'invented.pdf', fileSha256: sha, collectedAt,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: raw }) } }] }))
  }).extract(blocks, new AbortController().signal);
  expect(extraction.candidates.filter(item => item.label === 'Person')).toHaveLength(1);
  const person = extraction.candidates.find(item => item.label === 'Person')!;
  expect(person.relation_suggestions).toHaveLength(2);
  expect(person.relation_suggestions.every(item => item.source_candidate_id === person.candidate_id)).toBe(true);
  expect(person.relation_suggestions.every(item => item.evidence.every(proof =>
    proof.subject_id === `${person.candidate_id}:${item.target_candidate_id}`))).toBe(true);
  const h = await harness('same-file-merge', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: extraction.candidates.map(item => ({ candidate_id: item.candidate_id, action: 'create' })),
    relation_choices: person.relation_suggestions.map(({ source_candidate_id, target_candidate_id, relation_type, properties }) =>
      ({ source_candidate_id, target_candidate_id, relation_type, properties })),
  }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === person.candidate_id)!.entity_id;
  const saved = await h.graph.request<{ relations: unknown[] }>('get_contact', { entity_id: id });
  expect(committed.results).toHaveLength(2);
  expect(saved.relations).toHaveLength(2);
});

it.each([false, true])('commits legal long Unicode relation evidence with selected=%s', async selected => {
  const prefix = 'Morgan Example works for Cedar Labs ';
  const quote = prefix + '😀'.repeat(491 - [...prefix].length);
  const fileName = 'f'.repeat(100) + '.pdf';
  expect([...quote]).toHaveLength(491);
  expect(Buffer.byteLength(fileName)).toBe(104);
  const candidates = [
    { candidate_id: 'p', label: 'Person', properties: { name: 'Morgan Example' },
      evidence: [{ field_path: 'properties.name', value: 'Morgan Example', block_id: 'b1', quote: 'Morgan Example' }],
      relation_suggestions: [{ source_candidate_id: 'p', target_candidate_id: 'o', relation_type: 'worksFor',
        properties: { role: { '@type': 'OrganizationRole' } }, evidence: [{ block_id: 'b1', quote }], uncertain: false }] },
    { candidate_id: 'o', label: 'Organization', properties: { name: 'Cedar Labs' },
      evidence: [{ field_path: 'properties.name', value: 'Cedar Labs', block_id: 'b1', quote: 'Cedar Labs' }] },
  ];
  const extraction = await new DocumentExtractor({ url: 'https://ark.example/chat', model: 'test', credential: 'test',
    fileName, fileSha256: sha, collectedAt,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] })),
  }).extract([{ block_id: 'b1', text: quote, page: 1 }], new AbortController().signal);
  expect(extraction.candidates[0].relation_suggestions).toHaveLength(1);
  const h = await harness('long-source', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const relation = extraction.candidates[0].relation_suggestions[0];
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: extraction.candidates.map(item => ({ candidate_id: item.candidate_id, action: 'create' })),
    relation_choices: selected ? [{ source_candidate_id: relation.source_candidate_id,
      target_candidate_id: relation.target_candidate_id, relation_type: relation.relation_type, properties: relation.properties }] : [],
  }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'batch1:p')!.entity_id;
  const saved = await h.graph.request<{ relations: unknown[]; unverified_claims: Array<{ source: { file_name: string; file_sha256: string; quote: string } }> }>('get_contact', { entity_id: id });
  expect(saved.relations).toHaveLength(selected ? 1 : 0);
  expect(saved.unverified_claims).toHaveLength(selected ? 0 : 1);
  if (!selected) {
    const source = saved.unverified_claims[0].source;
    expect(source).toMatchObject({ file_name: fileName, file_sha256: sha, page: 1 });
    expect(Buffer.byteLength(JSON.stringify(source))).toBeLessThanOrEqual(2048);
    expect(quote.startsWith(source.quote)).toBe(true);
    expect(source.quote).not.toBe('');
  }
});
