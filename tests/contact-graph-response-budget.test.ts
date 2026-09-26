import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
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
