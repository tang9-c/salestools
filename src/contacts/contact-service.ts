import {
  ContactSnapshotPayloadSchema,
  GetContactsOutputSchema,
  PublicIdentityTextSchema,
  type ContactExtractionCandidate,
  type ContactExtractionResult,
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
import { retryOnce } from '../orchestration/retry.js';
import { buildContactSearchPlan } from '../upstream/search/contact-search-plan.js';
import type { DoubaoWebResult } from '../upstream/search/mapper.js';
import type { DoubaoWebSearchRequest } from '../upstream/search/search-plan.js';

export interface RankedWebResult extends DoubaoWebResult {
  queryIndex: number;
}

export interface ContactSearchDependency {
  searchWeb(query: DoubaoWebSearchRequest): Promise<DoubaoWebResult[]>;
}

export interface ContactExtractorDependency {
  extract(items: readonly RankedWebResult[]): Promise<ContactExtractionResult>;
}

export interface ContactServiceOptions {
  searchClient: ContactSearchDependency;
  extractor: ContactExtractorDependency;
  snapshots: ContactSnapshotStore;
  cacheLogger?: ContactCacheLoggerDependency;
  now?: () => Date;
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
}

export interface ContactServiceOutput {
  companies: Array<{
    companyName: string;
    contacts: Array<{
      name: string;
      title: string;
      sourceUrl: string;
      publishedAt: string | null;
    }>;
    historicalContacts: Array<{
      name: string;
      title: string;
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

const CONTACT_CACHE_TTL_DAYS = 30;
const STALE_WARNING = '实时刷新失败，使用超过 30 天的历史缓存';

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function searchableText(item: DoubaoWebResult): string {
  return normalize([item.title, item.summary, item.content]
    .filter((value): value is string => value !== null)
    .join(' '));
}

function hasLeadershipLevel(title: string): boolean {
  return /(?:董事长|总经理|总裁|首席|总监|负责人|副总|经理|director|chief|head|\b(?:vp|cio|cto)\b)/iu.test(title);
}

function roleMatches(contact: ContactExtractionCandidate): boolean {
  const title = normalize(contact.title);
  if (/(?:助理|秘书|assistant|coordinator)/iu.test(title)) return false;
  switch (contact.roleCategory) {
    case 'executive':
      if (/(?:办公室|总裁办|董事长办|总经理办|主任|专员)/u.test(title)) return false;
      return /(?:董事长|总经理|总裁|执行董事|法定代表人|创始人|合伙人|ceo|chief executive)/iu.test(title);
    case 'research_and_development':
      return /(?:研发|研究|技术|工程|cto|首席技术官)/iu.test(title) && hasLeadershipLevel(title);
    case 'digital_and_it':
      return /(?:信息化|数字化|信息技术|\bit\b|cio|首席信息官)/iu.test(title) && hasLeadershipLevel(title);
    case 'procurement':
      return /(?:采购|供应链)/u.test(title) && hasLeadershipLevel(title);
    case 'quality':
      return /(?:质量|品质)/u.test(title) && hasLeadershipLevel(title);
  }
}

function companyStem(companyName: string): string {
  return normalize(companyName).replace(/(?:有限责任公司|股份有限公司|有限公司|集团公司|集团)$/u, '');
}

const OfficialNewsPublisherByDomain = new Map<string, RegExp>([
  ['jwview.com', /中新经纬/u],
  ['chinanews.com', /(?:中国新闻网|中新网)/u],
  ['xinhuanet.com', /(?:新华网|新华社)/u],
  ['people.com.cn', /(?:人民网|人民日报)/u],
  ['cctv.com', /(?:央视|中央广播电视总台)/u],
  ['cqn.com.cn', /(?:中国质量新闻网|中国质量报)/u],
]);

function isOfficialNewsPublisher(source: DoubaoWebResult): boolean {
  const host = source.originalDomain.toLowerCase();
  for (const [domain, publisher] of OfficialNewsPublisherByDomain) {
    if ((host === domain || host.endsWith(`.${domain}`)) && publisher.test(source.originalPublisher ?? '')) {
      return true;
    }
  }
  return false;
}

function sourceMatches(companyName: string, source: DoubaoWebResult): boolean {
  const text = searchableText(source);
  const publisher = normalize(source.originalPublisher ?? '');
  const title = normalize(source.title);
  const stem = companyStem(companyName);
  const publisherMatchesCompany = stem.length >= 2 && publisher.includes(stem);
  const officialWechat = source.originalDomain === 'mp.weixin.qq.com'
    && /(?:公众号|微信公众|微信)/u.test(`${publisher} ${title} ${text}`);
  const officialNews = isOfficialNewsPublisher(source);
  const tender = /(?:招标|投标|中标|采购公告|采购项目|采购文件|采购合同)/u.test(text);
  const patent = /(?:专利|发明人|申请号|授权公告)/u.test(text);
  const conference = /(?:会议|峰会|论坛|大会|嘉宾)/u.test(text);
  return publisherMatchesCompany || officialNews || officialWechat || tender || patent || conference;
}

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
    const fresh = this.cacheOperation('read', identity.cacheKey, () => (
      this.options.snapshots.findFresh(
        identity.cacheKey,
        this.now(),
        CONTACT_CACHE_TTL_DAYS,
      )
    ));
    if (fresh !== null) return this.render(identity.cacheKey);
    return this.singleflight(identity.cacheKey, () => this.refreshAndStore(input, identity));
  }

  private async fetchSnapshot(input: GetContactsServiceInput): Promise<ContactSnapshotPayload> {
    const budget = new CallBudget(
      { qcc: 0, doubaoSearch: 4, ark: 2, total: 6 },
      { reserveArkCalls: 2 },
    );
    const plan = buildContactSearchPlan(input.query, input.regionHint);
    const searches = await Promise.all(plan.map((query, queryIndex) => (
      retryOnce('doubao_search', budget, async () => ({
        queryIndex,
        items: await this.options.searchClient.searchWeb(query),
      }))
    )));
    const successful = searches.filter(result => result.status === 'completed');
    if (successful.length === 0) throw new ContactLookupError();

    const warnings = successful.length < searches.length
      ? ['部分公开网页搜索失败，结果可能不完整']
      : [];
    const items = successful.flatMap(result => result.value.items.map(item => ({
      ...item,
      queryIndex: result.value.queryIndex,
    }))).sort(compareItems);

    const extraction = await retryOnce('ark', budget, () => this.options.extractor.extract(items));
    if (extraction.status === 'failed') throw new ContactLookupError({ cause: extraction.error });
    if (extraction.value.selection.textTruncated
      || extraction.value.selection.includedPages < extraction.value.selection.totalPages) {
      warnings.push('部分搜索页面或正文因模型输入容量限制未进入抽取');
    }

    const rankedByUrl = new Map<string, RankedWebResult>();
    for (const item of items) {
      if (!rankedByUrl.has(item.url)) rankedByUrl.set(item.url, item);
    }
    const supported = extraction.value.contacts.flatMap(contact => {
      if (![contact.companyName, contact.name, contact.title]
        .every(value => PublicIdentityTextSchema.safeParse(value).success)) return [];
      const source = rankedByUrl.get(contact.sourceUrl);
      if (source === undefined) return [];
      const text = searchableText(source);
      if (!roleMatches(contact) || !sourceMatches(contact.companyName, source)) return [];
      if (![contact.companyName, contact.name, contact.title]
        .every(value => text.includes(normalize(value)))) return [];
      return [{ contact, source }];
    }).sort((left, right) => compareItems(left.source, right.source));

    const companies: ContactServiceOutput['companies'] = [];
    const companyByName = new Map<string, ContactServiceOutput['companies'][number]>();
    const seen = new Set<string>();
    for (const { contact, source } of supported) {
      const companyKey = normalize(contact.companyName);
      const contactKey = `${companyKey}\0${normalize(contact.name)}\0${normalize(contact.title)}`;
      if (seen.has(contactKey)) continue;

      let company = companyByName.get(companyKey);
      if (company === undefined) {
        if (companies.length >= 3) continue;
        company = { companyName: contact.companyName.trim(), contacts: [], historicalContacts: [] };
        companies.push(company);
        companyByName.set(companyKey, company);
      }
      if (company.contacts.length >= 10) continue;
      seen.add(contactKey);
      company.contacts.push({
        name: contact.name.trim(),
        title: contact.title.trim(),
        sourceUrl: source.url,
        publishedAt: source.publishedAt,
      });
    }

    if (companies.length === 0 && warnings.length === 0) {
      warnings.push('未发现满足证据要求的关键岗位人员');
    }
    return ContactSnapshotPayloadSchema.parse({
      companies: companies.map(company => ({
        company_name: company.companyName,
        contacts: company.contacts.map(contact => ({
          name: contact.name,
          title: contact.title,
          source_url: contact.sourceUrl,
          published_at: contact.publishedAt,
        })),
      })),
      warnings,
      collected_at: this.now().toISOString(),
    });
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
    if (fresh !== null) return this.render(identity.cacheKey);

    let payload: ContactSnapshotPayload;
    try {
      payload = await this.fetchSnapshot(input);
    } catch (error) {
      if (!(error instanceof ContactLookupError)) throw error;
      const latest = this.cacheOperation('read', identity.cacheKey, () => (
        this.options.snapshots.findLatest(identity.cacheKey)
      ));
      if (latest === null) throw error;
      const projected = this.project(identity.cacheKey);
      return toServiceOutput(GetContactsOutputSchema.parse({
        ...projected,
        warnings: [...new Set([...projected.warnings, STALE_WARNING])],
      }));
    }

    const storedAt = this.now().toISOString();
    this.cacheOperation('write', identity.cacheKey, () => this.options.snapshots.append({
      ...identity,
      payload,
      storedAt,
    }));
    return this.render(identity.cacheKey);
  }

  private project(cacheKey: string): GetContactsOutput {
    const snapshots = this.cacheOperation('read', cacheKey, () => (
      this.options.snapshots.findAll(cacheKey)
    ));
    return projectContactHistory(snapshots);
  }

  private render(cacheKey: string): ContactServiceOutput {
    return toServiceOutput(this.project(cacheKey));
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

function toServiceOutput(output: GetContactsOutput): ContactServiceOutput {
  return {
    companies: output.companies.map(company => ({
      companyName: company.company_name,
      contacts: company.contacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        sourceUrl: contact.source_url,
        publishedAt: contact.published_at,
      })),
      historicalContacts: company.historical_contacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        sourceUrl: contact.source_url,
        publishedAt: contact.published_at,
        firstSeenAt: contact.first_seen_at,
        lastSeenAt: contact.last_seen_at,
        status: contact.status,
      })),
    })),
    warnings: output.warnings,
    collectedAt: output.collected_at,
  };
}
