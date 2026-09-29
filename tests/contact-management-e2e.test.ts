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

it('auto-creates one resume owner and saves institution relations as searchable unverified claims', async () => {
  const owner = candidate('owner', 'Lin Vale');
  owner.relation_suggestions.push({
    source_candidate_id: 'owner', target_candidate_id: 'employer', relation_type: 'worksFor',
    properties: { role: { '@type': 'OrganizationRole' } }, uncertain: true, review_reason: 'structured_heading',
    evidence: [{ evidence_id: 'ev-work', subject_kind: 'relation', subject_id: 'owner:employer',
      field_path: '$relation', value: { relation_type: 'worksFor', source_id: 'owner', target_id: 'employer' },
      source_type: 'file', file_name: 'invented.pdf', file_sha256: sha, quote: '工作经历',
      page: 2, locator_status: 'located', collected_at: collectedAt }],
  });
  const employer = ImportCandidateSchema.parse({
    candidate_id: 'employer', label: 'Organization', properties: { name: 'Cedar Labs' },
    evidence: [{ evidence_id: 'ev-employer', subject_kind: 'entity', subject_id: 'employer',
      field_path: 'properties.name', value: 'Cedar Labs', source_type: 'file',
      file_name: 'invented.pdf', file_sha256: sha, quote: 'Cedar Labs', page: 2,
      locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [], warnings: [], can_commit: true,
  });
  const h = await harness('file-auto', [owner, employer]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-auto' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const input = { import_id: started.import_id, preview_version: ready.version as number,
    operation_id: 'contact-import:' + started.import_id, auto_create: true };
  await expect(h.service.commit({ ...input, choices: [] }, 'reviewer'))
    .rejects.toThrow('AUTO_CREATE_CONFLICT');
  await expect(h.service.commit({ ...input, relation_choices: [{}] }, 'reviewer'))
    .rejects.toThrow('AUTO_CREATE_CONFLICT');
  await expect(h.service.commit({ ...input, preview_version: 2 }, 'reviewer'))
    .rejects.toThrow('VERSION_CONFLICT');
  const committed = await h.service.commit(input, 'reviewer') as {
    results: Array<{ candidate_id: string; action: string; entity_id: string }> };
  expect(committed.results.map(item => item.action)).toEqual(['create', 'create']);
  const personId = committed.results[0].entity_id;
  const employerId = committed.results[1].entity_id;
  const saved = await h.graph.request<{ relations: unknown[];
    unverified_claims: Array<{ kind: string; relation_type: string; status: string; target_id: string; claim_id: string }> }>(
    'get_contact', { entity_id: personId });
  expect(saved.relations).toEqual([]);
  expect(saved.unverified_claims).toContainEqual(expect.objectContaining({
    kind: 'relation', relation_type: 'worksFor', status: 'unverified', target_id: employerId,
  }));
  expect((await new ContactSearch(h.graph).search({ query: 'Cedar Labs' })).items
    .some(item => item.entity_id === personId)).toBe(false);
  expect((await new ContactSearch(h.graph).search({ query: 'Cedar Labs', include_unverified: true })).items)
    .toContainEqual(expect.objectContaining({ entity_id: personId, match_status: 'unverified',
      claim_id: saved.unverified_claims[0].claim_id }));
  const replay = await h.service.commit(input, 'reviewer') as { replayed: boolean; results: typeof committed.results };
  expect(replay.replayed).toBe(true);
  expect(replay.results[0].entity_id).toBe(personId);
});

it('auto-commits a directly stated employer with file evidence and never equates its client to an employer', async () => {
  const owner = candidate('owner', 'Lin Vale');
  owner.relation_suggestions.push({
    source_candidate_id: 'owner', target_candidate_id: 'employer', relation_type: 'worksFor',
    properties: { role: { '@type': 'OrganizationRole', roleName: '顾问' } }, uncertain: false,
    evidence: [{ evidence_id: 'ev-work', subject_kind: 'relation', subject_id: 'owner:employer',
      field_path: '$relation', value: { relation_type: 'worksFor', source_id: 'owner', target_id: 'employer' },
      source_type: 'file', file_name: 'invented.pdf', file_sha256: sha, quote: 'Lin Vale 任职甲公司，负责乙公司项目',
      page: 2, locator_status: 'located', collected_at: collectedAt },
    { evidence_id: 'ev-role', subject_kind: 'relation', subject_id: 'owner:employer',
      field_path: 'properties.role.roleName', value: '顾问',
      source_type: 'file', file_name: 'invented.pdf', file_sha256: sha, quote: '顾问',
      page: 2, locator_status: 'located', collected_at: collectedAt }],
  });
  const organization = (id: string, name: string) => ImportCandidateSchema.parse({
    candidate_id: id, label: 'Organization', properties: { name },
    evidence: [{ evidence_id: `ev_${id}`, subject_kind: 'entity', subject_id: id,
      field_path: 'properties.name', value: name, source_type: 'file', file_name: 'invented.pdf',
      file_sha256: sha, quote: name, page: 2, locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [], warnings: [], can_commit: true,
  });
  const h = await harness('file-direct-employer', [owner, organization('employer', '甲公司'), organization('client', '乙公司')]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-direct-employer' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id,
    preview_version: ready.version as number, operation_id: `contact-import:${started.import_id}`,
    auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const personId = committed.results.find(item => item.candidate_id === 'owner')!.entity_id;
  const employerId = committed.results.find(item => item.candidate_id === 'employer')!.entity_id;
  const clientId = committed.results.find(item => item.candidate_id === 'client')!.entity_id;
  const saved = await h.graph.request<{ relations: Array<{ relation_id: string; relation_type: string; target_id: string }>;
    evidence: Array<{ subject_kind: string; subject_id: string; source_type: string }> }>(
    'get_contact', { entity_id: personId });
  expect(saved.relations).toContainEqual(expect.objectContaining({ relation_type: 'worksFor', target_id: employerId }));
  expect(saved.relations.some(relation => relation.target_id === clientId)).toBe(false);
  const relationId = saved.relations.find(relation => relation.target_id === employerId)?.relation_id;
  const relationProof = saved.evidence.filter(proof => proof.subject_kind === 'relation' && proof.subject_id === relationId);
  expect(relationProof.length).toBeGreaterThan(0);
  expect(relationProof.every(proof => proof.source_type === 'file')).toBe(true);
});

it('auto-imports one resume owner through a project to its client, without inventing client employment', async () => {
  const owner = candidate('owner', 'Lin Vale');
  const projectQuote = '项目经历：PLM 升级，项目角色顾问，客户乙公司';
  const relationProof = (id: string, source: string, target: string, kind: 'memberOf' | 'clientOrganization') => ({
    evidence_id: id, subject_kind: 'relation' as const, subject_id: `${source}:${target}`,
    field_path: '$relation', value: { relation_type: kind, source_id: source, target_id: target },
    source_type: 'file' as const, file_name: 'invented.pdf', file_sha256: sha,
    quote: '实施升级交付工作', page: 2, locator_status: 'located' as const, collected_at: collectedAt,
  });
  owner.relation_suggestions.push({
    source_candidate_id: 'owner', target_candidate_id: 'project', relation_type: 'memberOf',
    properties: { role: { '@type': 'OrganizationRole', roleName: '顾问' } }, uncertain: false,
    evidence: [relationProof('ev-member', 'owner', 'project', 'memberOf'),
      { evidence_id: 'ev-project-role', subject_kind: 'relation', subject_id: 'owner:project',
        field_path: 'properties.role.roleName', value: '顾问', source_type: 'file',
        file_name: 'invented.pdf', file_sha256: sha, quote: '实施升级交付工作', page: 2,
        locator_status: 'located', collected_at: collectedAt }],
  });
  const project = ImportCandidateSchema.parse({
    candidate_id: 'project', label: 'Project', properties: { name: 'PLM 升级' },
    evidence: [{ evidence_id: 'ev-project-name', subject_kind: 'entity', subject_id: 'project',
      field_path: 'properties.name', value: 'PLM 升级', source_type: 'file', file_name: 'invented.pdf',
      file_sha256: sha, quote: '实施升级交付工作', page: 2, locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [{ source_candidate_id: 'project', target_candidate_id: 'client',
      relation_type: 'clientOrganization', properties: {}, uncertain: false,
      evidence: [relationProof('ev-client-rel', 'project', 'client', 'clientOrganization')] }],
    warnings: [], can_commit: true,
  });
  const client = ImportCandidateSchema.parse({
    candidate_id: 'client', label: 'Organization', properties: { name: '乙公司' },
    evidence: [{ evidence_id: 'ev-client-name', subject_kind: 'entity', subject_id: 'client',
      field_path: 'properties.name', value: '乙公司', source_type: 'file', file_name: 'invented.pdf',
      file_sha256: sha, quote: '实施升级交付工作', page: 2, locator_status: 'located', collected_at: collectedAt }],
    relation_suggestions: [], warnings: [], can_commit: true,
  });
  const h = await harness('file-project', [owner, project, client]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-project' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const input = { import_id: started.import_id, preview_version: ready.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true };
  const committed = await h.service.commit(input, 'reviewer') as { results: Array<{ candidate_id: string; entity_id?: string }> };
  const personId = committed.results.find(item => item.candidate_id === 'owner')!.entity_id!;
  const projectId = committed.results.find(item => item.candidate_id === 'project')!.entity_id!;
  const clientId = committed.results.find(item => item.candidate_id === 'client')!.entity_id!;
  expect(projectId).toMatch(/^j_/u);
  const person = await h.graph.request<{ relations: Array<{ relation_type: string; target_id: string }> }>(
    'get_contact', { entity_id: personId });
  const projectSaved = await h.graph.request<{ relations: Array<{ relation_type: string; target_id: string }> }>(
    'get_contact', { entity_id: projectId });
  expect(person.relations).toContainEqual(expect.objectContaining({ relation_type: 'memberOf', target_id: projectId }));
  expect(person.relations.some(relation => relation.relation_type === 'worksFor' && relation.target_id === clientId)).toBe(false);
  expect(projectSaved.relations).toContainEqual(expect.objectContaining({ relation_type: 'clientOrganization', target_id: clientId }));
  expect((await new ContactSearch(h.graph).search({ query: '乙公司' })).items)
    .toContainEqual(expect.objectContaining({ entity_id: personId, matched_project_id: projectId }));
  expect((await h.service.commit(input, 'reviewer') as { replayed: boolean }).replayed).toBe(true);

  const weakProject = ImportCandidateSchema.parse({ ...project,
    relation_suggestions: project.relation_suggestions.map(relation => ({ ...relation,
      uncertain: true, review_reason: 'ambiguous_owner' })) });
  const weak = await harness('file-project-weak', [owner, weakProject, client]);
  const weakStarted = await weak.service.start({ file_id: weak.file.fileId,
    operation_id: 'start-project-weak' }, 'reviewer');
  const weakReady = await waitForStatus(weak.service, weakStarted.import_id, 'ready_for_review');
  const weakCommit = await weak.service.commit({ import_id: weakStarted.import_id,
    preview_version: weakReady.version as number,
    operation_id: `contact-import:${weakStarted.import_id}`, auto_create: true }, 'reviewer') as {
    results: Array<{ candidate_id: string; entity_id?: string }> };
  const weakPersonId = weakCommit.results.find(item => item.candidate_id === 'owner')!.entity_id!;
  const weakProjectId = weakCommit.results.find(item => item.candidate_id === 'project')!.entity_id!;
  const weakSaved = await weak.graph.request<{ relations: Array<{ relation_type: string }>;
    unverified_claims: Array<{ relation_type: string; target_id: string; claim_id: string }> }>(
    'get_contact', { entity_id: weakProjectId });
  expect(weakSaved.relations.some(relation => relation.relation_type === 'clientOrganization')).toBe(false);
  expect(weakSaved.unverified_claims).toContainEqual(expect.objectContaining({
    relation_type: 'clientOrganization', target_id: weakCommit.results.find(item => item.candidate_id === 'client')!.entity_id,
  }));
  expect((await new ContactSearch(weak.graph).search({ query: '乙公司' })).items
    .some(item => item.entity_id === weakPersonId)).toBe(false);
  expect((await new ContactSearch(weak.graph).search({ query: '乙公司', include_unverified: true })).items)
    .toContainEqual(expect.objectContaining({ entity_id: weakPersonId, matched_project_id: weakProjectId,
      match_status: 'unverified', claim_ids: [weakSaved.unverified_claims[0].claim_id] }));
});

it('auto-creates only the owner when the preview also contains an explicit reference person', async () => {
  const reference = candidate('reference', 'Mira Reference', '+15550000111');
  reference.can_commit = false;
  reference.warnings.push('非主体人物线索');
  const h = await harness('file-reference', [candidate('owner', 'Lin Vale'), reference]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-reference' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id,
    preview_version: ready.version as number,
    operation_id: 'contact-import:' + started.import_id, auto_create: true }, 'reviewer') as {
      results: Array<{ candidate_id: string; action: string; entity_id?: string }> };
  expect(committed.results.map(item => [item.candidate_id, item.action]))
    .toEqual([['owner', 'create'], ['reference', 'skip']]);
  expect((await new ContactSearch(h.graph).search({ name: 'Mira Reference' })).items).toEqual([]);
  expect((await new ContactSearch(h.graph).search({ name: 'Lin Vale' })).items).toHaveLength(1);
});

it('rejects a manual import that would create two Person nodes from one file', async () => {
  const h = await harness('file-two-people', [candidate('owner', 'Lin Vale'),
    candidate('reference', 'Mira Reference')]);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-two-people' }, 'reviewer');
  const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  await expect(h.service.commit({ import_id: started.import_id,
    preview_version: ready.version as number,
    operation_id: 'contact-import:' + started.import_id,
    choices: [{ candidate_id: 'owner', action: 'create' },
      { candidate_id: 'reference', action: 'create' }] }, 'reviewer'))
    .rejects.toThrow('MULTIPLE_PERSON_CREATE_FOR_ONE_FILE');
  expect((await new ContactSearch(h.graph).search({ name: 'Lin Vale' })).items).toEqual([]);
  expect((await new ContactSearch(h.graph).search({ name: 'Mira Reference' })).items).toEqual([]);
});

it('rejects ambiguous or missing resume owners before auto-create writes any nodes', async () => {
  for (const [fileId, candidates, code] of [
    ['auto-ambiguous', [candidate('p1', 'Lin Vale'), candidate('p2', 'Mira Chen')], 'AUTO_CREATE_AMBIGUOUS_PERSON'],
    ['auto-missing', [], 'AUTO_CREATE_NO_PERSON'],
  ] as const) {
    const h = await harness(fileId, [...candidates]);
    const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start-' + fileId }, 'reviewer');
    const ready = await waitForStatus(h.service, started.import_id, 'ready_for_review');
    await expect(h.service.commit({ import_id: started.import_id, preview_version: ready.version as number,
      operation_id: 'contact-import:' + started.import_id, auto_create: true }, 'reviewer')).rejects.toThrow(code);
    expect(await h.service.get(started.import_id, 'reviewer')).toMatchObject({ status: 'ready_for_review' });
    expect((await new ContactSearch(h.graph).search({ name: 'Lin Vale' })).items).toEqual([]);
  }
});

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
        quote: '教育经历', page: 1, locator_status: 'located', collected_at: collectedAt }] }],
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
    auto_create: true }, 'reviewer') as {
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


const fact = (field_path: string, value: unknown, block_id: string, quote: string) =>
  ({ field_path, value, evidence: [{ block_id, quote }], uncertain: false });
const link = (block_id: string, quote: string, uncertain = false) => ({ evidence: [{ block_id, quote }], uncertain });
async function extractProfile(profile: object, blocks: Array<{ block_id: string; text: string; page: number }>, fileName = 'invented.pdf') {
  return new DocumentExtractor({ url: 'https://ark.example/chat', model: 'test', credential: 'test',
    fileName, fileSha256: sha, collectedAt,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(profile) } }] })),
  }).extract(blocks, new AbortController().signal);
}

it.each([false, true, 'relation-only'])('auto-commits cross-block schools and summarized skills, anonymous=%s', async anonymous => {
  const extraction = await extractProfile({ subject_status: 'single',
    person: [...(anonymous === 'relation-only' ? [] : [fact('properties.skills', '系统运维', 'p', '使用 Python 开发运维脚本')]),
      ...(anonymous ? [] : [fact('properties.name', '陈晓', 'p', '陈晓')])],
    education: [{ local_id: 'school', organization: [fact('properties.name', '星辰大学', 's', '星辰大学')],
      attendance: link('h', '教育经历') }], employment: [], projects: [], organization_clues: [],
  }, [{ block_id: 'p', text: '陈晓 使用 Python 开发运维脚本', page: 1 },
    { block_id: 'h', text: '教育经历', page: 1 }, { block_id: 's', text: '星辰大学', page: 2 }]);
  const h = await harness(`school-${anonymous}`, extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const input = { import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true };
  const committed = await h.service.commit(input, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
  const saved = await h.graph.request<{ entity: { properties: { skills: string[] } }; relations: unknown[]; evidence: unknown[] }>('get_contact', { entity_id: id });
  expect(saved.entity.properties.skills).toEqual(anonymous === 'relation-only' ? [] : ['系统运维']);
  expect(saved.relations).toHaveLength(1);
  if (anonymous !== 'relation-only') expect(saved.evidence).toContainEqual(expect.objectContaining({ value: '系统运维', quote: '使用 Python 开发运维脚本', file_sha256: sha }));
  expect((await new ContactSearch(h.graph).search({ query: '星辰大学' })).items).toContainEqual(expect.objectContaining({ entity_id: id }));
  expect(await h.service.commit(input, 'reviewer')).toMatchObject({ replayed: true, results: committed.results });
});

it('preserves two employment episodes with summarized role fields', async () => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', 'Riley Moss', 'p', 'Riley Moss')],
    education: [], projects: [], organization_clues: [],
    employment: ['2020', '2022'].map(year => ({ local_id: year,
      organization: [fact('properties.name', 'Cedar Labs', 'o', 'Cedar Labs')],
      employment: link('h', '职业经历'),
      role: [fact('properties.role.startDate', year, year, `${year}年加入`),
        fact('properties.role.roleName', '运维工程师', 'p', '负责服务器维护')] })),
  }, [{ block_id: 'p', text: 'Riley Moss 负责服务器维护', page: 1 }, { block_id: 'o', text: 'Cedar Labs', page: 1 },
    { block_id: 'h', text: '职业经历', page: 1 }, ...['2020', '2022'].map(year => ({ block_id: year, text: `${year}年加入`, page: 2 }))]);
  const person = extraction.candidates.find(item => item.label === 'Person')!;
  expect(person.relation_suggestions).toHaveLength(2);
  const h = await harness('episodes', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === person.candidate_id)!.entity_id;
  const saved = await h.graph.request<{ relations: unknown[] }>('get_contact', { entity_id: id });
  expect(saved.relations).toHaveLength(2);
  expect((await new ContactSearch(h.graph).search({ query: 'Cedar Labs' })).items).toContainEqual(expect.objectContaining({ entity_id: id }));
});

it.each([false, true])('commits legal long Unicode relation evidence with selected=%s', async selected => {
  const prefix = 'Morgan Example works for Cedar Labs ';
  const quote = prefix + '😀'.repeat(491 - [...prefix].length);
  const fileName = 'f'.repeat(100) + '.pdf';
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', 'Morgan Example', 'b1', 'Morgan Example')],
    education: [], projects: [], organization_clues: [], employment: [{ local_id: 'work',
      organization: [fact('properties.name', 'Cedar Labs', 'b1', 'Cedar Labs')], employment: link('b1', quote), role: [] }],
  }, [{ block_id: 'b1', text: quote, page: 1 }], fileName);
  const h = await harness('long-source', extraction.candidates);
  h.file.fileName = fileName;
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const relation = extraction.candidates[0].relation_suggestions[0];
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`,
    choices: extraction.candidates.map(item => ({ candidate_id: item.candidate_id, action: 'create' })),
    relation_choices: selected ? [{ source_candidate_id: relation.source_candidate_id,
      target_candidate_id: relation.target_candidate_id, relation_type: relation.relation_type, properties: relation.properties }] : [],
  }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
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

it.each([[false, false], [true, false], [false, true], [true, true]])('persists each project hop independently: participation weak=%s client weak=%s', async (participationWeak, clientWeak) => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', '项目顾问', 'p', '项目顾问')],
    education: [], employment: [], organization_clues: [], projects: [{ local_id: 'project',
      project: [fact('properties.description', '产品数据管理系统升级', 'j', '完成物料系统改造')],
      participation: link('p', '项目顾问', participationWeak), role: [],
      clients: [{ organization: [fact('properties.name', '乙公司', 'c', '乙公司')], client: link('c', '乙公司', clientWeak) }] }],
  }, [{ block_id: 'p', text: '项目顾问', page: 1 }, { block_id: 'j', text: '完成物料系统改造', page: 2 }, { block_id: 'c', text: '乙公司', page: 3 }]);
  const h = await harness('hops', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const personId = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
  const projectId = committed.results.find(item => item.candidate_id === extraction.candidates.find(c => c.label === 'Project')!.candidate_id)!.entity_id;
  expect(projectId).toMatch(/^j_/);
  const person = await h.graph.request<{ unverified_claims: Array<{ claim_id: string; source: object }> }>('get_contact', { entity_id: personId });
  const project = await h.graph.request<{ entity: { properties: object }; unverified_claims: Array<{ claim_id: string; source: object }> }>('get_contact', { entity_id: projectId });
  expect(project.entity.properties).toMatchObject({ description: '产品数据管理系统升级' });
  const claims = [...person.unverified_claims, ...project.unverified_claims];
  expect(claims).toHaveLength(Number(participationWeak) + Number(clientWeak));
  for (const claim of claims) expect(claim.source).toMatchObject({ file_sha256: sha, file_name: 'invented.pdf' });
  const formal = await new ContactSearch(h.graph).search({ query: '乙公司' });
  expect(formal.items.some(item => item.entity_id === personId)).toBe(!participationWeak && !clientWeak);
  const explicit = await new ContactSearch(h.graph).search({ query: '乙公司', include_unverified: true });
  expect(explicit.items).toContainEqual(expect.objectContaining({ entity_id: personId, matched_project_id: projectId,
    ...(claims.length ? { claim_ids: expect.arrayContaining(claims.map(claim => claim.claim_id)) } : {}) }));
});

it('keeps organization clues unverified and quote failures out of formal edges', async () => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', '陈晓', 'p', '陈晓')],
    education: [{ local_id: 'bad', organization: [fact('properties.name', '星辰大学', 's', '星辰大学')], attendance: link('s', '不存在的引文') }],
    employment: [], projects: [], organization_clues: [{ organization: [fact('properties.name', '名片公司', 'c', '名片公司')], association: link('c', '名片公司') }],
  }, [{ block_id: 'p', text: '陈晓', page: 1 }, { block_id: 's', text: '星辰大学', page: 1 }, { block_id: 'c', text: '名片公司', page: 1 }]);
  const h = await harness('clues', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
  const saved = await h.graph.request<{ relations: unknown[]; unverified_claims: unknown[] }>('get_contact', { entity_id: id });
  expect(saved.relations).toHaveLength(0);
  expect(saved.unverified_claims).toHaveLength(2);
  expect((await new ContactSearch(h.graph).search({ query: '名片公司' })).items.some(item => item.entity_id === id)).toBe(false);
  expect((await new ContactSearch(h.graph).search({ query: '名片公司', include_unverified: true })).items).toContainEqual(expect.objectContaining({ entity_id: id, match_status: 'unverified' }));
});

it('preserves project descriptions and client clues when participation is missing', async () => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', '陈晓', 'p', '陈晓')],
    education: [], employment: [], organization_clues: [], projects: [{ local_id: 'project',
      project: [fact('properties.description', '产品系统升级', 'j', '完成物料系统改造')], role: [],
      clients: [{ organization: [fact('properties.name', '乙公司', 'c', '乙公司')], client: link('c', '乙公司') }] }],
  }, [{ block_id: 'p', text: '陈晓', page: 1 }, { block_id: 'j', text: '完成物料系统改造', page: 2 }, { block_id: 'c', text: '乙公司', page: 3 }]);
  const h = await harness('missing-participation', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
  const saved = await h.graph.request<{ unverified_claims: unknown[] }>('get_contact', { entity_id: id });
  expect(JSON.stringify(saved.unverified_claims)).toContain('产品系统升级');
  const projectId = committed.results.find(item => item.candidate_id === extraction.candidates.find(c => c.label === 'Project')!.candidate_id)!.entity_id;
  const project = await h.graph.request<{ entity: { properties: object }; relations: unknown[] }>('get_contact', { entity_id: projectId });
  expect(project.entity.properties).toMatchObject({ description: '产品系统升级' });
  expect(project.relations).toContainEqual(expect.objectContaining({ relation_type: 'clientOrganization' }));
  expect((await new ContactSearch(h.graph).search({ query: '乙公司', include_unverified: true })).items)
    .toContainEqual(expect.objectContaining({ entity_id: id, matched_project_id: projectId, match_status: 'unverified' }));
  expect(JSON.stringify(saved.unverified_claims)).toContain(sha);
});

it('keeps an unsaveable project and its client clue on the owner review queue', async () => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', '陈晓', 'p', '陈晓')],
    education: [], employment: [], organization_clues: [], projects: [{ local_id: 'weak-project',
      project: [{ ...fact('properties.description', '产品系统升级', 'j', '完成物料系统改造'), uncertain: true }],
      participation: link('j', '完成物料系统改造'), role: [],
      clients: [{ organization: [fact('properties.name', '乙公司', 'c', '乙公司')], client: link('c', '乙公司') }] }],
  }, [{ block_id: 'p', text: '陈晓', page: 1 }, { block_id: 'j', text: '完成物料系统改造', page: 2 }, { block_id: 'c', text: '乙公司', page: 3 }]);
  const h = await harness('unsaveable-project', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(item => item.candidate_id === 'document:person')!.entity_id;
  const saved = await h.graph.request<{ unverified_claims: unknown[] }>('get_contact', { entity_id: id });
  expect(JSON.stringify(saved.unverified_claims)).toContain('产品系统升级');
  expect(JSON.stringify(saved.unverified_claims)).toContain('乙公司');
});

it('rejects caller-authored file evidence in public writes and import corrections', async () => {
  const h = await harness('forged-source');
  const forged = { field_path: 'properties.skills', value: '不存在于引文的资质', source_type: 'file',
    locator_status: 'located', file_name: 'never-uploaded.pdf', file_sha256: sha,
    collected_at: collectedAt, quote: '无关原文' };
  await expect(h.graph.request('save_contact', { operation_id: 'forged-save', actor: 'reviewer', label: 'Person',
    set_properties: { skills: [forged.value] }, evidence: [forged] })).rejects.toThrow('VALIDATION_ERROR');
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  await expect(h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, choices: [{ candidate_id: 'c_1', action: 'create',
      set_properties: { skills: [forged.value] }, evidence: [forged] }] }, 'reviewer')).rejects.toThrow('VALIDATION_ERROR');
});

it('edits an imported summary using persisted evidence without resubmitting file proof', async () => {
  const extraction = await extractProfile({ subject_status: 'single',
    person: [fact('properties.skills', '系统运维', 'p', '开发服务器维护脚本')],
    education: [], employment: [], projects: [], organization_clues: [],
  }, [{ block_id: 'p', text: '开发服务器维护脚本', page: 1 }]);
  const h = await harness('edit-summary', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ entity_id: string }> };
  const id = committed.results[0].entity_id;
  await h.graph.request('save_contact', { operation_id: 'name-summary', actor: 'reviewer', entity_id: id,
    expected_version: 1, label: 'Person', set_properties: { name: '陈晓' }, evidence: [{ field_path: 'properties.name',
      value: '陈晓', source_type: 'manual', locator_status: 'not_applicable', collected_at: collectedAt }] });
  expect(await h.graph.request('get_contact', { entity_id: id })).toMatchObject({
    entity: { properties: { name: '陈晓', skills: ['系统运维'] } },
    evidence: expect.arrayContaining([expect.objectContaining({ source_type: 'file', value: '系统运维', quote: '开发服务器维护脚本' })]),
  });
});

it('retains an uncertain organization name for marked search without creating a formal relation', async () => {
  const extraction = await extractProfile({ subject_status: 'single', person: [fact('properties.name', '本人', 'b', '本人')], education: [], employment: [], projects: [], organization_clues: [{ organization: [{ ...fact('properties.name', '弱公司', 'b', '弱公司'), uncertain: true }], association: link('b', '弱公司', true) }] }, [{ block_id: 'b', text: '本人 弱公司', page: 1 }]);
  const h = await harness('weak-name', extraction.candidates);
  const started = await h.service.start({ file_id: h.file.fileId, operation_id: 'weak-name-start' }, 'reviewer');
  const preview = await waitForStatus(h.service, started.import_id, 'ready_for_review');
  const committed = await h.service.commit({ import_id: started.import_id, preview_version: preview.version as number, operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
  const id = committed.results.find(r => r.candidate_id === 'document:person')!.entity_id;
  const search = new ContactSearch(h.graph);
  expect((await search.search({ query: '弱公司' })).items.some(i => i.entity_id === id)).toBe(false);
  expect((await search.search({ query: '弱公司', include_unverified: true })).items).toContainEqual(expect.objectContaining({ entity_id: id, match_status: 'unverified' }));
  const saved = await h.graph.request<{ relations: unknown[]; unverified_claims: unknown[] }>('get_contact', { entity_id: id });
  expect(saved.relations).toEqual([]);
  expect(saved.unverified_claims).toContainEqual(expect.objectContaining({ field_path: '$organization', status: 'unverified' }));
});
