import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import { acceptanceHarness, acceptanceBudgetOptions, fixtureProfile, root, type Detail } from './contact-acceptance-support.js';
const stub = (card = false) => ({ url: 'https://model.example/chat', model: 'fixture', credential: 'fixture', fetchFn: (async (_url, init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixtureProfile(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).blocks, card)) } }] }))) as typeof fetch });

it.each(['layout-single-column.pdf', 'layout-two-column.pdf'])('commits real Docling %s through profile mapping and SQLite', async filename => {
  const h = await acceptanceHarness(join(root, 'tests/fixtures/contact-documents', filename), stub());
  try {
    expect(h.preview.status, JSON.stringify(h.preview.failure)).toBe('ready_for_review');
    expect(h.candidates.filter(c => c.label === 'Person')).toHaveLength(1);
    expect(h.candidates.some(c => c.properties.name === 'Elm Example Company')).toBe(false);
    const result = await h.commit();
    const id = result.results.find(r => r.candidate_id === 'document:person')!.entity_id;
    const get = () => h.graph.request<Detail>('get_contact', { entity_id: id });
    const saved = await get();
    if (filename === 'layout-two-column.pdf') {
      const school = h.candidates.find(c => c.properties.name === 'Birch Example University')!;
      const schoolId = result.results.find(r => r.candidate_id === school.candidate_id)!.entity_id;
      const schoolDetail = await h.graph.request<Detail>('get_contact', { entity_id: schoolId });
      expect(schoolDetail.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'Birch Example University', quote: 'Birch Example' }),
        expect.objectContaining({ value: 'Birch Example University', quote: 'University, since 2024.' }),
      ]));
    }
    expect(saved.entity.properties).toMatchObject({ name: 'Riley Example', telephone: ['+15550100999', '+15550100888'], email: ['riley@example.test', 'riley.work@example.test'], skills: ['Python', 'Linux operations'] });
    expect(saved.entity.properties.jobTitle).toBeUndefined();
    expect(saved.entity.properties.hasCredential).toEqual([]);
    expect(saved.relations.filter(r => r.relation_type === 'worksFor')).toHaveLength(2);
    expect(saved.relations.filter(r => r.relation_type === 'alumniOf')).toHaveLength(2);
    expect(saved.relations.filter(r => r.relation_type === 'memberOf')).toHaveLength(2);
    expect(saved.evidence).toContainEqual(expect.objectContaining({ value: 'Linux operations', quote: 'Linux maintenance', source_type: 'file' }));
    const search = new ContactSearch(h.graph);
    for (const query of ['Willow Example Academy', 'Birch Example University', 'Cedar Example Labs', 'Maple Example Client']) expect((await search.search({ query })).items).toContainEqual(expect.objectContaining({ entity_id: id }));
    for (const query of ['Ash Example Client', 'Spruce Example Network', 'Solutions Architect']) {
      expect((await search.search({ query })).items.some(i => i.entity_id === id)).toBe(false);
      expect((await search.search({ query, include_unverified: true })).items).toContainEqual(expect.objectContaining({ entity_id: id, match_status: 'unverified' }));
    }
    for (const [project, client] of [['Project Aurora', 'Maple Example Client'], ['Project Beacon', 'Ash Example Client']]) {
      const pc = h.candidates.find(c => c.label === 'Project' && c.properties.name === project)!;
      const detail = await h.graph.request<Detail>('get_contact', { entity_id: result.results.find(r => r.candidate_id === pc.candidate_id)!.entity_id });
      const target = h.candidates.find(c => c.properties.name === client)!;
      const targetId = result.results.find(r => r.candidate_id === target.candidate_id)!.entity_id;
      expect([...detail.relations, ...detail.unverified_claims].filter(r => r.relation_type === 'clientOrganization')).toEqual([expect.objectContaining({ target_id: targetId })]);
    }
    expect(await h.commit()).toMatchObject({ replayed: true, results: result.results });
    const claim = saved.unverified_claims.find(c => c.field_path === 'properties.jobTitle')!;
    const pages = [];
    for (let offset = 0; offset < saved.unverified_claims.length; offset++) pages.push(...(await h.graph.request<Detail>('get_contact', { entity_id: id, claim_offset: offset, claim_limit: 1 })).unverified_claims);
    expect(pages).toContainEqual(expect.objectContaining({ claim_id: claim.claim_id }));
    await h.graph.request('review_contact_claim', { claim_id: claim.claim_id, action: 'reject', operation_id: 'reject-intent', expected_entity_version: (await get()).entity.metadata.version, actor: 'acceptance' });
    expect((await search.search({ query: 'Solutions Architect', include_unverified: true })).items).toEqual([]);
    const affiliation = (await get()).unverified_claims.find(c => c.relation_type === 'affiliation')!;
    await h.graph.request('review_contact_claim', { claim_id: affiliation.claim_id, action: 'confirm', confirmation_note: 'Confirmed invented affiliation', operation_id: 'confirm-affiliation', expected_entity_version: (await get()).entity.metadata.version, actor: 'acceptance' });
    expect((await get()).relations).toContainEqual(expect.objectContaining({ relation_type: 'affiliation', target_id: affiliation.target_id }));
    expect((await get()).unverified_claims.some(c => c.claim_id === affiliation.claim_id)).toBe(false);
    await h.graph.request('save_contact', { entity_id: id, expected_version: (await get()).entity.metadata.version, operation_id: 'correct-name', actor: 'acceptance', label: 'Person', set_properties: { name: 'Riley Corrected' }, evidence: [{ field_path: 'properties.name', value: 'Riley Corrected', source_type: 'manual', locator_status: 'not_applicable', collected_at: new Date().toISOString() }] });
    expect((await get()).entity.properties.name).toBe('Riley Corrected');
  } finally { await h.close(); }
}, 120_000);

it('preserves an OCR card organization as a marked association', async () => {
  const h = await acceptanceHarness(join(root, 'tests/fixtures/contact-documents/synthetic-card.png'), stub(true));
  try {
    expect(h.preview.status).toBe('ready_for_review');
    const result = await h.commit();
    const id = result.results.find(r => r.candidate_id === 'document:person')!.entity_id;
    const saved = await h.graph.request<Detail>('get_contact', { entity_id: id });
    expect(saved.entity.properties.name).toBe('Robin Vale');
    expect(saved.relations).toEqual([]);
    expect((await new ContactSearch(h.graph).search({ query: 'Sample Studio', include_unverified: true })).items).toContainEqual(expect.objectContaining({ entity_id: id, match_status: 'unverified' }));
  } finally { await h.close(); }
}, 120_000);

it.each([['empty', JSON.stringify({ subject_status: 'absent', person: [], education: [], employment: [], projects: [], organization_clues: [] }), '未提取到联系人候选'], ['invalid', '{broken', '模型响应无效']])('reports %s model output without inventing saved facts', async (_case, content, warning) => {
  const result = await new DocumentExtractor({ ...stub(), fileName: 'invented.pdf', fileSha256: 'a'.repeat(64), fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })) }).extract([{ block_id: 'one', text: 'Invented resume', page: 1 }], new AbortController().signal);
  expect(result.candidates).toEqual([]);
  expect(result.warnings).toContain(warning);
});

it('keeps the live runner budget default and validates explicit byte overrides', () => {
  expect(acceptanceBudgetOptions(undefined)).toEqual({});
  expect(acceptanceBudgetOptions('20000')).toEqual({ requestMaxBytes: 20000 });
  for (const invalid of ['', '0', '-1', '12.5', 'not-a-number', 'Infinity', '9007199254740992']) {
    expect(() => acceptanceBudgetOptions(invalid)).toThrow('INVALID_ACCEPTANCE_REQUEST_MAX_BYTES');
  }
});
