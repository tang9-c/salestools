import { expect, it, vi } from 'vitest';
import { ZohoGraphSync } from '../src/contacts/zoho-graph-sync.js';
import type { ZohoContactsOutput } from '../src/contracts/zoho-contact.js';
import type { GraphClient } from '../src/contacts/graph-client.js';

const result = (): ZohoContactsOutput => ({ status: 'completed', complete: true, connections: [],
  collected_at: '2026-10-13T00:00:00.000Z', warnings: [], companies: [{ connection_id: 'crm_a',
    account_id: 'a', company_name: '合成公司', account_owner: null, contacts: [{ record_id: 'p',
      name: '合成人员', title: '经理', modified_at: null, contact_owner: null }] }] });
const setup = () => {
  const request = vi.fn(async (op: string, payload: unknown, _signal?: AbortSignal) => {
    if (op === 'get_contact') return { entity: { label: 'Person' }, index_status: 'unindexed', index_content_version: 2 };
    const companies = (payload as { companies: ZohoContactsOutput['companies'] }).companies;
    return { created: companies.flatMap(c => c.contacts).length, updated: 0, unchanged: 0, archived: 0, entity_ids: ['p'] };
  });
  const index = vi.fn();
  const graph = { request, close: async () => undefined } as unknown as GraphClient;
  return { request, index, sync: new ZohoGraphSync(graph, { index }) };
};

it('skips confirmation and failed/empty outputs without graph writes', async () => {
  const { sync, request } = setup();
  for (const output of [{ ...result(), status: 'needs_confirmation' as const },
    { ...result(), status: 'failed' as const }, { ...result(), companies: [] }]) await sync.sync(output, 'sales');
  expect(request).not.toHaveBeenCalled();
});

it('syncs partial records using the whitelist and schedules changed Person indexing', async () => {
  const { sync, request, index } = setup();
  const output = { ...result(), status: 'partial' as const, complete: false };
  const summary = await sync.sync(output, 'sales');
  expect(summary).toMatchObject({ created: 1, entity_ids: ['p'] });
  expect(request.mock.calls[0]).toEqual(['sync_zoho_contacts', { operation_id: expect.any(String), actor: 'sales',
    collected_at: output.collected_at, companies: output.companies }, expect.any(AbortSignal)]);
  expect(index).toHaveBeenCalledWith('p', 2);
  expect(output).toMatchObject({ status: 'partial', complete: false });
  expect(output.warnings.join()).toContain('图谱同步');
});

it('splits UTF-8 full frames, accumulates counts and preserves every query record', async () => {
  const { sync, request } = setup(); const output = result();
  output.companies[0]!.contacts = Array.from({ length: 12 }, (_, i) => ({ ...output.companies[0]!.contacts[0]!, record_id: String(i), name: '汉'.repeat(12000) }));
  const summary = await sync.sync(output, 'sales');
  const writes = request.mock.calls.filter(([op]) => op === 'sync_zoho_contacts');
  expect(writes.length).toBeGreaterThan(1);
  for (const [, payload] of writes) expect(Buffer.byteLength(`${JSON.stringify({ version: 1, request_id: 'g_123456789', op: 'sync_zoho_contacts', payload })}\n`, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  expect(summary.created).toBe(12); expect(output.companies[0]!.contacts).toHaveLength(12);
});

it('skips an oversized contact but continues with following records', async () => {
  const { sync, request } = setup(); const output = result(); const person = output.companies[0]!.contacts[0]!;
  output.companies[0]!.contacts = [{ ...person, name: '汉'.repeat(100000) }, { ...person, record_id: 'small' }];
  expect((await sync.sync(output, 'sales')).created).toBe(1);
  const writes = request.mock.calls.filter(([op]) => op === 'sync_zoho_contacts');
  expect(writes.flatMap(([, p]) => (p as { companies: ZohoContactsOutput['companies'] }).companies.flatMap(c => c.contacts)).map(c => c.record_id)).toEqual(['small']);
  expect(output.companies[0]!.contacts).toHaveLength(2); expect(output.warnings.join()).toContain('过大');
});

it('counts the complete serialized envelope at the 256 KiB boundary', async () => {
  const { sync, request } = setup(); const output = result(); const person = output.companies[0]!.contacts[0]!;
  // A 261800-byte ASCII name makes payload 262119 bytes, but the real frame 262189 bytes.
  output.companies[0]!.contacts = [{ ...person, name: 'x'.repeat(261800) }, { ...person, record_id: 'safe', name: 'x'.repeat(261700) }];
  expect((await sync.sync(output, 'sales')).created).toBe(1);
  const writes = request.mock.calls.filter(([op]) => op === 'sync_zoho_contacts');
  expect(writes).toHaveLength(1);
  expect((writes[0]![1] as { companies: ZohoContactsOutput['companies'] }).companies[0]!.contacts[0]!.record_id).toBe('safe');
  expect(output.warnings.join()).toContain('ZOHO_GRAPH_SYNC_PARTIAL');
});

it('persists an empty-contact account without inventing people', async () => {
  const { sync, request } = setup(); const output = result(); output.companies[0]!.contacts = [];
  await sync.sync(output, 'sales');
  expect(request.mock.calls[0]?.[0]).toBe('sync_zoho_contacts');
  expect((request.mock.calls[0]?.[1] as { companies: ZohoContactsOutput['companies'] }).companies).toEqual(output.companies);
});

it('retains prior committed counts and reports failed batches without indexing their content', async () => {
  const { sync, request, index } = setup(); const output = result(); const person = output.companies[0]!.contacts[0]!;
  output.companies[0]!.contacts = [{ ...person, name: '汉'.repeat(50000) }, { ...person, record_id: 'p2', name: '汉'.repeat(50000) }];
  request.mockImplementation(async (op: string) => {
    if (op === 'get_contact') return { entity: { label: 'Person' }, index_status: 'unindexed', index_content_version: 2 };
    if (request.mock.calls.filter(([kind]) => kind === 'sync_zoho_contacts').length > 1) throw new Error('private failure');
    return { created: 1, updated: 0, unchanged: 0, archived: 1, entity_ids: ['p'] };
  });
  expect(await sync.sync(output, 'sales')).toMatchObject({ created: 1, archived: 1 });
  expect(index).toHaveBeenCalledTimes(1); expect(output.status).toBe('completed'); expect(output.complete).toBe(true);
  expect(output.warnings.join()).toContain('关联部分未同步'); expect(output.warnings.join()).toContain('失败');
  expect(output.warnings.join()).not.toContain('private failure');
  expect(output.warnings.join()).toContain('ZOHO_GRAPH_SYNC_PARTIAL');
});

it('reports abort/timeout as an independent warning and preserves CRM results', async () => {
  const { sync, request, index } = setup(); const output = result();
  request.mockRejectedValue(new Error('GRAPH_ABORTED'));
  await sync.sync(output, 'sales');
  expect(index).not.toHaveBeenCalled(); expect(output.companies).toHaveLength(1);
  expect(output.warnings.join()).toContain('失败'); expect(output.status).toBe('completed');
  expect(output.warnings.join()).toContain('ZOHO_GRAPH_SYNC_FAILED');
});

it('excludes unknown/private fields from graph input and skips owner-only indexing', async () => {
  const { sync, request, index } = setup(); const output = result();
  Object.assign(output.companies[0]!, { source_url: 'https://private.invalid', email: 'private@example.com' });
  Object.assign(output.companies[0]!.contacts[0]!, { phone: 'secret', source_url: 'https://private.invalid' });
  request.mockResolvedValue({ created: 0, updated: 1, unchanged: 0, archived: 0, entity_ids: [] });
  await sync.sync(output, 'sales');
  expect(index).not.toHaveBeenCalled();
  const sent = JSON.stringify(request.mock.calls[0]);
  expect(sent).not.toContain('private'); expect(sent).not.toContain('phone'); expect(sent).not.toContain('source_url');
});

it('keeps committed graph results when asynchronous indexing scheduling rejects', async () => {
  const { sync, index } = setup(); const output = result();
  index.mockRejectedValue(new Error('private indexing error'));
  expect((await sync.sync(output, 'sales')).created).toBe(1);
  expect(output.warnings.join()).toContain('索引调度失败'); expect(output.warnings.join()).not.toContain('private');
});

it('reports rejected indexing once when multiple committed people exceed queue capacity', async () => {
  const { sync, request, index } = setup(); const output = result();
  request.mockImplementation(async (op: string) => op === 'get_contact'
    ? { entity: { label: 'Person' }, index_status: 'unindexed', index_content_version: 2 }
    : { created: 2, updated: 0, unchanged: 0, archived: 0, entity_ids: ['p1', 'p2'] });
  index.mockReturnValue(false);
  expect(await sync.sync(output, 'sales')).toMatchObject({ created: 2, entity_ids: ['p1', 'p2'] });
  expect(index).toHaveBeenCalledTimes(2);
  expect(output.warnings.filter(w => w.includes('索引调度失败'))).toHaveLength(1);
  expect(output.status).toBe('completed'); expect(output.complete).toBe(true);
});

it('uses the GraphClient abort mechanism after the per-batch timeout', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  try {
    const { sync, request } = setup(); const output = result();
    request.mockImplementation((_op: string, _payload: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('GRAPH_ABORTED')), { once: true });
    }));
    const pending = sync.sync(output, 'sales');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).created).toBe(0); expect(output.warnings.join()).toContain('超时');
    expect(timeout).toHaveBeenCalledWith(30_000);
  } finally { timeout.mockRestore(); vi.useRealTimers(); }
});
