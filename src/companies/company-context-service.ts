import type { GraphClient } from '../contacts/graph-client.js';
import type { CompanyLinkRepository } from '../db/company-link-repository.js';
import type { ProfileRepository, StoredCompanyProfile } from '../db/profile-repository.js';
import type { AssessmentRepository } from '../db/assessment-repository.js';
import { resolveCompanyLink } from './company-link.js';
import type { CompanyDetail, CompanyOverview, CompanySummary, Count, LinkResolution,
  OrganizationIdentity, Page, RecentRecord, RelatedUpdates, ReportItem, ReportSummary } from './company-context-types.js';

const MAX_PAGES = 20;
const BATCH = 50;
const UNKNOWN_REPORTS = (): Page<ReportItem> =>
  ({ items: [], total: null, next_offset: null, complete: false });
const count = (ids: Set<string>, complete: boolean): Count =>
  ({ count: complete ? ids.size : null, loaded_count: ids.size, complete });
const normalize = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

interface RelationItem { relation_id: string; source_id: string; target_id: string; relation_type: string }
type LinkRepo = Pick<CompanyLinkRepository, 'getMany' | 'byCreditCode'>;
type ProfileRepo = Pick<ProfileRepository, 'findByCreditCodes' | 'findByNormalizedNames'>;
type AssessmentRepo = Pick<AssessmentRepository, 'summariesByCreditCodes' | 'listCompleted'>;

export class CompanyContextService {
  constructor(private readonly deps: {
    graph?: GraphClient;
    links: LinkRepo;
    profiles: ProfileRepo;
    assessments: AssessmentRepo;
    now: () => Date;
    profileTtlDays: number;
  }) {}

  private active(signal?: AbortSignal): AbortSignal {
    const active = signal ?? AbortSignal.timeout(30_000);
    active.throwIfAborted();
    return active;
  }

  private async request<T>(op: 'company_organizations' | 'company_relations' | 'company_recent_records',
    payload: object, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (!this.deps.graph) throw new Error('GRAPH_NOT_CONFIGURED');
    try {
      const result = await this.deps.graph.request<T>(op, payload, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }

  private async pages<T>(op: 'company_organizations' | 'company_relations' | 'company_recent_records',
    filter: object, limit: number, signal: AbortSignal): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      signal.throwIfAborted();
      const result = await this.request<Page<T>>(op, { ...filter, offset, limit }, signal);
      items.push(...result.items);
      if (result.complete && result.next_offset === null) return { items, complete: true };
      if (result.next_offset === null || result.next_offset <= offset) return { items, complete: false };
      offset = result.next_offset;
    }
    return { items, complete: false };
  }

  private resolve(organizations: OrganizationIdentity[], signal: AbortSignal): Map<string, LinkResolution> {
    signal.throwIfAborted();
    const links = this.deps.links.getMany(organizations.map(item => item.entity_id));
    const names = [...new Set(organizations.flatMap(item => [item.name, item.legal_name]
      .filter((value): value is string => !!value).map(normalize)))];
    const codeSet = new Set([...links.values()].map(item => item.credit_code).filter((code): code is string => !!code));
    for (const item of organizations) for (const identifier of item.identifiers) codeSet.add(identifier.value);
    signal.throwIfAborted();
    const profiles = [...this.deps.profiles.findByCreditCodes([...codeSet]),
      ...this.deps.profiles.findByNormalizedNames(names)];
    const unique = [...new Map(profiles.map(profile => [profile.identity.creditCode, profile])).values()];
    signal.throwIfAborted();
    return new Map(organizations.map(item => [item.entity_id,
      resolveCompanyLink(item, links.get(item.entity_id) ?? null, unique)]));
  }

  private unavailable(id: string, warning: string): CompanySummary {
    return { state: 'unavailable', warnings: [warning],
      link: { state: 'unlinked', organization_id: id, credit_code: null, basis: null,
        version: 0, candidates: [], warnings: [warning] },
      has_profile: null, report_count: null, latest_report_at: null };
  }

  async summaries(ids: string[], signal?: AbortSignal): Promise<Map<string, CompanySummary>> {
    const active = this.active(signal);
    const requested = [...new Set(ids)];
    const result = new Map<string, CompanySummary>();
    if (!requested.length) return result;
    if (!this.deps.graph) return new Map(requested.map(id => [id, this.unavailable(id, 'GRAPH_NOT_CONFIGURED')]));
    const organizations: OrganizationIdentity[] = [];
    let complete = true;
    for (const batch of chunks(requested, BATCH)) {
      active.throwIfAborted();
      try {
        const read = await this.pages<OrganizationIdentity>('company_organizations',
          { entity_ids: batch, credit_codes: [], normalized_names: [] }, BATCH, active);
        organizations.push(...read.items);
        complete &&= read.complete;
      } catch {
        active.throwIfAborted();
        complete = false;
      }
    }
    const links = this.resolve(organizations, active);
    const confirmed = [...new Set([...links.values()].filter(link => link.state === 'confirmed')
      .map(link => link.credit_code).filter((code): code is string => !!code))];
    active.throwIfAborted();
    let reports = new Map<string, ReportSummary>();
    let reportsAvailable = true;
    try { reports = this.deps.assessments.summariesByCreditCodes(confirmed); }
    catch { active.throwIfAborted(); reportsAvailable = false; }
    active.throwIfAborted();
    for (const org of organizations) {
      if (!requested.includes(org.entity_id)) continue;
      const link = links.get(org.entity_id)!;
      const report = link.credit_code ? reports.get(link.credit_code) : null;
      result.set(org.entity_id, {
        state: complete && reportsAvailable ? 'ok' : 'partial',
        warnings: [...link.warnings, ...(!complete ? ['ORGANIZATIONS_INCOMPLETE'] : []),
          ...(!reportsAvailable ? ['REPORTS_UNAVAILABLE'] : [])], link,
        has_profile: link.state === 'confirmed' ? true : null,
        report_count: link.state === 'confirmed' && reportsAvailable ? report?.count ?? 0 : null,
        latest_report_at: link.state === 'confirmed' && reportsAvailable ? report?.latest?.generated_at ?? null : null,
      });
    }
    for (const id of requested) if (!result.has(id)) result.set(id,
      complete ? this.unavailable(id, 'ORGANIZATION_NOT_FOUND') : this.unavailable(id, 'ORGANIZATION_UNAVAILABLE'));
    return result;
  }

  async detail(id: string, offset: number, limit: number, signal?: AbortSignal): Promise<CompanyDetail> {
    const active = this.active(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error('INVALID_PAGINATION');
    const summary = (await this.summaries([id], active)).get(id)!;
    active.throwIfAborted();
    let profile: StoredCompanyProfile | null = null;
    let latest: ReportItem | null = null;
    let reports = UNKNOWN_REPORTS();
    if (summary.link.state === 'confirmed' && summary.link.credit_code) {
      try {
        profile = this.deps.profiles.findByCreditCodes([summary.link.credit_code])[0] ?? null;
        active.throwIfAborted();
        reports = this.deps.assessments.listCompleted(summary.link.credit_code, offset, limit);
        active.throwIfAborted();
        latest = this.deps.assessments.summariesByCreditCodes([summary.link.credit_code])
          .get(summary.link.credit_code)?.latest ?? null;
      } catch {
        active.throwIfAborted();
        return { ...summary, state: 'partial', warnings: [...summary.warnings, 'REPORTS_UNAVAILABLE'],
          profile, latest_report: null, reports: UNKNOWN_REPORTS() };
      }
    }
    return { ...summary, has_profile: summary.link.state === 'confirmed' ? profile !== null : null,
      profile, latest_report: latest, reports };
  }

  private async confirmedOrganizations(code: string, signal: AbortSignal): Promise<{
    ids: string[]; complete: boolean; available: boolean; warnings: string[] }> {
    const profile = this.deps.profiles.findByCreditCodes([code])[0];
    signal.throwIfAborted();
    if (!profile || !this.deps.graph) return { ids: [], complete: false, available: false,
      warnings: [!profile ? 'PROFILE_NOT_FOUND' : 'GRAPH_NOT_CONFIGURED'] };
    const names = [profile.identity.legalName, ...profile.identity.formerNames].map(normalize);
    const saved = this.deps.links.byCreditCode(code).map(link => link.organization_id);
    signal.throwIfAborted();
    const found = new Map<string, OrganizationIdentity>();
    let complete = true;
    let available = false;
    const warnings: string[] = [];
    try {
      const candidates = await this.pages<OrganizationIdentity>('company_organizations',
        { entity_ids: [], credit_codes: [code], normalized_names: names }, BATCH, signal);
      available = true;
      complete &&= candidates.complete;
      for (const item of candidates.items) found.set(item.entity_id, item);
    } catch { signal.throwIfAborted(); complete = false; warnings.push('ORGANIZATIONS_UNAVAILABLE'); }
    for (const batch of chunks(saved.filter(id => !found.has(id)), BATCH)) {
      signal.throwIfAborted();
      try {
        const read = await this.pages<OrganizationIdentity>('company_organizations',
          { entity_ids: batch, credit_codes: [], normalized_names: [] }, BATCH, signal);
        available = true;
        complete &&= read.complete;
        for (const item of read.items) found.set(item.entity_id, item);
      } catch { signal.throwIfAborted(); complete = false; warnings.push('ORGANIZATIONS_UNAVAILABLE'); }
    }
    const resolved = this.resolve([...found.values()], signal);
    const ids = [...resolved.values()].filter(link => link.state === 'confirmed' && link.credit_code === code)
      .map(link => link.organization_id).sort();
    if (!complete) warnings.push('ORGANIZATIONS_INCOMPLETE');
    return { ids, complete, available, warnings };
  }

  async overview(code: string, signal?: AbortSignal): Promise<CompanyOverview> {
    const active = this.active(signal);
    let reports: ReportSummary | null = null;
    let reportsAvailable = true;
    const warnings: string[] = [];
    try { reports = this.deps.assessments.summariesByCreditCodes([code]).get(code) ?? null; }
    catch { active.throwIfAborted(); reportsAvailable = false; warnings.push('REPORTS_UNAVAILABLE'); }
    active.throwIfAborted();
    if (!this.deps.graph) return { state: 'not_applicable', warnings, organization_ids: [],
      organizations_complete: false, people: count(new Set(), false),
      projects: count(new Set(), false), reports };
    const orgs = await this.confirmedOrganizations(code, active);
    warnings.push(...orgs.warnings);
    const people = new Set<string>(), projects = new Set<string>();
    let complete = orgs.complete;
    if (orgs.ids.length) {
      const relations: RelationItem[] = [];
      for (const batch of chunks(orgs.ids, BATCH)) {
        active.throwIfAborted();
        try {
          const read = await this.pages<RelationItem>('company_relations',
            { organization_ids: batch }, BATCH, active);
          relations.push(...read.items);
          complete &&= read.complete;
          if (!read.complete) warnings.push('RELATIONS_INCOMPLETE');
        } catch { active.throwIfAborted(); complete = false; warnings.push('RELATIONS_UNAVAILABLE'); }
      }
      const selected = new Set(orgs.ids);
      for (const relation of relations) if (relation.relation_type === 'clientOrganization'
        && selected.has(relation.target_id)) projects.add(relation.source_id);
      for (const relation of relations) if (
        (['worksFor', 'alumniOf', 'affiliation', 'memberOf'].includes(relation.relation_type)
          && selected.has(relation.target_id))
        || (relation.relation_type === 'memberOf' && projects.has(relation.target_id))) {
        people.add(relation.source_id);
      }
    }
    return { state: warnings.length ? (reportsAvailable || orgs.available ? 'partial' : 'unavailable') : 'ok', warnings,
      organization_ids: orgs.ids, organizations_complete: orgs.complete,
      people: count(people, complete), projects: count(projects, complete), reports };
  }

  async relatedUpdates(code: string, since: string, signal?: AbortSignal): Promise<RelatedUpdates> {
    const active = this.active(signal);
    if (!Number.isFinite(Date.parse(since))) throw new Error('INVALID_SINCE');
    const items: RecentRecord[] = [], scope: string[] = [], warnings: string[] = [];
    let truncated = false;
    let orgs = { ids: [] as string[], complete: false, available: false, warnings: [] as string[] };
    if (this.deps.graph) {
      orgs = await this.confirmedOrganizations(code, active);
      warnings.push(...orgs.warnings);
      truncated ||= !orgs.complete;
      if (orgs.ids.length) {
        let graphRead = false;
        let graphPages = 0;
        const graphSeen = new Set<string>();
        const batches = chunks(orgs.ids, BATCH);
        for (const [batchIndex, batch] of batches.entries()) {
          active.throwIfAborted();
          let offset = 0;
          let batchValid = 0;
          for (;;) {
            if (graphPages === MAX_PAGES) {
              warnings.push('GRAPH_UPDATES_PAGE_LIMIT');
              truncated = true;
              break;
            }
            try {
              const page = await this.request<Page<RecentRecord>>('company_recent_records',
                { organization_ids: batch, since, offset, limit: 20 }, active);
              graphPages++;
              graphRead = true;
              for (const item of page.items) {
                if (!item.entity_id) {
                  if (!warnings.includes('GRAPH_RECORD_UNATTRIBUTED')) warnings.push('GRAPH_RECORD_UNATTRIBUTED');
                  truncated = true;
                  continue;
                }
                if (!item.recorded_at || !Number.isFinite(Date.parse(item.recorded_at))
                  || Date.parse(item.recorded_at) <= Date.parse(since)) continue;
                const key = `${item.kind}\u0000${item.id}`;
                if (graphSeen.has(key)) continue;
                graphSeen.add(key);
                items.push(item);
                batchValid++;
              }
              if (page.complete && page.next_offset === null) break;
              if (page.next_offset === null || page.next_offset <= offset) {
                warnings.push('GRAPH_UPDATES_INCOMPLETE');
                truncated = true;
                break;
              }
              if (batchValid >= 20) { truncated = true; break; }
              offset = page.next_offset;
            } catch { active.throwIfAborted(); warnings.push('GRAPH_UPDATES_UNAVAILABLE'); truncated = true; break; }
          }
          if (graphPages === MAX_PAGES && batchIndex < batches.length - 1) {
            warnings.push('GRAPH_UPDATES_PAGE_LIMIT');
            truncated = true;
            break;
          }
        }
        if (graphRead) scope.push('graph');
      } else if (orgs.complete) scope.push('graph');
    }
    active.throwIfAborted();
    try {
      const profile = this.deps.profiles.findByCreditCodes([code])[0];
      if (profile?.collectedAt && Date.parse(profile.collectedAt) > Date.parse(since)) {
        items.push({ kind: 'profile', id: code, recorded_at: profile.collectedAt,
          label: '企业画像' });
      }
      scope.push('profile');
    } catch { active.throwIfAborted(); warnings.push('PROFILE_UPDATES_UNAVAILABLE'); }
    active.throwIfAborted();
    try {
      const page = this.deps.assessments.listCompleted(code, 0, 20);
      items.push(...page.items.filter(item => !!item.generated_at && Date.parse(item.generated_at) > Date.parse(since))
        .map(item => ({ kind: 'assessment' as const, id: item.assessment_id,
          recorded_at: item.generated_at, label: '已完成报告' })));
      truncated ||= page.next_offset !== null;
      scope.push('assessment');
    } catch { active.throwIfAborted(); warnings.push('ASSESSMENT_UPDATES_UNAVAILABLE'); }
    active.throwIfAborted();
    const unique = [...new Map(items.map(item => [`${item.kind}\u0000${item.id}`, item])).values()];
    unique.sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)
      || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    truncated ||= unique.length > 20;
    return { state: !this.deps.graph ? 'not_applicable' : warnings.length ? 'partial' : 'ok',
      warnings, since, scope, items: unique.slice(0, 20), truncated };
  }
}
