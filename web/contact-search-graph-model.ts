import type { ContactSearch, ContactSearchInput } from '../src/contacts/contact-search.js';
import type { ContactLibraryService } from '../src/contacts/library-service.js';
export type SearchInput = ContactSearchInput;
export type SearchPage = Awaited<ReturnType<ContactSearch['search']>>;
export type ContactDetail = NonNullable<Awaited<ReturnType<ContactLibraryService['get']>>>;
export type GraphNode = { id: string; label: 'Person' | 'Organization' | 'Project' | 'Unknown'; title: string; matched: boolean };
export type GraphEdge = { id: string; source: string; target: string; type: string;
  status: 'recorded' | 'unverified'; record: Record<string, unknown> };
export type GraphState = { nodes: GraphNode[]; edges: GraphEdge[] };
export const professionalRelations = new Set(['worksFor', 'alumniOf', 'memberOf', 'clientOrganization', 'affiliation']);
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function label(value: unknown): GraphNode['label'] {
  return value === 'Person' || value === 'Organization' || value === 'Project' ? value : 'Unknown';
}
export function displayTitle(entity: Record<string, unknown>, item?: SearchPage['items'][number]): string {
  const props = object(entity.properties);
  const name = [props.name, props.legalName, item?.name, item?.display_name]
    .find(value => typeof value === 'string' && value.trim() && !/^未具名候选\s*·/.test(value));
  if (typeof name === 'string') return name;
  return { Person: '未具名人物', Organization: '未具名机构', Project: '未具名项目', Unknown: '名称未提供' }[label(entity.label ?? item?.label)];
}
export function toGraph(page: SearchPage, details: ContactDetail[] = [], includeUnverified = false): GraphState {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const roots = new Set(page.items.map(item => item.entity_id));
  const known = new Map<string, Record<string, unknown>>();
  for (const d of details) {
    const entity = object(d.entity);
    if (typeof entity.entity_id === 'string') known.set(entity.entity_id, entity);
  }
  function addNode(id: string, item?: SearchPage['items'][number]): void {
    const entity = known.get(id) ?? {};
    nodes.set(id, { id, label: label(entity.label ?? item?.label), matched: roots.has(id),
      title: displayTitle(entity, item) });
  }
  for (const item of page.items) addNode(item.entity_id, item);
  for (const d of details) {
    const root = object(d.entity).entity_id;
    if (typeof root !== 'string' || !roots.has(root)) continue;
    for (const r of records(d.relations)) {
      const { relation_id: id, source_id: source, target_id: target, relation_type: type } = r;
      if (typeof id !== 'string' || typeof source !== 'string' || typeof target !== 'string'
        || !source || !target || typeof type !== 'string' || !professionalRelations.has(type)
        || (source !== root && target !== root)) continue;
      edges.set(`relation:${id}`, { id: `relation:${id}`, source, target, type, status: 'recorded', record: r });
    }
    if (includeUnverified) for (const c of records(d.unverified_claims)) {
      const { claim_id: id, subject_id: source, target_id: target, relation_type: type } = c;
      if (c.kind !== 'relation' || c.status !== 'unverified' || source !== root || typeof id !== 'string'
        || typeof target !== 'string' || !target || typeof type !== 'string' || !professionalRelations.has(type)) continue;
      edges.set(`claim:${id}`, { id: `claim:${id}`, source, target, type, status: 'unverified', record: c });
    }
  }
  for (const edge of edges.values()) for (const id of [edge.source, edge.target]) {
    if (!nodes.has(id)) addNode(id);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
