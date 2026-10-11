import { describe, expect, it } from 'vitest';
import { toGraph, type SearchPage } from '../web/contact-search-graph-model.js';

const page: SearchPage = { items: [{ entity_id: 'p1', label: 'Person', name: '同名' },
  { entity_id: 'p2', label: 'Person', name: '同名' }], total: 2, mode_used: 'keyword', warnings: [] };
const relation = (id: string, type = 'worksFor', source = 'p1', target = 'o1') => ({
  relation_id: id, relation_type: type, source_id: source, target_id: target,
  properties: { role: { roleName: '工程师' } }, metadata: { employment_status: 'unknown' },
});
const detail = (id: string, relations: unknown[] = [], claims: unknown[] = []) => ({
  entity: { entity_id: id, label: 'Person', properties: { name: id } },
  relations, unverified_claims: claims,
});
describe('one-hop contact graph', () => {
  it('never creates employment from search names, titles or project matches', () => {
    expect(toGraph(page).edges).toEqual([]);
    expect(toGraph(page).nodes.map(n => n.id)).toEqual(['p1', 'p2']);
  });
  it.each(['worksFor', 'alumniOf', 'memberOf', 'clientOrganization', 'affiliation'])(
    'keeps direction and original semantics for %s', type => {
      const graph = toGraph(page, [detail('p1', [relation('r1', type, 'o1', 'p1')])]);
      expect(graph.edges[0]).toMatchObject({ id: 'relation:r1', source: 'o1', target: 'p1', type });
      expect(graph.edges[0].record.metadata).toEqual({ employment_status: 'unknown' });
      expect(graph.nodes.find(n => n.id === 'o1')).toMatchObject({ label: 'Unknown', matched: false });
    });
  it('accumulates all root pages, deduplicates real IDs and never recursively expands neighbors', () => {
    const first = Array.from({ length: 20 }, (_, i) => relation(`r${i}`, 'worksFor', 'p1', `o${i}`));
    const graph = toGraph(page, [detail('p1', first), detail('p1', [relation('r20'), first[0]]),
      detail('p2', [relation('r21', 'affiliation', 'p2', 'o1')]),
      { entity: { entity_id: 'o1', label: 'Organization', properties: { legalName: '公司' } },
        relations: [relation('hidden', 'affiliation', 'o1', 'o99')] }]);
    expect(graph.edges).toHaveLength(22);
    expect(graph.nodes.filter(n => n.id === 'o1')).toHaveLength(1);
    expect(graph.nodes.find(n => n.id === 'o1')?.title).toBe('公司');
    expect(graph.nodes.some(n => n.id === 'o99')).toBe(false);
    expect(toGraph({ ...page, items: [] }, []).nodes).toEqual([]);
  });
  it('only shows allowed confirmed-root claims with explicit targets after opt-in', () => {
    const c = { claim_id: 'c1', kind: 'relation', status: 'unverified',
      relation_type: 'affiliation', subject_id: 'p1', target_id: 'o1' };
    const d = detail('p1', [relation('r1'), relation('private', 'spouseOf')],
      [c, { ...c, claim_id: 'c2', relation_type: 'spouseOf' },
        { ...c, claim_id: 'c3', target_id: null }, { ...c, claim_id: 'c4', subject_id: 'p2' }]);
    expect(toGraph(page, [d]).edges.map(e => e.id)).toEqual(['relation:r1']);
    expect(toGraph(page, [d], true).edges.map(e => e.id)).toEqual(['relation:r1', 'claim:c1']);
  });
});
