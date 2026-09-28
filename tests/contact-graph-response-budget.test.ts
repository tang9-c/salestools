import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ContactGraphClient, readCompleteContact } from '../src/contacts/graph-client.js';

const binary = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));
type ContactPage = {
  evidence: Array<{ evidence_id: string }>;
  pagination: { evidence: { total: number; next_offset: number | null } };
};

it('pages accumulated contact evidence without killing the real worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contact-frame-budget-'));
  const graph = new ContactGraphClient({ command: binary, dbPath: join(directory, 'graph.sqlite') });
  try {
    let entityId = '';
    for (let round = 0; round < 8; round++) {
      const saved = await graph.request<{ entity_id: string; version: number }>('save_contact', {
        operation_id: `frame-budget-${round}`, actor: 'tester', label: 'Person',
        ...(entityId ? { entity_id: entityId, expected_version: round } : {}),
        set_properties: { name: 'Robin Vale' },
        evidence: Array.from({ length: 80 }, (_, index) => ({
          evidence_id: `ev_budget_${round}_${index}`,
          field_path: 'properties.name', value: 'Robin Vale',
          source_type: 'manual', locator_status: 'not_applicable',
          collected_at: '2026-09-26T00:00:00Z',
          quote: `${round}-${index} ${'source text '.repeat(35)}`,
        })),
      });
      entityId = saved.entity_id;
      expect(saved.version).toBe(round + 1);
    }

    const allIds = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const page: ContactPage = await graph.request<ContactPage>('get_contact', {
        entity_id: entityId, evidence_offset: offset, evidence_limit: 50,
      });
      expect(page.pagination.evidence.total).toBe(640);
      expect(page.evidence.length).toBeLessThanOrEqual(50);
      for (const item of page.evidence) allIds.add(item.evidence_id);
      offset = page.pagination.evidence.next_offset;
    }
    expect(allIds.size).toBe(640);
    const complete = await readCompleteContact(graph, entityId);
    expect((complete?.evidence as unknown[]).length).toBe(640);
    expect(await graph.request('health', { nonce: 'still-alive' })).toEqual({ nonce: 'still-alive' });
  } finally {
    await graph.close();
    await rm(directory, { recursive: true, force: true });
  }
});


it.each([160, 500])('budgets claims together with evidence and conflicts (source name %i bytes)', async fileNameBytes => {
  const directory = await mkdtemp(join(tmpdir(), 'contact-claim-budget-'));
  const graph = new ContactGraphClient({ command: binary, dbPath: join(directory, 'graph.sqlite') });
  const proof = (value: string) => ({ field_path: 'properties.name', value, source_type: 'manual',
    locator_status: 'not_applicable', collected_at: '2026-09-26T00:00:00Z' });
  type Page = { evidence: Array<{ evidence_id: string }>; conflicts: Array<{ evidence_id: string }>;
    relations: unknown[]; unverified_claims: Array<{ claim_id: string }>;
    pagination: Record<'evidence' | 'relations' | 'unverified_claims', { total: number; next_offset: number | null }> };
  try {
    const saved = await graph.request<{ entity_id: string }>('save_contact', {
      operation_id: 'old', actor: 'tester', label: 'Person', set_properties: { name: 'old' },
      evidence: Array.from({ length: 50 }, (_, index) => ({ ...proof('old'), evidence_id: `ev_old_${index}`,
        quote: '😀'.repeat(500), file_name: 'f'.repeat(fileNameBytes) })),
    });
    const entityId = saved.entity_id;
    await graph.request('save_contact', { operation_id: 'new', actor: 'tester', label: 'Person',
      entity_id: entityId, expected_version: 1, set_properties: { name: 'new' }, evidence: [proof('new')] });
    if (fileNameBytes === 160) {
      const before = await graph.request('get_contact', { entity_id: entityId });
      expect(Buffer.byteLength(JSON.stringify(before))).toBeGreaterThan(240_000);
    }
    const started = await graph.request<{ import_id: string }>('put_import_job', {
      operation_id: 'start', actor: 'tester', file_id: 'synthetic', status: 'queued', data: { candidates: [] },
    });
    await graph.request('put_import_job', { operation_id: 'ready', actor: 'system',
      file_id: 'synthetic', import_id: started.import_id, expected_version: 1, status: 'ready_for_review',
      data: { candidates: [{ candidate_id: 'person', label: 'Person', properties: { name: 'new' },
        evidence: [proof('new')], can_commit: true,
        review_items: Array.from({ length: 10 }, (_, index) => ({ kind: 'field', field_path: 'properties.skills',
          value: `skill-${index}`, reason: 'missing_evidence', page: 1, quote: '例'.repeat(500) })),
      }] },
    });
    await graph.request('commit_import', { operation_id: `contact-import:${started.import_id}`, actor: 'tester',
      import_id: started.import_id, expected_version: 2,
      choices: [{ candidate_id: 'person', action: 'merge', target_id: entityId, expected_target_version: 2 }],
    });
    const first = await graph.request<Page>('get_contact', { entity_id: entityId });
    expect(first.unverified_claims.length).toBeGreaterThan(0);
    expect(first.pagination.unverified_claims.total).toBe(10);
    expect(first.pagination.evidence.total).toBe(52);
    const evidenceIds = new Set<string>();
    const claimIds = new Set<string>();
    let page = first;
    for (let index = 0; ; index++) {
      expect(index).toBeLessThan(52);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      page.evidence.forEach(item => evidenceIds.add(item.evidence_id));
      page.unverified_claims.forEach(item => claimIds.add(item.claim_id));
      expect(page.conflicts.every(item => page.evidence.some(proof => proof.evidence_id === item.evidence_id))).toBe(true);
      const { evidence, unverified_claims: claims } = page.pagination;
      if (evidence.next_offset === null && claims.next_offset === null) break;
      page = await graph.request<Page>('get_contact', { entity_id: entityId,
        evidence_offset: evidence.next_offset ?? evidence.total, claim_offset: claims.next_offset ?? claims.total });
    }
    expect(evidenceIds.size).toBe(52);
    expect(claimIds.size).toBe(10);
    const disabled = await graph.request<Page>('get_contact', { entity_id: entityId, claim_limit: 0 });
    expect(disabled.unverified_claims).toEqual([]);
    expect(disabled.pagination.unverified_claims).toMatchObject({ total: 10, next_offset: null });
    const requests = vi.spyOn(graph, 'request');
    const complete = await readCompleteContact(graph, entityId);
    expect((complete?.evidence as unknown[]).length).toBe(52);
    expect(complete?.unverified_claims).toEqual([]);
    expect(requests.mock.calls.filter(([op]) => op === 'get_contact').length).toBeGreaterThan(1);
    expect(requests.mock.calls.filter(([op]) => op === 'get_contact').every(([, payload]) => (payload as Record<string, unknown>).claim_limit === 0)).toBe(true);
    expect(await graph.request('health', { nonce: 'after-claims' })).toEqual({ nonce: 'after-claims' });
  } finally {
    await graph.close();
    await rm(directory, { recursive: true, force: true });
  }
});
