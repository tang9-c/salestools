import { describe, expect, it } from 'vitest';
import { ContactSearch, fusedScore } from '../src/contacts/contact-search.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';

function graph(lexical: string[], semantic: string[], vectorFails = false): GraphClient {
  return {
    request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      const input = payload as { offset?: number; limit?: number; entity_id?: string };
      if (op === 'search_keyword' || op === 'search_vector') {
        if (op === 'search_vector' && vectorFails) throw new Error('vector unavailable');
        const ids = op === 'search_keyword' ? lexical : semantic;
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 10;
        return { items: ids.slice(offset, offset + limit).map(entity_id => ({ entity_id,
          name: entity_id, label: 'Person', reasons: op === 'search_keyword' ? ['name'] : [] })),
          total: ids.length,
          ...(offset + limit < ids.length ? { next_offset: offset + limit } : {}) } as T;
      }
      if (op === 'get_contact') return { entity: { label: 'Person', properties: { name: input.entity_id } } } as T;
      throw new Error(`Unexpected ${op}`);
    }, close: async () => undefined,
  };
}

describe('shared contact search', () => {
  it('shows a stable anonymous label without claiming it is a real name', async () => {
    const anonymousGraph: GraphClient = {
      request: async <T>(op: GraphOp) => {
        if (op !== 'search_keyword') throw new Error(`Unexpected ${op}`);
        return { items: [{ entity_id: 'p_12345678', label: 'Person', name: null,
          reasons: ['relation_match'] }], total: 1 } as T;
      }, close: async () => undefined,
    };
    const result = await new ContactSearch(anonymousGraph).search({ query: '星辰大学' });
    expect(result.items[0]).toMatchObject({ entity_id: 'p_12345678', name: null,
      display_name: '未具名候选 · 12345678' });
  });
  it('keeps deterministic keyword paging and can find separate same-name IDs', async () => {
    const search = new ContactSearch(graph(['p_1', 'p_2', 'p_3'], []));
    const page = await search.search({ name: '同名', mode: 'keyword', offset: 1, limit: 1 });
    expect(page).toMatchObject({ mode_used: 'keyword', total: 3, next_offset: 2,
      items: [{ entity_id: 'p_2' }] });
  });

  it('falls back to keyword with an explicit warning when embedding fails', async () => {
    const search = new ContactSearch(graph(['p_1'], []), {
      embed: async () => { throw new Error('offline'); },
    });
    expect(await search.search({ query: '陈晓', mode: 'semantic' })).toMatchObject({
      mode_used: 'keyword', warnings: ['semantic_unavailable'], items: [{ entity_id: 'p_1' }],
    });
  });

  it('fuses keyword and vector candidates with stable deduplication', async () => {
    const search = new ContactSearch(graph(['p_1', 'p_2'], ['p_2', 'p_3']), {
      embed: async () => ({ model: 'embed-a', vector: [1, 0] }),
    });
    const page = await search.search({ query: '研发', mode: 'hybrid', limit: 3 });
    expect(page.mode_used).toBe('hybrid');
    expect(page.items.map(item => item.entity_id)).toEqual(['p_2', 'p_1', 'p_3']);
    expect(page.total).toBe(3);
    expect(fusedScore(2, 1)).toBeGreaterThan(fusedScore(1));
  });

  it('falls back after a vector index error without hiding keyword results', async () => {
    const search = new ContactSearch(graph(['p_1'], [], true), {
      embed: async () => ({ model: 'embed-a', vector: [1, 0] }),
    });
    const result = await search.search({ query: '研发', mode: 'hybrid' });
    expect(result.mode_used).toBe('keyword');
    expect(result.items[0]?.entity_id).toBe('p_1');
  });

  it('uses factual filtering when structured filters accompany a semantic request', async () => {
    const search = new ContactSearch(graph(['p_1'], ['p_2']), {
      embed: async () => ({ model: 'embed-a', vector: [1, 0] }),
    });
    const result = await search.search({ organization_id: 'o_1', query: '经理', mode: 'semantic' });
    expect(result).toMatchObject({ mode_used: 'keyword', warnings: ['semantic_filters_keyword'],
      items: [{ entity_id: 'p_1' }] });
  });
});


describe('unverified keyword isolation', () => {
  it('preserves the matched project and all unresolved path claims', async () => {
    const client: GraphClient = { request: async <T>(op: GraphOp) => {
      if (op !== 'search_keyword') throw new Error(`Unexpected ${op}`);
      return { items: [{ entity_id: 'p_1', label: 'Person', name: null,
        matched_project_id: 'pr_1', reasons: ['project_client_match'],
        match_status: 'unverified', claim_ids: ['claim_member', 'claim_client'] }], total: 1 } as T;
    }, close: async () => undefined };
    const page = await new ContactSearch(client).search({ query: '乙客户公司', include_unverified: true });
    expect(page.items[0]).toMatchObject({ matched_project_id: 'pr_1',
      reasons: ['project_client_match'], match_status: 'unverified',
      claim_ids: ['claim_member', 'claim_client'] });
  });
  it('forwards opt-in and preserves claim match markers', async () => {
    const calls: unknown[] = [];
    const client: GraphClient = { request: async <T>(_op: GraphOp, payload: unknown) => {
      calls.push(payload);
      return { items: [{ entity_id: 'p_claim', match_status: 'unverified', claim_id: 'claim-1' }], total: 1 } as T;
    }, close: async () => undefined };
    const page = await new ContactSearch(client).search({ query: 'Academy', include_unverified: true });
    expect(calls).toEqual([expect.objectContaining({ include_unverified: true })]);
    expect(page.items[0]).toMatchObject({ match_status: 'unverified', claim_id: 'claim-1' });
  });
  it.each(['semantic', 'hybrid'] as const)('rejects %s with opt-in even when embedding unavailable', async mode => {
    await expect(new ContactSearch(graph([], [])).search({ query: 'Academy', mode, include_unverified: true }))
      .rejects.toThrow('include_unverified');
  });
  it.each([undefined, '', '   '])('rejects missing or empty query %s', async query => {
    await expect(new ContactSearch(graph([], [])).search({ query, include_unverified: true }))
      .rejects.toThrow('query');
  });
});
