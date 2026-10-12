import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
import { CompanyContextService } from '../src/companies/company-context-service.js';
import { CompanyLinkService } from '../src/companies/company-link.js';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { ContactAnswerService } from '../src/contacts/contact-answer.js';
import { AssessmentService } from '../src/orchestration/assessment-service.js';
import { CompanyQuestionService } from '../src/orchestration/company-question-service.js';
import { CompanyProfileService } from '../src/upstream/qcc/profile-service.js';
import { buildMcpServer } from '../src/mcp/tools.js';
import type { OrganizationIdentity, Page } from '../src/companies/company-context-types.js';
import { AT, CODE, PROFILE } from './fixtures/company-context.js';

// Native binary is built by the remote validation workflow. Missing binary is a failure, never a skip.
const binary = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));
const name = PROFILE.identity.legalName;
const proof = (field_path: string, value: unknown, quote?: string) => ({ field_path, value,
  source_type: 'manual', collected_at: AT, locator_status: 'not_applicable', ...(quote ? { quote } : {}) });

it('reuses one native graph and SQLite history through six registered MCP entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'company-context-native-'));
  const graph = new ContactGraphClient({ command: binary, dbPath: join(directory, 'graph.sqlite') });
  const db = initializeDatabase(new DatabaseSync(join(directory, 'service.sqlite')));
  const profiles = new ProfileRepository(db), assessments = new AssessmentRepository(db), links = new CompanyLinkRepository(db);
  const now = () => new Date(AT);
  const context = new CompanyContextService({ graph, profiles, assessments, links, now, profileTtlDays: 30 });
  const companyLinks = new CompanyLinkService({ graph, profiles, links, now });
  const noExternal = async (): Promise<never> => { throw new Error('Synthetic library scenario must not query upstream'); };
  const profile = new CompanyProfileService({ call: noExternal }, profiles,
    { profileCacheTtlDays: 30, maxQccCalls: 1, maxTotalCalls: 1, now });
  const assessment = new AssessmentService({ assessments, queue: { enqueue: () => false }, assessmentCacheTtlDays: 30, now });
  const question = new CompanyQuestionService({ profiles, assessments, now, profileTtlDays: 30, companyContext: context,
    qccFactory: () => ({ call: noExternal, close: async () => {} }), searchFactory: () => ({ search: noExternal }),
    // Only the model response is synthetic; the supplied context and its citations come from the actual service.
    answerFactory: () => ({ answer: async input => {
      const items = input.context?.filter(item => item.predicate === 'clientOrganization' || item.predicate === 'memberOf') ?? [];
      expect(items.map(item => item.predicate)).toEqual(expect.arrayContaining(['clientOrganization', 'memberOf']));
      return { includedContextRefs: items.map(item => item.citation.ref), claims: items.map(item => ({
        text: item.statement, category: 'supported' as const, evidenceIds: [], contextRefs: [item.citation.ref, ...(item.required_context_refs ?? [])],
      })) };
    } }) });
  const server = buildMcpServer({ companyContext: context, companyLinks,
    contactLibrary: new ContactLibraryService(graph), contactSearch: new ContactSearch(graph),
    contactAnswer: new ContactAnswerService({ graph, companyContext: context, resolvePeople: async () => [] }),
    getCompanyProfile: input => profile.get(input.query, input.regionHint),
    getAssessmentReport: input => assessment.reportWithUpdates(input, context),
    getAssessmentStatus: input => assessment.status(input),
    submitAssessment: noExternal, getContacts: noExternal, askCompany: input => question.ask(input) });
  const client = new Client({ name: 'synthetic-company-integration', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const onmessage = b.onmessage!;
  let authenticated = true;
  b.onmessage = (message, extra) => onmessage(message, authenticated
    ? { ...extra, authInfo: { token: 'synthetic-only', clientId: 'synthetic-sales', scopes: [] } } : extra);
  try {
    await client.connect(a);
    const call = async (tool: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent as Record<string, any>;
    };
    const entity = async (label: string, operation: string, properties: Record<string, unknown>) =>
      (await graph.request<{ entity_id: string }>('save_contact', { label, actor: 'synthetic-sales', operation_id: operation,
        set_properties: properties, evidence: Object.entries(properties).flatMap(([key, value]) =>
          (Array.isArray(value) ? value : [value]).map(item => proof(`properties.${key}`, item))) })).entity_id;
    const relation = async (operation: string, source_id: string, target_id: string, relation_type: string,
      quote: string, role?: string) => graph.request('save_relation', { operation_id: operation, actor: 'synthetic-sales',
        source_id, target_id, relation_type, properties: role ? { role: { '@type': 'OrganizationRole', roleName: role } } : {},
        metadata: relation_type === 'worksFor' ? { employment_status: 'unknown' } : {},
        evidence: [proof('$relation', { relation_type, source_id, target_id }, quote),
          ...(role ? [proof('properties.role.roleName', role, quote)] : [])] });
    profiles.upsert({ ...PROFILE, basicProfile: { ...PROFILE.basicProfile, industry: '合成装备制造' } });
    const automatic = await entity('Organization', 'automatic', { name,
      identifier: [{ '@type': 'PropertyValue', propertyID: 'credit_code', value: CODE }] });
    const manual = await entity('Organization', 'manual', { name });
    const person = await entity('Person', 'person', { name: '合成人物甲' });
    const project = await entity('Project', 'project', { name: '合成客户项目' });
    await relation('work-a', person, automatic, 'worksFor', `合成人物甲在${name}任职工程师`, '工程师');
    await relation('work-b', person, manual, 'worksFor', `合成人物甲在${name}任职工程师`, '工程师');
    await relation('member', person, project, 'memberOf', '合成人物甲是合成客户项目成员', '成员');
    await relation('customer', project, automatic, 'clientOrganization', `合成客户项目的客户是${name}`);
    const identity = async (id: string) => (await graph.request<Page<OrganizationIdentity>>('company_organizations', {
      entity_ids: [id], credit_codes: [], normalized_names: [], offset: 0, limit: 1 })).items[0];
    const native = await identity(automatic);
    expect(native.identifiers).toContainEqual({ '@type': 'PropertyValue', propertyID: 'credit_code', value: CODE });
    expect(native.evidence).toContainEqual(expect.objectContaining({ field_path: 'properties.identifier',
      value: { '@type': 'PropertyValue', propertyID: 'credit_code', value: CODE } }));
    expect((await context.summaries([automatic, manual])).get(automatic)?.link).toMatchObject({ state: 'confirmed', basis: 'identifier_match' });
    expect((await context.summaries([manual])).get(manual)?.link.state).toBe('candidate');
    const confirm = { action: 'confirm', organization_id: manual, credit_code: CODE, operation_id: 'manual-link',
      expected_link_version: 0, expected_organization_version: (await identity(manual)).version, note: '合成数据人工核对' };
    authenticated = false;
    expect((await client.callTool({ name: 'link_company', arguments: confirm })).isError).toBe(true);
    expect(links.getMany([manual]).get(manual)).toBeUndefined();
    authenticated = true;
    const linked = await call('link_company', confirm);
    expect(await call('link_company', confirm)).toEqual(linked);
    expect(linked.actor).toBe('synthetic-sales');
    expect((await client.callTool({ name: 'link_company', arguments: { ...confirm, note: '相同操作ID的不同内容' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'link_company', arguments: { ...confirm, operation_id: 'bad-code-link', credit_code: 'INVALID' } })).isError).toBe(true);
    const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
    const originals = ['# 合成历史一\n不可改写。', '# 合成历史二\n不可改写。'];
    ids.forEach((id, index) => db.prepare(`INSERT INTO assessments
      (assessment_id,cache_key,requested_by,legal_name,credit_code,status,report_markdown,overall_opportunity,
       source_status_json,created_at,completed_at,collected_at) VALUES (?,?,'synthetic-sales',?,?,'completed',?,'中',?,?,?,?)`)
      .run(id, id, name, CODE, originals[index], JSON.stringify({ qcc: 'completed', doubaoSearch: 'completed', ark: 'completed' }), AT, AT, AT));
    for (let index = 0; index < 22; index++) {
      await graph.request('save_contact', { label: 'Organization', entity_id: automatic, actor: 'synthetic-sales',
        operation_id: `synthetic-record-${index}`, expected_version: (await identity(automatic)).version,
        set_properties: { name }, evidence: [proof('properties.name', name)] });
    }
    const nativePage = await graph.request<Page<unknown>>('company_recent_records', {
      organization_ids: [automatic], since: '2020-01-01T00:00:00.000Z', offset: 0, limit: 1 });
    expect(nativePage).toMatchObject({ complete: false, next_offset: 1 });
    const updates = await context.relatedUpdates(CODE, '2020-01-01T00:00:00.000Z');
    expect(updates.items).toHaveLength(20); expect(updates.truncated).toBe(true);
    expect(updates.scope).toEqual(expect.arrayContaining(['graph', 'profile', 'assessment']));
    const overview = (await call('get_company_profile', { query: name, include_company_context: true })).company_context;
    expect(overview).toMatchObject({ people: { count: 1, complete: true }, projects: { count: 1, complete: true }, reports: { count: 2 } });
    expect(overview.organization_ids.sort()).toEqual([automatic, manual].sort());
    const search = await call('search_contacts', { query: name, include_company_context: true });
    const organizations = search.items.filter((item: any) => item.label === 'Organization');
    expect(organizations).toHaveLength(2);
    expect(organizations.every((item: any) => item.company_context.report_count === 2)).toBe(true);
    for (const id of [automatic, manual]) {
      const detail = (await call('get_contact', { entity_id: id, include_company_context: true, report_limit: 1 })).company_context;
      expect(detail.report_count).toBe(2); expect(detail.reports.items).toHaveLength(1);
      const second = (await call('get_contact', { entity_id: id, include_company_context: true,
        report_offset: detail.reports.next_offset, report_limit: 1 })).company_context;
      expect(second.reports.items).toHaveLength(1); expect(second.reports.next_offset).toBeNull();
      expect(second.reports.items[0].assessment_id).not.toBe(detail.reports.items[0].assessment_id);
    }
    const contactAnswer = await call('ask_contacts', { entity_id: person, question: '合成人物甲的任职公司背景是什么？' });
    expect(contactAnswer.status).toBe('answered'); expect(contactAnswer.answer).toContain('合成装备制造');
    expect(contactAnswer.context_citations.some((c: any) => c.source_type === 'profile' && c.subject_id === CODE)).toBe(true);
    const companyAnswer = await call('ask_company', { legal_name: name, credit_code: CODE, question: '库内客户项目有哪些？' });
    expect(companyAnswer.status).toBe('answered'); expect(companyAnswer.used_fresh_research).toBe(false);
    expect(companyAnswer.context_citations.length).toBeGreaterThanOrEqual(2);
    expect(companyAnswer.markdown).toContain('合成客户项目');
    for (const [index, id] of ids.entries()) {
      expect((await call('get_assessment_report', { assessment_id: id, include_related_updates: true })).markdown).toBe(originals[index]);
      expect(assessments.get(id)?.reportMarkdown).toBe(originals[index]);
    }
    const unlink = { action: 'unlink', organization_id: manual, operation_id: 'manual-unlink',
      expected_link_version: links.getMany([manual]).get(manual)!.version,
      expected_organization_version: (await identity(manual)).version, note: '合成数据解除' };
    const revoked = await call('link_company', unlink);
    expect(await call('link_company', unlink)).toEqual(revoked);
    expect((await context.summaries([manual])).get(manual)?.link.state).toBe('revoked');
    expect((await context.overview(CODE)).organization_ids).not.toContain(manual);
    // An unlink of an automatic match writes the suppression marker too.
    await call('link_company', { ...unlink, organization_id: automatic, operation_id: 'automatic-unlink',
      expected_link_version: 0, expected_organization_version: (await identity(automatic)).version });
    expect((await context.overview(CODE)).organization_ids).toEqual([]);
    const restored = await call('link_company', { ...confirm, operation_id: 'manual-reconfirm',
      expected_link_version: revoked.version, expected_organization_version: (await identity(manual)).version });
    const beforeEdit = await identity(manual);
    await graph.request('save_contact', { label: 'Organization', entity_id: manual, actor: 'synthetic-sales',
      operation_id: 'identity-change', expected_version: beforeEdit.version, set_properties: { name: '变更后的合成企业' },
      evidence: [proof('properties.name', '变更后的合成企业')] });
    expect((await context.summaries([manual])).get(manual)?.link.state).toBe('conflict');
    expect((await client.callTool({ name: 'link_company', arguments: { ...confirm, operation_id: 'stale-confirm',
      expected_link_version: restored.version, expected_organization_version: beforeEdit.version } })).isError).toBe(true);
    const bad = await entity('Organization', 'bad-code', { name, identifier: [{ '@type': 'PropertyValue', propertyID: 'uscc', value: 'INVALID' }] });
    const school = await entity('Organization', 'school', { name: '合成大学' });
    await relation('school-edge', person, school, 'alumniOf', '合成人物甲毕业于合成大学');
    expect((await context.summaries([bad])).get(bad)?.link.state).toBe('candidate');
    expect((await context.summaries([school])).get(school)?.link.state).toBe('unlinked');
    expect((await context.overview(CODE)).people.count).toBe(0);
    const otherId = '10000000-0000-4000-8000-000000000003';
    db.prepare(`INSERT INTO assessments (assessment_id,cache_key,requested_by,legal_name,credit_code,status,
      report_markdown,overall_opportunity,source_status_json,created_at,completed_at,collected_at)
      VALUES (?,?,'synthetic-sales','另一个合成主体','91310000123456790R','completed','# 另一个原报告','中',?,?,?,?)`)
      .run(otherId, otherId, JSON.stringify({ qcc: 'completed', doubaoSearch: 'completed', ark: 'completed' }), AT, AT, AT);
    expect((await call('ask_company', { legal_name: name, credit_code: CODE, question: '库内客户项目有哪些？', assessment_id: otherId })).status).toBe('failed');
    expect((await call('get_assessment_report', { assessment_id: otherId })).markdown).toBe('# 另一个原报告');
    expect((await context.detail(bad, 0, 10)).reports.items).toEqual([]);
    await graph.close();
    const unavailable = (await call('get_company_profile', { query: name, include_company_context: true })).company_context;
    expect(unavailable.people.count).toBeNull(); expect(unavailable.people.complete).toBe(false);
    expect(unavailable.warnings.length).toBeGreaterThan(0);
    const disabled = new CompanyContextService({ profiles, assessments, links, now, profileTtlDays: 30 });
    expect(await disabled.overview(CODE)).toMatchObject({ state: 'not_applicable', people: { count: null, complete: false }, reports: { count: 2 } });
    ids.forEach((id, index) => expect(assessments.get(id)?.reportMarkdown).toBe(originals[index]));
  } finally {
    await client.close(); await server.close(); await graph.close(); db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
