import type { GraphClient } from './graph-client.js';
import type { EmbeddingClient } from './embedding-client.js';

export interface ContactSearchInput {
  query?: string; name?: string; organization_id?: string; job_title?: string; skill?: string;
  include_unverified?: boolean;
  mode?: 'keyword' | 'semantic' | 'hybrid'; offset?: number; limit?: number;
}

interface SearchItem { entity_id: string; label?: string; name?: string | null; display_name?: string; reasons?: string[]; score?: number; match_status?: 'confirmed' | 'unverified'; claim_id?: string; claim_ids?: string[]; matched_project_id?: string }
interface SearchPage { items: SearchItem[]; total: number; next_offset?: number }

function displayItems(items: SearchItem[]): SearchItem[] {
  return items.map(item => ({ ...item, name: item.name ?? null,
    display_name: item.name ?? `未具名候选 · ${item.entity_id.slice(-8)}` }));
}

export function reciprocalRank(rank: number): number { return 1 / (60 + rank); }
export function fusedScore(keywordRank?: number, vectorRank?: number): number {
  return (keywordRank === undefined ? 0 : reciprocalRank(keywordRank))
    + (vectorRank === undefined ? 0 : reciprocalRank(vectorRank));
}

const maxCandidateWindow = 500;

export class ContactSearch {
  constructor(private readonly graph: GraphClient,
    private readonly embedding?: Pick<EmbeddingClient, 'embed'>) {}

  async search(input: ContactSearchInput): Promise<{
    items: SearchItem[]; total: number; next_offset?: number;
    mode_used: 'keyword' | 'semantic' | 'hybrid'; warnings: string[];
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('Invalid contact search pagination');
    }
    const mode = input.mode ?? 'keyword';
    if (input.include_unverified && mode !== 'keyword') {
      throw new Error('include_unverified is only supported in keyword mode');
    }
    if (input.include_unverified && !input.query?.trim()) {
      throw new Error('include_unverified requires a nonempty query');
    }
    const filters = { query: input.query, name: input.name,
      organization_id: input.organization_id, job_title: input.job_title, skill: input.skill,
      ...(input.include_unverified !== undefined ? { include_unverified: input.include_unverified } : {}) };
    const keyword = async (pageOffset: number, pageLimit: number) => this.graph.request<SearchPage>(
      'search_keyword', { ...filters, offset: pageOffset, limit: pageLimit });
    const fallback = async (warning?: string) => {
      const page = await keyword(offset, limit);
      return { ...page, items: displayItems(page.items), mode_used: 'keyword' as const,
        warnings: warning ? [warning] : [] };
    };
    if (mode === 'keyword') return fallback();
    if (input.name || input.organization_id || input.job_title || input.skill) {
      return fallback('semantic_filters_keyword');
    }
    if (!this.embedding || !input.query?.trim()) return fallback('semantic_unavailable');

    let vector: number[];
    let model: string;
    try {
      ({ vector, model } = await this.embedding.embed(input.query));
    } catch { return fallback('semantic_unavailable'); }
    const vectorPage = (pageOffset: number, pageLimit: number) => this.graph.request<SearchPage>(
      'search_vector', { model, dimension: vector.length, vector, offset: pageOffset, limit: pageLimit });
    if (mode === 'semantic') {
      let vectorResult: SearchPage;
      try { vectorResult = await vectorPage(offset, limit); }
      catch { return fallback('semantic_unavailable'); }
      const items: SearchItem[] = [];
      for (const hit of vectorResult.items) {
        const loaded = await this.graph.request<Record<string, unknown> | null>('get_contact',
          { entity_id: hit.entity_id });
        if (!loaded) continue;
        const entity = loaded.entity as { label?: string; properties?: { name?: string } } | undefined;
        items.push({ ...hit, label: entity?.label, name: entity?.properties?.name,
          reasons: ['semantic'] });
      }
      return { items: displayItems(items), total: vectorResult.total, next_offset: vectorResult.next_offset,
        mode_used: 'semantic', warnings: [] };
    }

    // Fetch a bounded candidate window before deduplication, then rank and page.
    const window = Math.min(maxCandidateWindow, offset + limit);
    const collect = async (fetchPage: (start: number, length: number) => Promise<SearchPage>) => {
      const items: SearchItem[] = [];
      let total = 0;
      while (items.length < window) {
        const page = await fetchPage(items.length, Math.min(50, window - items.length));
        total = page.total;
        items.push(...page.items);
        if (!page.next_offset || page.items.length === 0) break;
      }
      return { items, total };
    };
    let semantic: { items: SearchItem[]; total: number };
    try { semantic = await collect(vectorPage); }
    catch { return fallback('semantic_unavailable'); }
    const lexical = await collect(keyword);
    const ranks = new Map<string, { item: SearchItem; keyword?: number; vector?: number }>();
    lexical.items.forEach((item, index) => ranks.set(item.entity_id, { item, keyword: index + 1 }));
    semantic.items.forEach((item, index) => {
      const existing = ranks.get(item.entity_id);
      ranks.set(item.entity_id, { item: existing?.item ?? item, keyword: existing?.keyword,
        vector: index + 1 });
    });
    const merged = [...ranks.values()].map(entry => ({ ...entry.item,
      reasons: [...new Set([...(entry.item.reasons ?? []), ...(entry.vector ? ['semantic'] : [])])],
      score: fusedScore(entry.keyword, entry.vector) }));
    merged.sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
    const warnings = lexical.total > lexical.items.length || semantic.total > semantic.items.length
      ? ['search_window_limited'] : [];
    const items = merged.slice(offset, offset + limit);
    return { items: displayItems(items), total: merged.length,
      ...(offset + items.length < merged.length ? { next_offset: offset + items.length } : {}),
      mode_used: 'hybrid', warnings };
  }
}
