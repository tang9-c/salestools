import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { ContactAnswerService } from '../src/contacts/contact-answer.js';
import { buildEmbeddingText } from '../src/contacts/vector-indexer.js';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { registerContactTools } from '../src/mcp/contact-tools.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const proof = (path: string, value: unknown) => ({ field_path: path, value, source_type: 'manual',
  locator_status: 'not_applicable', collected_at: '2026-09-26T00:00:00Z' });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'claim-review-'));
  const graph = new ContactGraphClient({ command: fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url)), dbPath: join(dir, 'graph.db') });
  cleanup.push(async () => { await graph.close(); await rm(dir, { recursive: true, force: true }); });
  const jobs = await graph.request<{ import_id: string }>('put_import_job', { operation_id: 'start', actor: 'tester', file_id: 'synthetic', status: 'queued', data: {} });
  await graph.request('put_import_job', { operation_id: 'ready', actor: 'tester', file_id: 'synthetic', import_id: jobs.import_id, expected_version: 1, status: 'ready_for_review', data: { candidates: [
    { candidate_id: 'person', label: 'Person', properties: { name: 'Synthetic Person' }, evidence: [proof('properties.name', 'Synthetic Person')], can_commit: true,
      review_items: [ { kind: 'field', field_path: 'properties.skills', value: 'Rust', reason: 'missing_evidence' },
        { kind: 'field', field_path: 'properties.birthDate', value: '1990-01-01', reason: 'missing_evidence' },
        { kind: 'field', field_path: 'properties.skills', value: 'RejectNeedle', reason: 'missing_evidence' },
        { kind: 'relation', relation_type: 'worksFor', source_candidate_id: 'person', target_candidate_id: 'org', properties: { role: { '@type': 'OrganizationRole', roleName: 'Engineer', startDate: '2020' } }, reason: 'missing_evidence' },
        { kind: 'relation', relation_type: 'alumniOf', source_candidate_id: 'person', target_candidate_id: 'org', properties: {}, reason: 'missing_evidence' } ] },
    { candidate_id: 'org', label: 'Organization', properties: { name: 'Synthetic Org' }, evidence: [proof('properties.name', 'Synthetic Org')], can_commit: true },
  ] } });
  const committed = await graph.request<{ results: Array<{ entity_id: string }> }>('commit_import', { operation_id: `contact-import:${jobs.import_id}`, actor: 'tester', import_id: jobs.import_id, expected_version: 2, choices: [{ candidate_id: 'person', action: 'create' }, { candidate_id: 'org', action: 'create' }] });
  const person = committed.results[0].entity_id;
  const claims = (await graph.request<{ unverified_claims: Array<{ claim_id: string; value: unknown; relation_type?: string }> }>('get_contact', { entity_id: person })).unverified_claims;
  const indexed: string[] = [];
  const library = new ContactLibraryService(graph, id => { indexed.push(id); });
  return { graph, library, person, claims, indexed };
}

it('confirms through real Node library and worker, isolates Q&A, and schedules only relevant facts', async () => {
  const h = await setup();
  const ask = new ContactAnswerService({ graph: h.graph, resolvePeople: async () => [] });
  expect((await ask.ask({ entity_id: h.person, question: '在哪家公司工作？' })).status).toBe('insufficient');
  const work = h.claims.find(c => c.relation_type === 'worksFor')!;
  const input = { claim_id: work.claim_id, action: 'confirm', operation_id: 'confirm-work', expected_entity_version: 1,
    confirmation_note: 'Synthetic Person 在 Synthetic Org 任职 Engineer，自 2020 年开始。' };
  expect(await h.library.reviewClaim(input, 'reviewer')).toMatchObject({ status: 'confirmed', version: 2 });
  await expect.poll(() => h.indexed.length).toBe(1);
  const answer = await ask.ask({ entity_id: h.person, question: '在哪家公司工作？' });
  expect(answer.status).toBe('answered'); expect(answer.answer).toContain('Synthetic Org');
  expect(answer.citations[0].quote).toBe(input.confirmation_note);
  expect(answer.citations[0].file_name).toBeUndefined();
  expect(await h.library.reviewClaim(input, 'reviewer')).toMatchObject({ replayed: true });
  await expect.poll(() => h.indexed.length).toBe(2);
  const reject = h.claims.find(c => c.value === 'RejectNeedle')!;
  expect(await h.library.reviewClaim({ claim_id: reject.claim_id, action: 'reject', operation_id: 'reject', expected_entity_version: 2 }, 'reviewer')).toMatchObject({ status: 'rejected', version: 3 });
  expect((await new ContactSearch(h.graph).search({ query: 'RejectNeedle', include_unverified: true })).total).toBe(0);
  expect(h.indexed).toEqual([h.person, h.person]);
  const school = h.claims.find(c => c.relation_type === 'alumniOf')!;
  await h.library.reviewClaim({ claim_id: school.claim_id, action: 'confirm', operation_id: 'school', expected_entity_version: 3, confirmation_note: 'Synthetic Person 就读 Synthetic Org。' }, 'reviewer');
  expect((await ask.ask({ entity_id: h.person, question: '就读哪里？' })).status).toBe('answered');
  expect(h.indexed).toEqual([h.person, h.person]);
  const skill = h.claims.find(c => c.value === 'Rust')!;
  await h.library.reviewClaim({ claim_id: skill.claim_id, action: 'confirm', operation_id: 'skill', expected_entity_version: 4, confirmation_note: 'Confirmed Rust skill', actor: 'forged' }, 'reviewer');
  await expect.poll(() => h.indexed.length).toBe(3);
  const detail = await h.library.get(h.person);
  expect(detail!.evidence).toContainEqual(expect.objectContaining({ field_path: 'properties.skills', source_type: 'manual', confirmed_by: 'reviewer' }));
  expect((await new ContactSearch(h.graph).search({ query: 'Rust', include_unverified: true })).items).toContainEqual(expect.objectContaining({ entity_id: h.person, match_status: 'confirmed' }));
});

it('MCP review enforces authenticated actor, note and strict arguments before real writes', async () => {
  const h = await setup();
  type Tool = { schema: z.ZodType; handler: (input: Record<string, unknown>, context: { http?: { authInfo?: { clientId?: string } } }) => Promise<unknown> };
  const tools = new Map<string, Tool>();
  registerContactTools({ registerTool(name: string, config: { inputSchema: z.ZodType }, handler: Tool['handler']) { tools.set(name, { schema: config.inputSchema, handler }); } } as unknown as McpServer, h.library);
  expect(tools.has('review_contact_claim')).toBe(true);
  const tool = tools.get('review_contact_claim')!;
  const input = { claim_id: h.claims.find(c => c.value === 'Rust')!.claim_id, action: 'confirm', operation_id: 'mcp-review', expected_entity_version: 1, confirmation_note: 'Confirmed skill' };
  for (const patch of [{ actor: 'forged' }, { confirmation_note: '' }, { confirmation_note: undefined }, { confirmation_note: 'a'.repeat(501) }, { action: 'other' }, { expected_entity_version: 0 }]) {
    expect(tool.schema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
  await expect(tool.handler(input, {})).rejects.toThrow('Authenticated');
  const parsed = tool.schema.parse(input) as Record<string, unknown>;
  expect(await tool.handler(parsed, { http: { authInfo: { clientId: 'mcp-reviewer' } } })).toMatchObject({ structuredContent: { status: 'confirmed' } });
  const detail = await h.library.get(h.person);
  expect(detail!.evidence).toContainEqual(expect.objectContaining({ field_path: 'properties.skills', confirmed_by: 'mcp-reviewer' }));
});

it('recovers index scheduling when the committed review response was lost', async () => {
  const h = await setup();
  const input = { claim_id: h.claims.find(c => c.value === 'Rust')!.claim_id, action: 'confirm',
    operation_id: 'lost-response', expected_entity_version: 1, confirmation_note: 'Confirmed Rust' };
  await h.graph.request('review_contact_claim', { ...input, actor: 'reviewer' });
  expect(h.indexed).toEqual([]);
  expect(await h.library.reviewClaim(input, 'reviewer')).toMatchObject({ replayed: true });
  await expect.poll(() => h.indexed).toEqual([h.person]);
});

it('keeps ready vectors and skips scheduling for unchanged skills and nonindexed fields', async () => {
  const h = await setup();
  await h.graph.request('save_contact', { operation_id: 'existing-skill', actor: 'tester', label: 'Person', entity_id: h.person, expected_version: 1,
    set_properties: { skills: ['Rust'] }, evidence: [proof('properties.skills', 'Rust')] });
  const initial = await h.library.get(h.person);
  const version = initial!.index_content_version;
  await h.graph.request('set_vector_state', { operation_id: 'pending', actor: 'system', action: 'set', entity_id: h.person, content_version: version, state: 'pending' });
  await h.graph.request('put_vector', { operation_id: 'vector-ready', actor: 'system', entity_id: h.person, content_version: version, model: 'synthetic', dimension: 2, vector: [1, 0] });
  for (const [value, entityVersion] of [['Rust', 2], ['1990-01-01', 3]] as const) {
    const claim = h.claims.find(c => c.value === value)!;
    const out = await h.library.reviewClaim({ claim_id: claim.claim_id, action: 'confirm', operation_id: `review-${entityVersion}`, expected_entity_version: entityVersion, confirmation_note: 'Checked with subject' }, 'reviewer');
    expect(out).toMatchObject({ status: 'confirmed', version: entityVersion + 1 });
    expect(out).not.toHaveProperty('indexed_entity_id');
    const after = await h.library.get(h.person);
    expect(after).toMatchObject({ index_status: 'ready', index_content_version: version });
    expect(buildEmbeddingText(after)).toBe(buildEmbeddingText(initial));
    expect(await h.graph.request('search_vector', { model: 'synthetic', dimension: 2, vector: [1, 0] })).toMatchObject({ total: 1 });
  }
  expect(h.indexed).toEqual([]);
  const changed = { claim_id: h.claims.find(c => c.value === 'RejectNeedle')!.claim_id, action: 'confirm', corrected_value: 'SQL',
    operation_id: 'new-skill-lost-response', expected_entity_version: 4, confirmation_note: 'Confirmed SQL' };
  await h.graph.request('review_contact_claim', { ...changed, actor: 'reviewer' });
  expect(await h.library.get(h.person)).toMatchObject({ index_status: 'unindexed' });
  expect(await h.graph.request('search_vector', { model: 'synthetic', dimension: 2, vector: [1, 0] })).toMatchObject({ total: 0 });
  expect(await h.library.reviewClaim(changed, 'reviewer')).toMatchObject({ replayed: true });
  await expect.poll(() => h.indexed).toEqual([h.person]);
});
