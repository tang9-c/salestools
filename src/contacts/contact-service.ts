import {
  ContactSnapshotPayloadSchema,
  ContactExtractionCandidateSchema,
  GetContactsOutputSchema,
  PublicIdentityTextSchema,
  redactPublicIdentityText,
  type ContactExtractionResult,
  type IdentityProfile,
  type ContactSnapshotPayload,
  type GetContactsOutput,
} from '../contracts/index.js';
import {
  contactCacheIdentity,
  projectContactHistory,
  type ContactCacheIdentity,
} from './contact-cache.js';
import {
  ContactSnapshotDataError,
  type ContactSnapshotStore,
} from '../db/contact-snapshot-repository.js';
import { CallBudget } from '../orchestration/call-budget.js';
import { UpstreamError } from '../orchestration/retry.js';
import { buildContactSearchPlan } from '../upstream/search/contact-search-plan.js';
import type { DoubaoWebResult } from '../upstream/search/mapper.js';
import type { DoubaoWebSearchRequest } from '../upstream/search/search-plan.js';
import type { ContactExtractionOptions } from '../upstream/ark/contact-extractor.js';

export interface RankedWebResult extends DoubaoWebResult {
  queryIndex: number;
}

export interface ContactSearchDependency {
  searchWeb(query: DoubaoWebSearchRequest, signal?: AbortSignal): Promise<DoubaoWebResult[]>;
}

export interface ContactExtractorDependency {
  extract(items: readonly RankedWebResult[], options?: ContactExtractionOptions): Promise<ContactExtractionResult>;
}

export interface ContactServiceOptions {
  searchClient: ContactSearchDependency;
  extractor: ContactExtractorDependency;
  snapshots: ContactSnapshotStore;
  onSnapshotAppended?: () => void | Promise<void>;
  cacheLogger?: ContactCacheLoggerDependency;
  now?: () => Date;
  findIdentity?: (query: string) => IdentityProfile | undefined;
  limits?: { search: number; ark: number; total: number };
}

export interface ContactCacheLoggerDependency {
  logContactCacheError(event: {
    operation: 'read' | 'parse' | 'write';
    cacheKey: string;
    error: Error;
  }): void;
}

export interface GetContactsServiceInput {
  query: string;
  regionHint?: string;
  webOffset?: number;
  webLimit?: number;
  webSnapshotId?: number;
}

export interface ContactServiceOutput {
  webPage?: { snapshotId: number; offset: number; limit: number; total: number; nextOffset: number | null };
  webCoverage?: ContactSnapshotPayload['coverage'] | null;
  companies: Array<{
    companyName: string;
    contacts: Array<{
      name: string;
      title: string | null;
      affiliationStatus?: 'employment_evidence' | 'unverified';
      evidenceQuote?: string;
      sourceUrl: string;
      publishedAt: string | null;
    }>;
    historicalContacts: Array<{
      name: string;
      title: string | null;
      affiliationStatus?: 'employment_evidence' | 'unverified';
      evidenceQuote?: string;
      sourceUrl: string;
      publishedAt: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
      status: 'historical_evidence';
    }>;
  }>;
  warnings: string[];
  collectedAt: string;
}

export class ContactLookupError extends Error {
  override readonly name = 'ContactLookupError';

  constructor(options?: ErrorOptions) {
    super('公开联系人查询暂不可用，请稍后重试', options);
  }
}

export class ContactPaginationError extends Error {
  override readonly name = 'ContactPaginationError';

  constructor(readonly code: 'INVALID_PAGE' | 'SNAPSHOT_MISMATCH') {
    super(code === 'INVALID_PAGE' ? '网页分页参数无效，请从第 0 页重新发起'
      : '网页分页快照不存在或查询/地域不匹配，请从第 0 页重新发起');
  }
}

const CONTACT_CACHE_TTL_DAYS = 30;
const STALE_WARNING = '实时刷新失败，使用超过 30 天的历史缓存';

function compareItems(left: RankedWebResult, right: RankedWebResult): number {
  return left.queryIndex - right.queryIndex
    || left.position - right.position
    || left.url.localeCompare(right.url);
}

export class ContactService {
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<ContactServiceOutput>>();

  constructor(private readonly options: ContactServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async get(input: GetContactsServiceInput): Promise<ContactServiceOutput> {
    const identity = contactCacheIdentity(input);
    const offset = input.webOffset ?? 0;
    const limit = input.webLimit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (offset > 0 && input.webSnapshotId === undefined)
      || (input.webSnapshotId !== undefined && (!Number.isSafeInteger(input.webSnapshotId) || input.webSnapshotId < 1))) {
      throw new ContactPaginationError('INVALID_PAGE');
    }
    if (input.webSnapshotId !== undefined) {
      const snapshots = this.cacheOperation('read', identity.cacheKey, () => this.options.snapshots.findThroughSnapshot(identity.cacheKey, input.webSnapshotId!));
      if (!snapshots?.some(row => row.snapshotId === input.webSnapshotId)) throw new ContactPaginationError('SNAPSHOT_MISMATCH');
      const anchored = projectContactHistory(snapshots, input.webSnapshotId);
      const anchor = snapshots.find(row => row.snapshotId === input.webSnapshotId)!;
      if (anchor.payload.coverage?.version !== 2) anchored.warnings.push('旧发现规则的历史资料，尚未完成增强搜索');
      if (this.now().getTime() - Date.parse(anchor.storedAt) > CONTACT_CACHE_TTL_DAYS * 86_400_000) anchored.warnings.push('正在读取超过 30 天的历史资料');
      return this.page(toServiceOutput(anchored), input.webSnapshotId, offset, limit);
    }
    const fresh = this.cacheOperation('read', identity.cacheKey, () => (
      this.options.snapshots.findFresh(
        identity.cacheKey,
        this.now(),
        CONTACT_CACHE_TTL_DAYS,
      )
    ));
    const result = fresh?.payload.coverage?.version === 2 ? this.render(identity.cacheKey)
      : await this.singleflight(identity.cacheKey, () => this.refreshAndStore(input, identity));
    return this.page(result, result.webPage!.snapshotId, offset, limit);
  }

  private page(output: ContactServiceOutput, snapshotId: number, offset: number, limit: number): ContactServiceOutput {
    const normalize = (value: string | null | undefined) => (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    const compare = (a: ContactServiceOutput['companies'][number]['contacts'][number], b: typeof a) => {
      for (const [left, right] of [[normalize(a.name), normalize(b.name)], [normalize(a.title), normalize(b.title)],
        [a.sourceUrl, b.sourceUrl], [a.evidenceQuote ?? '', b.evidenceQuote ?? ''], [a.affiliationStatus ?? '', b.affiliationStatus ?? '']]) {
        const order = left!.localeCompare(right!); if (order) return order;
      }
      return 0;
    };
    let cursor = 0;
    const total = output.companies.reduce((sum, company) => sum + company.contacts.length + company.historicalContacts.length, 0);
    const companies = [...output.companies].sort((a, b) => normalize(a.companyName).localeCompare(normalize(b.companyName))).map(company => ({ ...company,
      contacts: [...company.contacts].sort(compare).filter(() => { const i = cursor++; return i >= offset && i < offset + limit; }),
      historicalContacts: [...company.historicalContacts].sort(compare).filter(() => { const i = cursor++; return i >= offset && i < offset + limit; }),
    })).filter(company => company.contacts.length + company.historicalContacts.length > 0);
    return { ...output, companies: companies.map(company => ({ ...company,
      contacts: company.contacts.map(contact => ({ ...contact, sourceUrl: publicUrl(contact.sourceUrl) })),
      historicalContacts: company.historicalContacts.map(contact => ({ ...contact, sourceUrl: publicUrl(contact.sourceUrl) })),
    })), webCoverage: output.webCoverage ? { ...output.webCoverage, pending_pages: output.webCoverage.pending_pages.map(publicUrl) } : null,
    webPage: { snapshotId, offset, limit, total, nextOffset: offset + limit < total ? offset + limit : null } };
  }

  private async fetchSnapshot(input: GetContactsServiceInput): Promise<ContactSnapshotPayload> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const limits = this.options.limits;
      const budget = new CallBudget(
        {
          qcc: 0,
          doubaoSearch: Math.min(8, limits?.search ?? 8),
          ark: Math.min(8, limits?.ark ?? 8),
          total: Math.min(16, limits?.total ?? 16),
        },
        { reserveArkCalls: Math.min(2, limits?.ark ?? 8, limits?.total ?? 16) },
      );
      let profile: ReturnType<NonNullable<ContactServiceOptions['findIdentity']>>;
      let plan: ReturnType<typeof buildContactSearchPlan>;
      try {
        profile = this.options.findIdentity?.(input.query);
        plan = buildContactSearchPlan(input.query, input.regionHint, profile);
      } catch (error) {
        throw new ContactLookupError({ cause: error });
      }
      const searches: Array<{ status: 'completed'; value: { queryIndex: number; items: DoubaoWebResult[] } } | { status: 'failed' }> = [];
      let next = 0;
      const worker = async () => {
        while (next < plan.length && !controller.signal.aborted) {
          const queryIndex = next++;
          let completed = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (controller.signal.aborted || !budget.tryConsume('doubao_search')) break;
            try {
              const items = await this.options.searchClient.searchWeb(plan[queryIndex]!, controller.signal);
              searches.push({ status: 'completed', value: { queryIndex, items } });
              completed = true;
              break;
            } catch (error) {
              if (error instanceof UpstreamError && ['ABORTED', 'AUTHENTICATION_ERROR', 'QUOTA_EXCEEDED'].includes(error.code)) break;
            }
          }
          if (!completed) searches.push({ status: 'failed' });
        }
      };
      await Promise.all([worker(), worker()]);
      const successful = searches.filter(result => result.status === 'completed');
      if (successful.length === 0) throw new ContactLookupError();

      const warnings = successful.length < plan.length
        ? ['部分公开网页搜索失败，结果可能不完整']
        : [];
      const items = successful.flatMap(result => result.value.items.map(item => ({
        ...item,
        queryIndex: result.value.queryIndex,
      }))).sort(compareItems);

      let value: ContactExtractionResult;
      try {
        value = await this.options.extractor.extract(items, {
          signal: controller.signal,
          budget,
          subject: { query: input.query, identity: profile },
        });
      } catch (error) {
        throw new ContactLookupError({ cause: error });
      }
      warnings.push(...(value.warnings ?? []));
      if (!profile) warnings.push('主体未完全确认，保留原文企业名称');
      if (value.selection.textTruncated
        || value.selection.includedPages < value.selection.totalPages) {
        warnings.push('部分搜索页面或正文因模型输入容量限制未进入抽取');
      }

      const rankedByUrl = new Map<string, RankedWebResult>();
      for (const item of items) {
        if (!rankedByUrl.has(item.url)) rankedByUrl.set(item.url, item);
      }
      const supported = value.contacts.flatMap(candidate => {
        const parsed = ContactExtractionCandidateSchema.safeParse(candidate);
        if (!parsed.success) return [];
        let contact = parsed.data;
        if (![contact.companyName, contact.name, contact.title].filter(value => value !== null)
          .every(value => PublicIdentityTextSchema.safeParse(value).success)) return [];
        const source = rankedByUrl.get(contact.sourceUrl);
        if (source === undefined || !contact.evidenceQuote) return [];
        const raw = items.filter(item => item.url === contact.sourceUrl)
          .map(item => [item.title, item.summary, item.content].filter(Boolean).join('\n')).join('\n');
        if (!raw.includes(contact.evidenceQuote) || ![contact.companyName, contact.name, contact.title]
          .filter((value): value is string => value !== null).every(value => contact.evidenceQuote.includes(value))) return [];
        const quote = redactPublicIdentityText(contact.evidenceQuote);
        const retainedFields = [contact.companyName, contact.name, contact.title]
          .filter((field): field is string => field !== null);
        if (!PublicIdentityTextSchema.safeParse(quote).success
          || !retainedFields.every(field => quote.includes(field.normalize('NFKC')))) return [];
        contact = { ...contact, evidenceQuote: quote };
        return [{ contact, source }];
      }).sort((left, right) => compareItems(left.source, right.source));

      const companies: ContactServiceOutput['companies'] = [];
      const companyByName = new Map<string, ContactServiceOutput['companies'][number]>();
      const seen = new Set<string>();
      for (const { contact, source } of supported) {
        const companyName = contact.companyName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
        const companyKey = companyName;
        const contactKey = JSON.stringify([
          companyKey, contact.name.trim(), contact.title?.trim() ?? null,
          source.url, contact.evidenceQuote, contact.affiliationStatus,
        ]);
        if (seen.has(contactKey)) continue;

        let company = companyByName.get(companyKey);
        if (company === undefined) {
          company = { companyName, contacts: [], historicalContacts: [] };
          companies.push(company);
          companyByName.set(companyKey, company);
        }
        seen.add(contactKey);
        company.contacts.push({
          name: contact.name.trim(),
          title: contact.title?.trim() ?? null,
          affiliationStatus: contact.affiliationStatus,
          evidenceQuote: contact.evidenceQuote,
          sourceUrl: source.url,
          publishedAt: source.publishedAt,
        });
      }

      if (companies.length === 0 && warnings.length === 0) {
        warnings.push('本次可得材料中未发现通过证据验证的职业人物');
      }
      return ContactSnapshotPayloadSchema.parse({
        companies: companies.map(company => ({
          company_name: company.companyName,
          contacts: company.contacts.map(contact => ({
            name: contact.name,
            title: contact.title,
            affiliation_status: contact.affiliationStatus,
            evidence_quote: contact.evidenceQuote,
            source_url: contact.sourceUrl,
            published_at: contact.publishedAt,
          })),
        })),
        warnings,
        coverage: value.coverage ? {
          ...value.coverage,
          complete: value.coverage.complete && successful.length === plan.length,
        } : undefined,
        collected_at: this.now().toISOString(),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async refreshAndStore(
    input: GetContactsServiceInput,
    identity: ContactCacheIdentity,
  ): Promise<ContactServiceOutput> {
    const fresh = this.cacheOperation('read', identity.cacheKey, () => (
      this.options.snapshots.findFresh(
        identity.cacheKey,
        this.now(),
        CONTACT_CACHE_TTL_DAYS,
      )
    ));
    if (fresh?.payload.coverage?.version === 2) return this.render(identity.cacheKey);

    let payload: ContactSnapshotPayload;
    try {
      payload = await this.fetchSnapshot(input);
    } catch (error) {
      if (!(error instanceof ContactLookupError)) throw error;
      const latest = this.cacheOperation('read', identity.cacheKey, () => (
        this.options.snapshots.findLatest(identity.cacheKey)
      ));
      if (latest === null) throw error;
      const projected = this.render(identity.cacheKey);
      return { ...projected, warnings: [...new Set([...projected.warnings,
        ...(this.now().getTime() - Date.parse(latest.storedAt) > CONTACT_CACHE_TTL_DAYS * 86_400_000 ? [STALE_WARNING] : []),
        ...(latest.payload.coverage?.version === 2 ? [] : ['旧发现规则的历史资料，尚未完成增强搜索'])])] };
    }

    const storedAt = this.now().toISOString();
    this.cacheOperation('write', identity.cacheKey, () => this.options.snapshots.append({
      ...identity,
      payload,
      storedAt,
    }));
    try {
      void Promise.resolve(this.options.onSnapshotAppended?.()).catch(() => undefined);
    } catch {
      // Graph synchronization must not change the legacy search response.
    }
    return this.render(identity.cacheKey);
  }

  private render(cacheKey: string): ContactServiceOutput {
    const latest = this.cacheOperation('read', cacheKey, () => this.options.snapshots.findLatest(cacheKey))!;
    const snapshots = this.cacheOperation('read', cacheKey, () => this.options.snapshots.findAll(cacheKey)).filter(row => row.snapshotId <= latest.snapshotId);
    const output = toServiceOutput(projectContactHistory(snapshots, latest.snapshotId));
    return { ...output, webPage: { snapshotId: latest.snapshotId, offset: 0, limit: 50, total: 0, nextOffset: null } };
  }

  private cacheOperation<T>(
    operation: 'read' | 'write',
    cacheKey: string,
    action: () => T,
  ): T {
    try {
      return action();
    } catch (error) {
      const safeError = error instanceof Error ? error : new Error('Unknown contact cache error');
      this.options.cacheLogger?.logContactCacheError({
        operation: safeError instanceof ContactSnapshotDataError ? 'parse' : operation,
        cacheKey,
        error: safeError,
      });
      throw error;
    }
  }

  private singleflight(
    cacheKey: string,
    operation: () => Promise<ContactServiceOutput>,
  ): Promise<ContactServiceOutput> {
    const existing = this.inFlight.get(cacheKey);
    if (existing !== undefined) return existing;
    const pending = operation().finally(() => {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }
}

function publicUrl(value: string): string {
  // Public search only needs a navigable source. Query and fragment often carry
  // direct contact values; keep those in private provenance, never in this API.
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  const directContact = /(?:[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\+?\d[\d\s().-]{5,}\d)/iu;
  if (directContact.test(url.hostname.normalize('NFKC'))) return 'https://redacted.invalid/';
  let path = url.pathname;
  for (let step = 0; step < 3; step += 1) {
    try { path = decodeURIComponent(path); }
    catch { break; }
  }
  // URL separators are evidence boundaries, like whitespace in a public quote.
  // Reuse the public identity rule so full-width digits and explicit accounts
  // receive the same treatment as names, titles and quotes.
  if (!PublicIdentityTextSchema.safeParse(path.normalize('NFKC').replace(/[\/\\]+/gu, ' ')).success) url.pathname = '/';
  return url.toString();
}

function toServiceOutput(output: GetContactsOutput): ContactServiceOutput {
  return {
    companies: output.companies.map(company => ({
      companyName: company.company_name,
      contacts: company.contacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        sourceUrl: contact.source_url,
        publishedAt: contact.published_at,
        ...(contact.affiliation_status === undefined ? {} : { affiliationStatus: contact.affiliation_status }),
        ...(contact.evidence_quote === undefined ? {} : { evidenceQuote: contact.evidence_quote }),
      })),
      historicalContacts: company.historical_contacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        sourceUrl: contact.source_url,
        publishedAt: contact.published_at,
        ...(contact.affiliation_status === undefined ? {} : { affiliationStatus: contact.affiliation_status }),
        ...(contact.evidence_quote === undefined ? {} : { evidenceQuote: contact.evidence_quote }),
        firstSeenAt: contact.first_seen_at,
        lastSeenAt: contact.last_seen_at,
        status: contact.status,
      })),
    })),
    warnings: output.warnings,
    webCoverage: output.web_coverage ?? null,
    collectedAt: output.collected_at,
  };
}
