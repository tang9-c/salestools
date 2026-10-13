import { expect, it, vi } from 'vitest';
import type { GraphClient } from '../src/contacts/graph-client.js';
import { queryRuntime } from './helpers/zoho-graph-query.js';

it.each([false, true])('query graph side effect follows CONTACT_GRAPH_ENABLED=%s', async enabled => {
  const request = vi.fn(async (op: string) => op === 'get_sync_cursor' ? { initialized: false, last_snapshot_id: 0 }
    : { created: 1, updated: 0, unchanged: 0, archived: 0, entity_ids: [] });
  const { client, runtime, query } = await queryRuntime({ request, close: async () => undefined } as unknown as GraphClient, enabled);
  try {
    const response = await query();
    expect(response.structuredContent).toMatchObject({ zoho: { status: 'completed', complete: true, companies: [{ contacts: [{ name: '合成人员' }] }] } });
    const writes = request.mock.calls.filter(([op]) => op === 'sync_zoho_contacts');
    expect(writes).toHaveLength(enabled ? 1 : 0);
    if (enabled) expect(JSON.stringify(response.content)).toContain('图谱同步');
  } finally { await client.close(); await runtime.close(); }
});
