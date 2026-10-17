import { expect, it } from 'vitest';
import { GraphEvidenceCollector, type GraphReadContext } from '../src/research/graph-evidence.js';
import { identityHash } from '../src/companies/company-link.js';
import { CompanyContextService } from '../src/companies/company-context-service.js';
const at = '2026-10-17T00:00:00.000Z';
const meta = { version: 1, created_at: at, updated_at: at };
const org = (id = 'o', name = '企业甲') => ({ entity_id: id, label: 'Organization', properties: { name }, metadata: meta });
const person = (id = 'p') => ({ entity_id: id, label: 'Person', properties: { name: '张三', skills: ['Creo'], telephone: ['13800138000'], email: ['private@example.org'] }, metadata: meta });
const project = (description: string) => ({ entity_id: 'j', label: 'Project', properties: { name: '项目P', description }, metadata: meta });
const work = (target = 'o') => ({ relation_id: `w-${target}`, source_id: 'p', target_id: target, relation_type: 'worksFor', properties: { role: { '@type': 'OrganizationRole', roleName: '工程师', startDate: '2020', endDate: '2022' } }, metadata: { ...meta, employment_status: 'ended' } });
const member = { relation_id: 'm', source_id: 'p', target_id: 'j', relation_type: 'memberOf', properties: {}, metadata: meta };
const client = { relation_id: 'c', source_id: 'j', target_id: 'o', relation_type: 'clientOrganization', properties: {}, metadata: meta };
const proof = (id: string, subject: string, field: string, quote: string, relation = false) => ({ evidence_id: id, subject_kind: relation ? 'relation' : 'entity', subject_id: subject, field_path: field, value: quote, source_type: 'file', file_name: 'cv.pdf', file_sha256: 'a'.repeat(64), quote, locator_status: 'located', collected_at: at });
const record = (entity: any, evidence: any[] = [], relations: any[] = [], conflicts: any[] = []) => ({ entity, version: 1, index_content_version: 1, evidence, relations, conflicts, pagination: { evidence: { total: evidence.length, next_offset: null }, relations: { total: relations.length, next_offset: null } } });
function fixture(kind: 'skill' | 'direct' | 'project' | 'supplier' | 'overlap' = 'skill') {
  const employment = work(kind === 'supplier' ? 's' : 'o');
  const quote = kind === 'direct' ? '张三2020至2022年在企业甲担任工程师使用Creo设计' : `张三在${kind === 'supplier' ? '供应商' : '企业甲'}任工程师`;
  const description = kind === 'project' ? '企业甲内部项目P使用Creo设计' : kind === 'supplier' ? '供应商在项目P使用Creo设计' : '项目P使用Creo设计';
  const records: Record<string, any> = {
    o: record(org()), s: record(org('s', '供应商')),
    p: record(person(), [proof('employment', employment.relation_id, '$relation', quote, true), proof('skill', 'p', 'properties.skills', '个人技能Creo'), ...(kind !== 'skill' && kind !== 'direct' ? [proof('membership', 'm', '$relation', '张三是项目P成员', true)] : [])], [employment, ...(kind !== 'skill' && kind !== 'direct' ? [member] : [])]),
    j: record(project(description), [proof('project-software', 'j', 'properties.description', description), ...(kind === 'supplier' ? [proof('client', 'c', '$relation', '项目P客户是企业甲', true)] : [])], kind === 'supplier' ? [client] : []),
  };
  const calls: Array<{ op: string; payload: any }> = [];
  const readContext: GraphReadContext = { signal: new AbortController().signal, async request<T>(op: any, payload: any): Promise<T> {
    calls.push({ op, payload });
    if (op === 'company_organizations') return { items: [{ entity_id: 'o', name: '企业甲', legal_name: '企业甲', identifiers: [], evidence: [], conflicts: [], identity_complete: true }], total: 1, next_offset: null, complete: true } as T;
    if (op === 'company_relations') return { items: kind === 'supplier' ? [client, member] : [employment], total: kind === 'supplier' ? 2 : 1, next_offset: null, complete: true } as T;
    return records[payload.entity_id] as T;
  } };
  const organizations = { async confirmedOrganizationIds(_code: string, context: GraphReadContext) {
    await context.request('company_organizations', {});
    return { ids: ['o'], complete: true, available: true, warnings: [] };
  } };
  return { records, calls, readContext, collector: new GraphEvidenceCollector({ organizations, now: () => new Date(at) }) };
}
const identity = { credit_code: '91310000123456789X', legal_name: '企业甲' };
async function collect(f: ReturnType<typeof fixture>) { return f.collector.collect(identity, ['creo'], f.readContext); }
it.each([['skill', 'associated_skill'], ['direct', 'direct_use'], ['project', 'project_use'], ['supplier', 'supplier_project']] as const)('attributes %s through full proof dependencies as %s', async (kind, expected) => {
  const f = fixture(kind), result = await collect(f);
  const candidate = result.evidence.find(e => e.signal_kind === expected);
  expect(candidate, JSON.stringify(result)).toBeDefined();
  expect(candidate!.required_evidence_ids.length).toBeGreaterThan(0);
  for (const id of candidate!.required_evidence_ids) expect(result.evidence.some(e => e.evidence_id === id)).toBe(true);
  expect(result.evidence.every(e => e.url === null)).toBe(true);
  expect(new Set(result.evidence.map(e => e.source_key)).size).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/13800138000|private@example/);
});
it('does not infer project ownership from employment and membership or merge people with the same name', async () => {
  const f = fixture('overlap');
  f.records.p.evidence[0].subject_id = 'different-person-relation';
  const result = await collect(f);
  expect(result.evidence.some(e => ['project_use', 'direct_use', 'associated_skill'].includes(e.signal_kind))).toBe(false);
  expect(result.warnings).toContain('GRAPH_ATTRIBUTION_MISSING');
  const overlap = await collect(fixture('overlap'));
  expect(overlap.evidence.some(e => e.signal_kind === 'project_use')).toBe(false);
});
it('reads actual contact pages and discards all entity evidence after version changes', async () => {
  const f = fixture();
  const original = f.readContext.request.bind(f.readContext);
  f.records.p.pagination.evidence = { total: 2, next_offset: 1 };
  f.records.p.evidence = [f.records.p.evidence[0]];
  f.readContext.request = async <T>(op: any, payload: any): Promise<T> => {
    if (op === 'get_contact' && payload.entity_id === 'p' && payload.evidence_offset === 1) return { ...record(person(), [proof('skill', 'p', 'properties.skills', '个人技能Creo')]), version: 2 } as T;
    return original<T>(op, payload);
  };
  const result = await collect(f);
  expect(result.evidence).toEqual([]);
  expect(result.warnings).toContain('GRAPH_ENTITY_CHANGED');
});
it('accepts paged skill only after complete employment provenance was loaded', async () => {
  const f = fixture(), original = f.readContext.request.bind(f.readContext);
  const employment = f.records.p.evidence[0], skill = f.records.p.evidence[1];
  f.records.p.evidence = [employment]; f.records.p.pagination.evidence = { total: 2, next_offset: 1 };
  f.readContext.request = async <T>(op: any, payload: any): Promise<T> => op === 'get_contact' && payload.entity_id === 'p' && payload.evidence_offset === 1
    ? { ...f.records.p, evidence: [skill], relations: [], pagination: { evidence: { total: 2, next_offset: null }, relations: { total: 1, next_offset: null } } } as T : original<T>(op, payload);
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'associated_skill')).toBe(true);
});
it('retains conflicting evidence as unresolved without a definite use classification', async () => {
  const f = fixture('direct'); f.records.p.conflicts = [proof('negative', 'w-o', '$relation', '张三未在企业甲使用Creo', true)];
  const result = await collect(f);
  expect(result.evidence.some(e => e.quote.includes('未在'))).toBe(true);
  expect(result.evidence.some(e => e.signal_kind === 'direct_use')).toBe(false);
  expect(result.warnings).toContain('GRAPH_CONFLICT');
});
it('counts organization resolver attempts and failures toward the 40 IPC hard limit', async () => {
  let calls = 0;
  const f = fixture();
  const collector = new GraphEvidenceCollector({ organizations: { async confirmedOrganizationIds(_code, context) {
    for (let n = 0; n < 45; n++) { try { await context.request('company_organizations', {}); } catch {} }
    return { ids: ['o'], complete: true, available: true, warnings: [] };
  } } });
  f.readContext.request = async () => { calls++; throw Error('closed'); };
  const result = await collector.collect(identity, ['creo'], f.readContext);
  expect(calls).toBe(40);
  expect(result.warnings).toContain('GRAPH_IPC_BUDGET_EXHAUSTED');
});
it('marks closed graph and oversized frames as incomplete without material leakage', async () => {
  const f = fixture(); f.readContext.request = async () => { throw Error('closed'); };
  expect((await collect(f)).source_status[0].status).toBe('unavailable');
  const oversized = fixture(); oversized.records.p.padding = 'x'.repeat(256 * 1024);
  expect((await collect(oversized)).warnings).toContain('GRAPH_FRAME_TOO_LARGE');
});
it('public organization resolver uses supplied read context rather than shared graph', async () => {
  const f = fixture(); let direct = 0;
  const service = new CompanyContextService({ graph: { request: async () => { direct++; throw Error('must use context'); }, close: async () => {} },
    links: { byCreditCode: () => [], getMany: () => new Map([['o', { organization_id: 'o', state: 'confirmed', credit_code: identity.credit_code, identity_hash: identityHash({ entity_id: 'o', name: '企业甲', legal_name: '企业甲', identifiers: [] } as any), version: 1 }]]) as any },
    profiles: { findByCreditCodes: () => [{ identity: { creditCode: identity.credit_code, legalName: identity.legal_name, formerNames: [] } }] as any, findByNormalizedNames: () => [] },
    assessments: {} as any, now: () => new Date(at), profileTtlDays: 30 });
  const result = await service.confirmedOrganizationIds(identity.credit_code, f.readContext);
  expect(result.ids).toEqual(['o']); expect(direct).toBe(0);
});
it('drops a non-advancing paged entity instead of keeping an incomplete skill chain', async () => {
  const f = fixture(), original = f.readContext.request.bind(f.readContext);
  f.records.p.pagination.evidence = { total: 3, next_offset: 1 };
  f.readContext.request = async <T>(op: any, payload: any): Promise<T> => op === 'get_contact' && payload.entity_id === 'p' && payload.evidence_offset === 1
    ? { ...f.records.p, evidence: [], relations: [] } as T : original<T>(op, payload);
  const result = await collect(f);
  expect(result.evidence).toEqual([]);
  expect(result.warnings).toContain('GRAPH_INVALID_PAGINATION');
});
it.each(['张三在企业甲担任工程师未使用Creo', '张三在企业甲担任工程师计划使用Creo'])('keeps use limitations in %s without definite use', async quote => {
  const f = fixture('direct'); f.records.p.evidence[0].quote = quote;
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'direct_use')).toBe(false);
});
it('preserves software field conflicts without declaring the project used the software', async () => {
  const f = fixture('project'); f.records.j.conflicts = [proof('changed-software', 'j', 'properties.description', '企业甲内部项目P未使用Creo')];
  const result = await collect(f);
  expect(result.evidence.some(e => e.quote.includes('未使用'))).toBe(true);
  expect(result.evidence.some(e => e.signal_kind === 'project_use')).toBe(false);
  expect(result.conflict_evidence_ids.length).toBeGreaterThan(0);
});
it('never collects more than twenty people and ten projects, and flags omitted traversal', async () => {
  const f = fixture(), original = f.readContext.request.bind(f.readContext);
  const readIds: string[] = [];
  f.readContext.request = async <T>(op: any, payload: any): Promise<T> => {
    if (op === 'company_relations') return { items: Array.from({ length: 25 }, (_, i) => ({ relation_id: `r${i}`, source_id: `p${i}`, target_id: 'o', relation_type: 'worksFor' })), next_offset: null, complete: true } as T;
    if (op === 'get_contact' && payload.entity_id.startsWith('p')) { readIds.push(payload.entity_id); return record(person(payload.entity_id)) as T; }
    return original<T>(op, payload);
  };
  const result = await collect(f);
  expect(readIds).toHaveLength(20);
  expect(result.warnings).toContain('GRAPH_ENTITY_BUDGET_EXHAUSTED');
  const p = fixture(), projectsOriginal = p.readContext.request.bind(p.readContext), projectReads: string[] = [];
  p.readContext.request = async <T>(op: any, payload: any): Promise<T> => {
    if (op === 'company_relations') return { items: Array.from({ length: 15 }, (_, i) => ({ relation_id: `c${i}`, source_id: `j${i}`, target_id: 'o', relation_type: 'clientOrganization' })), next_offset: null, complete: true } as T;
    if (op === 'get_contact' && payload.entity_id.startsWith('j')) { projectReads.push(payload.entity_id); return record({ ...project('Creo项目'), entity_id: payload.entity_id }) as T; }
    return projectsOriginal<T>(op, payload);
  };
  expect((await collect(p)).warnings).toContain('GRAPH_ENTITY_BUDGET_EXHAUSTED'); expect(projectReads).toHaveLength(10);
});
it('does not accept membership proof belonging to an identically named different person', async () => {
  const f = fixture('project'); f.records.p.evidence.find((e: any) => e.evidence_id === 'membership').subject_id = 'different-relation';
  const result = await collect(f);
  expect(result.evidence.some(e => e.signal_kind === 'project_use')).toBe(false);
});
it('does not attribute another employer usage clause to the confirmed company', async () => {
  const f = fixture('direct'); f.records.p.evidence[0].quote = '张三在企业甲担任工程师；此前在企业乙使用Creo设计';
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'direct_use')).toBe(false);
});
it('does not turn a project mention or external employment alone into software use attribution', async () => {
  const f = fixture('project'); f.records.j.evidence[0].quote = '企业甲内部项目P了解Creo';
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'project_use')).toBe(false);
  const supplier = fixture('supplier'); supplier.records.j.evidence[0].quote = '项目P使用Creo设计';
  expect((await collect(supplier)).evidence.some(e => e.signal_kind === 'supplier_project')).toBe(false);
});
it.each([
  '企业甲内部项目P使用CATIA；供应商另一个项目使用Creo设计',
  '企业甲内部项目P由供应商承接；供应商使用Creo',
  '企业甲内部项目P由供应商使用Creo设计',
])('does not join internal ownership to external software use: %s', async quote => {
  const f = fixture('project'); f.records.j.evidence[0].quote = quote;
  const result = await collect(f);
  expect(result.evidence.some(e => e.product_keys.includes('creo') && e.signal_kind === 'project_use')).toBe(false);
});
it('keeps each explicit internal project product attribution in its own source clause', async () => {
  const f = fixture('project'); f.records.j.evidence[0].quote = '企业甲内部项目P使用CATIA；供应商另一个项目使用Creo设计';
  const result = await f.collector.collect(identity, ['catia'], f.readContext);
  const usage = result.evidence.find(e => e.signal_kind === 'project_use');
  expect(usage?.product_keys).toEqual(['catia']);
  expect(usage?.quote).toBe('企业甲内部项目P使用CATIA');
});
it('does not join a supplier name to another project software clause', async () => {
  const f = fixture('supplier'); f.records.j.evidence[0].quote = '供应商在项目P使用CATIA；客户另一个项目使用Creo';
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'supplier_project')).toBe(false);
});
it.each(['不采用Creo', '没有采用Creo', '未运用Creo'])('does not classify negative usage %s as direct or project use', async wording => {
  const f = fixture('direct'); f.records.p.evidence[0].quote = `张三在企业甲担任工程师${wording}设计`;
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'direct_use')).toBe(false);
  const p = fixture('project'); p.records.j.evidence[0].quote = `企业甲内部项目P${wording}设计`;
  expect((await collect(p)).evidence.some(e => e.signal_kind === 'project_use')).toBe(false);
});
it.each(['采用Creo', '运用Creo'])('preserves explicit positive use %s in both direct and project attribution', async wording => {
  const f = fixture('direct'); f.records.p.evidence[0].quote = `张三在企业甲担任工程师${wording}设计`;
  expect((await collect(f)).evidence.some(e => e.signal_kind === 'direct_use')).toBe(true);
  const p = fixture('project'); p.records.j.evidence[0].quote = `企业甲内部项目P${wording}设计`;
  expect((await collect(p)).evidence.some(e => e.signal_kind === 'project_use')).toBe(true);
});


import { buildResult } from '../src/research/opportunity-adapter.js';
import type { ResearchResultInput } from '../src/research/runner.js';
it.each([
  '张三在企业甲担任工程师并指导供应商使用Creo设计',
  '张三在企业甲担任工程师并在企业乙使用Creo设计',
  '张三在企业甲担任工程师并培训客户使用Creo设计',
  '张三在企业甲担任工程师并由外包团队使用Creo设计',
])('keeps external employment use as a clue through collector and builder: %s', async quote => {
  const f = fixture('direct');
  f.records.p.evidence[0].quote = quote;
  const collected = await collect(f);
  expect(collected.evidence.some(e => e.signal_kind === 'direct_use')).toBe(false);
  expect(collected.evidence.some(e => e.quote === quote)).toBe(true);
  expect(collected.warnings).toContain('GRAPH_ATTRIBUTION_MISSING');
  const snapshot = buildResult({
    run: { run_id: 'r', dossier_id: 'd', base_version_id: null, request: {
      template: { id: 'company_research', version: 1 }, method_version: 'research@1',
      product_keys: ['creo'], product_goals: { creo: '研究' }, effective_goal: '研究', product_base_versions: { creo: null },
    } },
    dossier: { dossier_id: 'd', ...identity }, baselines: {}, prior: [], scope: ['creo'],
    evidence: collected.evidence, facts: [], claims: [], gaps: [], evidence_checks: [],
    source_status: collected.source_status, budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    conflict_evidence_ids: [], warnings: collected.warnings, stop_reason: 'NO_NEW_EVIDENCE',
    completed_rounds: 1, round_search_counts: [], pending_work: [], assessed_at: at,
  } as unknown as ResearchResultInput);
  expect(snapshot!.claims.some(c => c.kind === 'supported' && c.predicate === 'uses')).toBe(false);
  expect(snapshot!.gaps.some(g => g.kind === 'technical')).toBe(true);
});
