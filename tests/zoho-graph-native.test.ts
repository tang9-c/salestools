import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { queryRuntime } from './helpers/zoho-graph-query.js';

// Only the remote workflow builds this binary from the checked-out source.
it.skipIf(process.env.CONTACT_UPLOAD_BUNDLE_REQUIRED !== '1')('queries synthetic CRM into the real Rust graph and preserves idempotence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zoho-graph-native-'));
  const graph = new ContactGraphClient({ command: fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url)), dbPath: join(directory, 'graph.sqlite') });
  let session: Awaited<ReturnType<typeof queryRuntime>> | undefined;
  try {
    session = await queryRuntime(graph, true);
    const { client, query } = session;
    const first = await query();
    expect(first.structuredContent).toMatchObject({ zoho: { status: 'completed', complete: true } });
    const search = await client.callTool({ name: 'search_contacts', arguments: { name: '合成人员', mode: 'keyword' } });
    const page = search.structuredContent as { items: Array<{ entity_id: string }> };
    expect(page.items).toHaveLength(1);
    const id = page.items[0]!.entity_id;
    const loaded = await client.callTool({ name: 'get_contact', arguments: { entity_id: id } });
    const detail = loaded.structuredContent as Record<string, unknown>;
    expect(detail).toMatchObject({ entity: { properties: { name: '合成人员', jobTitle: '经理' } } });
    expect(detail.relations).toEqual(expect.arrayContaining([expect.objectContaining({ relation_type: 'worksFor',
      metadata: expect.objectContaining({ employment_status: 'unknown' }) })]));
    expect(detail.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source_type: 'zoho',
      source_connection_id: 'crm_a', source_module: 'Contacts', source_record_id: 'p' })]));
    const before = await graph.request('get_contact', { entity_id: id });
    const second = await query();
    expect(JSON.stringify(second.content)).toContain('未变化 1');
    expect(await graph.request('get_contact', { entity_id: id })).toEqual(before);
    const repeated = await client.callTool({ name: 'search_contacts', arguments: { name: '合成人员', mode: 'keyword' } });
    expect(repeated.structuredContent).toMatchObject({ items: [{ entity_id: id }] });
  } finally {
    await Promise.allSettled([session?.client.close(), session?.runtime.close(), graph.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
