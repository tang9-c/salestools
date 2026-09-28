import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { UploadStore } from '../src/contacts/upload-store.js';
import { parseLocalDocument } from '../src/contacts/document-worker.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { ContactAnswerService } from '../src/contacts/contact-answer.js';
import type { ImportCandidate, ParsedBlock } from '../src/contracts/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Invented fixture; only the nondeterministic model boundary is replaced.
function modelCandidates(blocks: ParsedBlock[]) {
  const proof = (quote: string, field_path?: string, value?: unknown) => ({
    block_id: blocks.find(block => block.text.includes(quote))!.block_id, quote,
    ...(field_path ? { field_path, value } : {}),
  });
  const org = (candidate_id: string, name: string) => ({ candidate_id, label: 'Organization',
    properties: { name }, evidence: [proof(name, 'properties.name', name)] });
  return [
    { candidate_id: 'person', label: 'Person', properties: { name: 'Riley Example',
      telephone: ['+15550100999'], skills: ['Python', 'Unproven Kubernetes'], jobTitle: 'Solutions Architect' },
    evidence: [proof('Riley Example', 'properties.name', 'Riley Example'),
      proof('Mobile: +15550100999', 'properties.telephone', '+15550100999'),
      proof('Skills: Python', 'properties.skills', ['Python']),
      proof('Desired position: Solutions Architect', 'properties.jobTitle', 'Solutions Architect')],
    relation_suggestions: [
      ...['2020', '2022'].map(startDate => ({ source_candidate_id: 'person', target_candidate_id: 'employer',
        relation_type: 'worksFor', uncertain: false, properties: { role: { '@type': 'OrganizationRole', startDate } },
        evidence: [proof(`Riley Example works for Cedar Example Labs ${startDate}`),
          proof(`Riley Example works for Cedar Example Labs ${startDate}`, 'properties.role.startDate', startDate)] })),
      { source_candidate_id: 'person', target_candidate_id: 'school', relation_type: 'alumniOf',
        uncertain: false, properties: {}, evidence: [proof('Willow Example Academy')] },
      { source_candidate_id: 'person', target_candidate_id: 'client', relation_type: 'worksFor',
        uncertain: false, properties: { role: { '@type': 'OrganizationRole' } },
        evidence: [proof('Customer: Maple Example Client')] },
    ] }, org('employer', 'Cedar Example Labs'), org('school', 'Willow Example Academy'),
    org('client', 'Maple Example Client'),
  ];
}

type Detail = { entity: { metadata: { version: number }; properties: Record<string, unknown> };
  relations: Array<{ relation_type: string; target_id: string }>;
  evidence: Array<{ source_type: string; quote?: string }>;
  unverified_claims: Array<{ claim_id: string; kind: string; field_path?: string; relation_type?: string; target_id?: string; status: string }> };

it('keeps resume clues through upload, parsing, commit, opt-in lookup and explicit review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recall-acceptance-'));
  const graph = new ContactGraphClient({ command: join(root, 'rust/contact-graph/target/debug/contact-graph'),
    dbPath: join(directory, 'graph.sqlite') });
  const uploads = new UploadStore({ directory: join(directory, 'uploads'), maxPendingFiles: 2,
    maxFileBytes: 1_000_000, maxTempBytes: 2_000_000 });
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 90_000, release: id => uploads.release(id) });
  const service = new ContactImportService({ graph, uploads, jobs,
    parse: (file, signal) => parseLocalDocument({ pythonBin: join(root, 'python/.venv/bin/python'),
      projectDir: join(root, 'python'), filePath: file.tempPath, fileType: 'pdf', documentId: file.fileId, limits: {} }, signal),
    extract: (blocks, file, signal) => new DocumentExtractor({ url: 'https://model.example/chat', model: 'fixture',
      credential: 'fixture', fileName: file.fileName, fileSha256: file.sha256, collectedAt: file.uploadedAt,
      fetchFn: async (_url, init) => new Response(JSON.stringify({ choices: [{ message: {
        content: JSON.stringify({ candidates: modelCandidates(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).blocks) }) } }] })) }).extract(blocks, signal),
  });
  try {
    const fileId = await uploads.reserve();
    const file = await uploads.receive(fileId, createReadStream(join(root, 'tests/fixtures/contact-documents/recall-acceptance.pdf')), 'recall-acceptance.pdf');
    await uploads.preflight(file);
    const started = await service.start({ file_id: fileId, operation_id: 'acceptance-start' }, 'reviewer');
    let preview = await service.get(started.import_id, 'reviewer');
    for (let n = 0; n < 900 && preview?.status !== 'ready_for_review'; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      preview = await service.get(started.import_id, 'reviewer');
      if (preview?.status === 'failed') break;
    }
    expect(preview?.status).toBe('ready_for_review');
    const candidates = preview!.candidates as ImportCandidate[];
    const people = candidates.filter(item => item.label === 'Person');
    expect(people).toHaveLength(1);
    const person = people[0]!;
    expect(person.properties).toMatchObject({ name: 'Riley Example', telephone: ['+15550100999'], skills: ['Python'] });
    expect(person.properties).not.toHaveProperty('jobTitle');
    expect(person.review_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ field_path: 'properties.skills', value: 'Unproven Kubernetes', reason: 'missing_evidence' }),
      expect.objectContaining({ field_path: 'properties.jobTitle', reason: 'ambiguous_context' }),
    ]));
    expect(person.relation_suggestions.filter(item => item.relation_type === 'worksFor')).toHaveLength(2);
    expect(person.relation_suggestions.find(item => item.relation_type === 'alumniOf'))
      .toMatchObject({ uncertain: true, review_reason: 'structured_heading' });
    const input = { import_id: started.import_id, preview_version: preview!.version as number,
      operation_id: `contact-import:${started.import_id}`,
      choices: candidates.map(item => ({ candidate_id: item.candidate_id, action: 'create' })), relation_choices: [] };
    const committed = await service.commit(input, 'reviewer') as { results: Array<{ candidate_id: string; entity_id: string }> };
    const id = committed.results.find(item => item.candidate_id === person.candidate_id)!.entity_id;
    const get = () => graph.request<Detail>('get_contact', { entity_id: id });
    const saved = await get();
    expect(saved.relations).toEqual([]);
    expect(saved.unverified_claims.length).toBeGreaterThanOrEqual(5);
    expect(saved.entity.properties.skills).toEqual(['Python']);
    expect((await service.get(started.import_id, 'reviewer'))!.candidates).toEqual(candidates);
    await service.commit(input, 'reviewer');
    expect((await get()).unverified_claims).toEqual(saved.unverified_claims);
    // A reviewer explicitly merges a separate anonymous fragment; its clue must
    // survive under the named survivor without becoming an official field.
    const fragmentId = 'manual-fragment';
    const skillProof = person.evidence.find(proof => proof.field_path === 'properties.skills')!;
    const fragment = { candidate_id: fragmentId, label: 'Person', properties: { skills: ['Python'] },
      extensions: { hobbies: [], instantMessaging: [] },
      evidence: [{ ...skillProof, evidence_id: 'fragment-skill-proof', subject_id: fragmentId }],
      relation_suggestions: [], warnings: [], can_commit: true,
      review_items: [{ kind: 'field', field_path: 'properties.skills', value: 'Merge-only skill', reason: 'missing_evidence' }] };
    const fragmentJob = await graph.request<{ import_id: string }>('put_import_job', {
      operation_id: 'fragment-start', actor: 'reviewer', file_id: 'invented-fragment-file',
      status: 'queued', data: { candidates: [] } });
    await graph.request('put_import_job', { operation_id: 'fragment-ready', actor: 'reviewer',
      file_id: 'invented-fragment-file', import_id: fragmentJob.import_id, expected_version: 1,
      status: 'ready_for_review', data: { candidates: [fragment] } });
    const fragmentCommit = await graph.request<{ results: Array<{ entity_id: string }> }>('commit_import', {
      operation_id: `contact-import:${fragmentJob.import_id}`, actor: 'reviewer', import_id: fragmentJob.import_id,
      expected_version: 2, choices: [{ candidate_id: fragmentId, action: 'create' }], relation_choices: [] });
    const oldId = fragmentCommit.results[0].entity_id;
    const fragmentSaved = await graph.request<Detail>('get_contact', { entity_id: oldId });
    const movedClaimId = fragmentSaved.unverified_claims[0].claim_id;
    await graph.request('merge_contacts', { operation_id: 'reviewer-merges-fragment', actor: 'reviewer',
      source_id: oldId, target_id: id, expected_source_version: fragmentSaved.entity.metadata.version,
      expected_target_version: (await get()).entity.metadata.version, field_choices: {} });
    const merged = await get();
    expect(merged.unverified_claims).toHaveLength(saved.unverified_claims.length + 1);
    expect(merged.unverified_claims).toContainEqual(expect.objectContaining({ claim_id: movedClaimId, subject_id: id }));
    expect(merged.entity.properties.skills).toEqual(['Python']);
    const search = new ContactSearch(graph);
    expect((await search.search({ query: 'Merge-only skill' })).items).toEqual([]);
    expect((await search.search({ query: 'Merge-only skill', include_unverified: true })).items)
      .toEqual([expect.objectContaining({ entity_id: id, claim_id: movedClaimId, match_status: 'unverified' })]);
    const answer = new ContactAnswerService({ graph, resolvePeople: async () => [] });
    for (const query of ['Unproven Kubernetes', 'Solutions Architect', 'Willow Example Academy', 'Cedar Example Labs']) {
      expect((await search.search({ query })).items.some(item => item.entity_id === id)).toBe(false);
      expect((await search.search({ query, include_unverified: true })).items)
        .toContainEqual(expect.objectContaining({ entity_id: id, match_status: 'unverified', claim_id: expect.any(String) }));
    }
    expect(await answer.ask({ entity_id: id, question: '在哪家公司工作？' })).toMatchObject({ status: 'insufficient', citations: [] });
    const skill = saved.unverified_claims.find(item => item.field_path === 'properties.skills')!;
    await graph.request('review_contact_claim', { claim_id: skill.claim_id, action: 'reject',
      operation_id: 'reject-skill', expected_entity_version: (await get()).entity.metadata.version, actor: 'reviewer' });
    expect((await search.search({ query: 'Unproven Kubernetes', include_unverified: true })).items).toEqual([]);
    const employment = saved.unverified_claims.filter(item => item.relation_type === 'worksFor'
      && item.target_id === committed.results.find(item => item.candidate_id.endsWith(':employer'))!.entity_id);
    expect(employment).toHaveLength(2);
    for (const claim of employment) {
      const current = await get();
      await graph.request('review_contact_claim', { claim_id: claim.claim_id, action: 'confirm',
        operation_id: `confirm-${claim.claim_id}`, expected_entity_version: current.entity.metadata.version,
        confirmation_note: 'Riley Example works for Cedar Example Labs; manually checked this employment episode.', actor: 'reviewer' });
    }
    expect((await get()).relations).toHaveLength(2);
    expect((await search.search({ query: 'Cedar Example Labs' })).items).toContainEqual(expect.objectContaining({ entity_id: id }));
    const answered = await answer.ask({ entity_id: id, question: '在哪家公司工作？' });
    expect(answered.status).toBe('answered');
    expect(answered.citations).toHaveLength(2);
    expect(answered.citations.every(item => item.file_name === undefined && item.quote.includes('manually checked'))).toBe(true);
    expect(await answer.ask({ entity_id: id, question: '就读哪所学校？' })).toMatchObject({ status: 'insufficient', citations: [] });
  } finally {
    await jobs.recover(); await uploads.close(); await graph.close(); await rm(directory, { recursive: true, force: true });
  }
}, 120_000);


it.each([
  ['empty', JSON.stringify({ candidates: [] }), '未提取到联系人候选'],
  ['invalid', '{broken', '模型响应无效'],
])('shows a useful warning and no candidates for %s model output', async (_case, content, warning) => {
  const extraction = await new DocumentExtractor({ url: 'https://model.example/chat', model: 'fixture',
    credential: 'fixture', fileName: 'invented.pdf', fileSha256: 'a'.repeat(64),
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })),
  }).extract([{ block_id: 'one', text: 'Invented resume with no usable person', page: 1 }], new AbortController().signal);
  expect(extraction.candidates).toEqual([]);
  expect(extraction.warnings).toContain(warning);
});
