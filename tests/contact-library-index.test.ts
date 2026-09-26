import { describe, expect, it, vi } from 'vitest';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';

describe('contact index scheduling', () => {
  it('schedules the committed content version after a Person write and tolerates index callback failure', async () => {
    const request = vi.fn(async (op: GraphOp): Promise<unknown> => op === 'get_contact'
      ? { entity: { label: 'Person' }, index_content_version: 7, index_status: 'unindexed' }
      : { entity_id: 'p1', version: 3, replayed: false });
    const callback = vi.fn(() => { throw new Error('indexer down'); });
    const library = new ContactLibraryService({ request } as unknown as GraphClient, callback);
    await expect(library.save({ operation_id: 'save-1', label: 'Person',
      set_properties: { name: '陈晓' } }, 'actor')).resolves.toMatchObject({ entity_id: 'p1' });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('p1', 7));
  });

  it('does not rebuild a ready index when a committed operation is replayed', async () => {
    const request = vi.fn(async (op: GraphOp): Promise<unknown> => op === 'get_contact'
      ? { entity: { label: 'Person' }, index_content_version: 7, index_status: 'ready' }
      : { entity_id: 'p1', replayed: true });
    const callback = vi.fn();
    const library = new ContactLibraryService({ request } as unknown as GraphClient, callback);
    await library.save({ operation_id: 'save-1', label: 'Person' }, 'actor');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('get_contact', { entity_id: 'p1' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
  });
});
