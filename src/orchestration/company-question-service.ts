import { createMaterialReadContext, readSelectedReport, selectReportForQuestion, dedupeMaterials, validateContextRefs } from '../companies/company-evidence.js';
import type { CompanyContextService } from '../companies/company-context-service.js';
import type { ContextMaterial, ContextCitation, ReportItem, Page } from '../companies/company-context-types.js';
import type {
  CompanyAnswerClaim, CompanyQuestionResult, EvidenceFact, EvidenceSnapshot,
  IdentityProfile, ResearchItem, SnapshotItem,
} from '../contracts/index.js';
import type { AssessmentRecord } from '../db/assessment-repository.js';
import type { StoredCompanyProfile } from '../db/profile-repository.js';
import { mapQccToolResult } from '../upstream/qcc/mapper.js';
import {
  buildQuestionSearchPlan, questionTopics, type QuestionTopic, type SearchQuery,
} from '../upstream/search/search-plan.js';
import type { CompanyAnswerInput } from '../upstream/ark/company-answer.js';

interface AssessmentStore {
  get(id: string): AssessmentRecord | null;
  listCompleted(code: string, offset: number, limit: number): Page<ReportItem>;
}
interface ProfileStore {
  findFreshByCreditCode(code: string, now: Date, ttlDays: number): StoredCompanyProfile | null;
}
interface QccQuestionGateway {
  call(server: 'operation', tool: string, input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
interface QuestionSearchClient {
  search(query: SearchQuery, signal?: AbortSignal): Promise<ResearchItem[]>;
}
interface QuestionAnswerClient {
  answer(input: CompanyAnswerInput): Promise<{
    claims: CompanyAnswerClaim[];
    omittedCount?: number;
    includedEvidenceIds?: string[];
    includedContextRefs?: string[];
  }>;
}

export interface CompanyQuestionInput {
  legalName: string;
  creditCode: string;
  question: string;
  assessmentId?: string;
}

export interface CompanyQuestionOptions {
  companyContext?: Pick<CompanyContextService, 'materials'>;
  profiles: ProfileStore;
  assessments: AssessmentStore;
  profileTtlDays: number;
  now?: () => Date;
  qccFactory: (signal: AbortSignal) => QccQuestionGateway;
  searchFactory: (signal: AbortSignal) => QuestionSearchClient;
  answerFactory: (signal: AbortSignal) => QuestionAnswerClient;
  requestTimeoutMs?: number;
}

function failed(legalName: string, reason: string, usedFreshResearch = false): CompanyQuestionResult {
  return { status: 'failed', legalName, markdown: `追问失败：${reason}`, usedFreshResearch, collectedAt: null, sources: [] };
}

function chooseQccTool(question: string): string | null {
  if (/(?:招聘|岗位|职位|JD)/iu.test(question)) return 'get_recruitment_info';
  if (/(?:融资|投资轮)/u.test(question)) return 'get_financing_records';
  if (/(?:招标|招投标|中标|采购公告)/u.test(question)) return 'get_bidding_info';
  return null;
}

const TOPIC_LABELS: Record<QuestionTopic, string> = {
  products: '产品发布', recruitment: '招聘', expansion: '融资或扩产', procurement: '采购公告',
};

function qccTopic(tool: string | null): QuestionTopic | null {
  if (tool === 'get_recruitment_info') return 'recruitment';
  if (tool === 'get_financing_records') return 'expansion';
  if (tool === 'get_bidding_info') return 'procurement';
  return null;
}

function queryTopic(query: SearchQuery): QuestionTopic | null {
  if (query.purpose === 'recruitment') return 'recruitment';
  if (query.purpose === 'expansion_financing') return 'expansion';
  if (query.purpose === 'procurement') return 'procurement';
  return /(?:产品|新品|新机型)/u.test(query.Query) ? 'products' : null;
}

function matchesTopic(item: Pick<SnapshotItem, 'title' | 'excerpt'>, topic: QuestionTopic): boolean {
  const text = `${item.title} ${item.excerpt ?? ''}`;
  const pattern: Record<QuestionTopic, RegExp> = {
    products: /(?:产品|新品|新机型|型号|推出)/u,
    recruitment: /(?:招聘|岗位|职位|工程师)/u,
    expansion: /(?:融资|扩产|产能|扩张|工厂)/u,
    procurement: /(?:采购公告|招标|中标|采购项目)/u,
  };
  return pattern[topic].test(text);
}

function claimMentionsTopic(text: string, topic: QuestionTopic): boolean {
  const pattern: Record<QuestionTopic, RegExp> = {
    products: /(?:产品|新品|新机型|推出)/u,
    recruitment: /(?:招聘|岗位|职位|工程师)/u,
    expansion: /(?:融资|扩产|产能|扩张|工厂)/u,
    procurement: /(?:采购|招标|中标)/u,
  };
  return pattern[topic].test(text);
}

function orderEvidence(
  items: SnapshotItem[], topics: QuestionTopic[], tagged: Map<string, QuestionTopic>,
): SnapshotItem[] {
  const seen = new Set<string>();
  const unique = items.filter(item => {
    const key = item.evidenceId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (topics.length < 2) return unique;
  const groups = topics.map(topic => unique.filter(item =>
    item.entityScope === 'legal_entity' && item.entityMatch === 'confirmed'
      && tagged.get(item.evidenceId) === topic && matchesTopic(item, topic)));
  const ordered: SnapshotItem[] = [];
  const used = new Set<string>();
  for (let index = 0; groups.some(group => index < group.length); index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (item !== undefined && !used.has(item.evidenceId)) {
        ordered.push(item);
        used.add(item.evidenceId);
      }
    }
  }
  return [...ordered, ...unique.filter(item => !used.has(item.evidenceId))];
}

const DYNAMIC = /(?:最新|近期|最近|目前|当前|趋势|近一年|今年|发布|招聘趋势|扩张信号)/u;
const PRODUCTS = /\b(?:solid\s*works|windchill|feigenbaum|creo|catia|abaqus|cst|plm|qms|pdm)\b/iu;

export function canReuse(snapshot: EvidenceSnapshot, question: string, now: Date): boolean {
  const collected = Date.parse(snapshot.collectedAt);
  if (collected > now.getTime() || collected < now.getTime() - 30 * 86_400_000) return false;
  if (DYNAMIC.test(question)) return false;
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  const product = normalizedQuestion.match(PRODUCTS)?.[0]?.replace(/\s+/gu, '');
  const matching = snapshot.items.filter(item => item.entityScope === 'legal_entity'
    && item.entityMatch === 'confirmed'
    && (product !== undefined
      ? `${item.title} ${item.excerpt ?? ''} ${snapshot.facts.filter(fact => fact.evidenceIds.includes(item.evidenceId)).map(fact => fact.statement).join(' ')}`
        .normalize('NFKC').toLowerCase().replace(/\s+/gu, '').includes(product)
      : item.title.length >= 5 && normalizedQuestion.includes(item.title.normalize('NFKC').toLowerCase())));
  return matching.some(item => snapshot.facts.some(fact => fact.evidenceIds.includes(item.evidenceId)
    && fact.entityScope === 'legal_entity' && fact.entityMatch === 'confirmed'));
}

function snapshotOf(items: ResearchItem[], at: string): EvidenceSnapshot {
  return {
    collectedAt: at,
    items: items.map(item => {
      const raw = item.content ?? item.summary;
      return {
        evidenceId: item.evidenceId, source: item.source, sourceKind: item.sourceKind,
        title: item.title, url: item.url, originalPublisher: item.originalPublisher,
        originalDomain: item.originalDomain, publishedAt: item.publishedAt,
        collectedAt: item.collectedAt, mentionedName: item.mentionedName,
        entityScope: item.entityScope, entityMatch: item.entityMatch,
        matchBasis: item.matchBasis, excerpt: raw?.slice(0, 600) ?? null,
        excerptTruncated: raw !== null && raw.length > 600,
      };
    }),
    facts: [],
  };
}

function verifyWebSubject(item: ResearchItem, identity: IdentityProfile): ResearchItem {
  if (item.source !== 'doubao_search' || item.entityMatch !== 'confirmed') return item;
  const lead = [item.title, item.summary ?? '', item.content?.slice(0, 400) ?? ''].join('\n');
  const relatedCompanies = [identity.parentLegalName, ...identity.subsidiaryLegalNames]
    .filter((name): name is string => name !== null && name.length > 0);
  const conflictingSubject = relatedCompanies.some(name => item.title.includes(name)
    || (item.summary ?? '').includes(name));
  const relatedEntityLanguage = /(?:旗下子公司|控股子公司|子公司|集团旗下|关联企业|关联公司)/u
    .test(`${item.title} ${item.summary ?? ''}`);
  const officialDomain = item.originalDomain !== null
    && identity.officialDomains.some(domain => domain.replace(/^www\./iu, '').toLowerCase()
      === item.originalDomain?.replace(/^www\./iu, '').toLowerCase());
  if (!conflictingSubject && !relatedEntityLanguage
    && (lead.includes(identity.legalName) || officialDomain)) return item;
  return {
    ...item, entityScope: 'unknown', entityMatch: 'unverified',
    matchBasis: [...item.matchBasis, conflictingSubject || relatedEntityLanguage
      ? '标题或摘要指向关联企业，不能归属于本法定主体'
      : '法定名称仅出现在正文后部，核心主体未确认'],
  };
}

function markdownText(value: string): string {
  return value.replace(/[\r\n\t\u2028\u2029]+/gu, ' ').trim()
    .replace(/[\\`*_{}\[\]()#+.!|>~-]/gu, '\\$&');
}

function directlySupportsPurchase(
  claim: CompanyAnswerClaim,
  byId: ReadonlyMap<string, SnapshotItem>,
  legalName: string,
): boolean {
  const product = claim.text.normalize('NFKC').toLowerCase().match(PRODUCTS)?.[0]?.replace(/\s+/gu, '');
  const completedClaim = /(?:已(?:经)?采购|采购了|已购买)/u.test(claim.text);
  return claim.evidenceIds.some(id => {
    const item = byId.get(id)!;
    if (/(?:招聘|岗位|职位|get_recruitment_info)/iu.test(`${item.evidenceId} ${item.title}`)) return false;
    const text = `${item.title} ${item.excerpt ?? ''}`.normalize('NFKC');
    if (!/(?:采购公告|招标公告|中标公告|成交公告|采购合同|采购意向|招投标)/u.test(text)) return false;
    if (product !== undefined && !text.toLowerCase().replace(/\s+/gu, '').includes(product)) return false;
    if (completedClaim && !/(?:成交|合同|验收|已采购|中标结果)/u.test(text)) return false;
    const purchaser = text.match(/"purchaser"\s*:\s*"([^"]+)"/u)?.[1];
    if (purchaser !== undefined) return purchaser.includes(legalName);
    const position = item.title.indexOf(legalName);
    const action = position < 0 ? '' : item.title.slice(position + legalName.length);
    return /^.{0,16}(?:采购公告|招标公告|拟采购|采购意向)/u.test(action)
      && !action.startsWith('中标');
  });
}

function sourceLine(item: SnapshotItem, number: number): string {
  const title = markdownText(item.title);
  const citation = item.url === null
    ? `${title}（企查查记录，无直达链接）`
    : `[${title}](<${item.url.replace(/[<>]/gu, value => value === '<' ? '%3C' : '%3E')}>)`;
  return `${number}. ${citation}${item.publishedAt === null ? '' : `，发布于 ${item.publishedAt.slice(0, 10)}`}`;
}

function render(
  legalName: string,
  claims: CompanyAnswerClaim[],
  items: SnapshotItem[],
  limitations: string[],
  omittedCount: number,
  usedFreshResearch: boolean,
  collectedAt: string,
  unansweredTopics: QuestionTopic[] = [],
  unansweredPurchaseInference = false,
  context: ContextMaterial[] = [],
  contextWarnings: string[] = [],
): CompanyQuestionResult {
  const byId = new Map(items.map(item => [item.evidenceId, item]));
  const sections = [
    ['资料直接支持', claims.filter(claim => claim.category === 'supported')],
    ['可能的解释，但未获证实', claims.filter(claim => claim.category === 'interpretation')],
    ['仍需核实', claims.filter(claim => claim.category === 'unknown')],
  ] as const;
  const usedIds = [...new Set(claims.flatMap(claim => claim.evidenceIds))];
  const sources = usedIds.flatMap(id => {
    const item = byId.get(id);
    return item === undefined ? [] : [{ title: item.title, source: item.source, url: item.url, publishedAt: item.publishedAt }];
  });
  const cited = new Map(usedIds.map((id, index) => [id, index + 1]));
  const lines = [`# ${legalName}｜定向追问`, ''];
  for (const [heading, group] of sections) {
    if (group.length === 0) continue;
    lines.push(`## ${heading}`, '');
    for (const claim of group) {
      const refs = claim.evidenceIds.map(id => cited.get(id)).filter((value): value is number => value !== undefined);
      const contextRefs = (claim.contextRefs ?? []).map(markdownText);
      lines.push(`- ${markdownText(claim.text)}${refs.length === 0 ? '' : ` [${refs.join('、')}]`}${contextRefs.length === 0 ? '' : `（库内来源：${contextRefs.join('、')}）`}`);
    }
    lines.push('');
  }
  if (usedIds.length > 0) {
    lines.push('## 来源', '');
    usedIds.forEach((id, index) => {
      const item = byId.get(id);
      if (item !== undefined) lines.push(sourceLine(item, index + 1));
    });
    lines.push('');
  }
  const unanswered = unansweredTopics.map(topic =>
    `- ${TOPIC_LABELS[topic]}：本次纳入的证据不足以核实，不能据此认定不存在。`);
  if (unansweredPurchaseInference) {
    unanswered.push('- 软件采购计划：本次回答未能判断，不能从招聘或产品发布推断采购意向。');
  }
  if (unanswered.length > 0) {
    lines.push('## 尚未回答', '', ...unanswered, '');
  }
  const gaps = [...limitations, ...(omittedCount > 0 ? [`模型容量限制，未纳入 ${omittedCount} 条材料`] : [])];
  if (gaps.length > 0) lines.push('## 资料限制', '', ...gaps.map(gap => `- ${gap}`), '');
  const answered = unanswered.length === 0 && claims.some(claim => claim.category === 'supported');
  if (!claims.some(claim => claim.category === 'supported')) {
    lines.splice(2, 0, '没有足够的已确认主体证据回答这个问题。', '');
  }
  const contextCitations = validateContextRefs(claims.flatMap(claim=>claim.contextRefs ?? []),context);
  if (contextCitations.length) lines.push('## 库内来源','',...contextCitations.map(c=>`- ${markdownText(c.ref)}：${markdownText(c.quote ?? String(c.value ?? '已有资料'))}`));
  return {
    ...(contextCitations.length ? {context_citations:contextCitations}:{}),
    ...(contextWarnings.length ? {context_warnings:contextWarnings}:{}),
    status: answered ? 'answered' : 'insufficient', legalName,
    markdown: lines.join('\n').trim(), usedFreshResearch, collectedAt, sources,
  };
}

export class CompanyQuestionService {
  private readonly now: () => Date;
  constructor(private readonly options: CompanyQuestionOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async ask(input: CompanyQuestionInput, signal?: AbortSignal): Promise<CompanyQuestionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('deadline'), this.options.requestTimeoutMs ?? 55_000);
    timeout.unref();
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    let usedFreshResearch = false;
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('question-aborted'));
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    try {
      return await Promise.race([this.execute(input, combined, () => { usedFreshResearch = true; }), abortPromise]);
    } catch {
      return failed(input.legalName, combined.aborted ? '请求超时或已取消' : '服务暂不可用', usedFreshResearch);
    } finally {
      clearTimeout(timeout);
      if (onAbort !== undefined) combined.removeEventListener('abort', onAbort);
    }
  }

  private async execute(input: CompanyQuestionInput, signal: AbortSignal, markFresh: () => void): Promise<CompanyQuestionResult> {
    const now = this.now();
    const topics = questionTopics(input.question);
    const asksPurchaseInference = /(?:能否|是否|能不能|可否|能证明|可证明).{0,30}(?:软件)?(?:采购|购买)(?:计划|意向|需求)?/u
      .test(input.question);
    const tagged = new Map<string, QuestionTopic>();
    const profile = this.options.profiles.findFreshByCreditCode(input.creditCode, now, this.options.profileTtlDays);
    if (profile === null || profile.identity.legalName !== input.legalName || profile.identity.creditCode !== input.creditCode) {
      return failed(input.legalName, '主体未确认或画像已过期，请先调用 get_company_profile');
    }
    signal.throwIfAborted();
    const contextWarnings: string[] = [];
    let reports: ReportItem[] = [];
    if (input.assessmentId === undefined) {
      try { reports = this.options.assessments.listCompleted(input.creditCode,0,1).items; }
      catch { signal.throwIfAborted(); contextWarnings.push('REPORT_DIRECTORY_UNAVAILABLE'); }
    }
    const readContext = createMaterialReadContext(signal,selectReportForQuestion(reports,input.assessmentId));
    let report: AssessmentRecord | null = null;
    try { report = readSelectedReport(readContext,id=>this.options.assessments.get(id)); }
    catch { signal.throwIfAborted(); contextWarnings.push('REPORT_UNAVAILABLE'); }
    if (input.assessmentId !== undefined && (report === null || report.status !== 'completed'
      || report.legalName !== input.legalName || report.creditCode !== input.creditCode)) {
      return failed(input.legalName, '指定报告不存在、未完成或主体不一致');
    }
    const selectedContext = readContext;
    let context: ContextMaterial[] = [];
    if (this.options.companyContext) {
      try {
        const found = await this.options.companyContext.materials(input.creditCode,input.question,selectedContext);
        signal.throwIfAborted();
        context = dedupeMaterials(found.items).slice(0,20);
        contextWarnings.push(...found.warnings);
      } catch { signal.throwIfAborted(); contextWarnings.push('COMPANY_CONTEXT_UNAVAILABLE'); }
    }
    const snapshot = report?.evidenceSnapshot;
    const reuse = snapshot !== null && snapshot !== undefined && canReuse(snapshot, input.question, now);
    let material: EvidenceSnapshot;
    const limitations: string[] = [];
    const contextOnly = context.some(item=>item.citation.source_type === 'contact' && ['worksFor','memberOf','clientOrganization'].includes(item.predicate)) && /(?:联系人|库内|任职|关系|项目|客户)/u.test(input.question) && !/(?:招聘|产品发布|融资|扩产|招标|公告|公开动态|新闻)/u.test(input.question);
    if (contextOnly) {
      material = {collectedAt:now.toISOString(),items:[],facts:[]};
    } else if (reuse) {
      material = snapshot;
    } else {
      markFresh();
      const items: ResearchItem[] = [];
      const tool = chooseQccTool(input.question);
      let qccCovered: QuestionTopic | undefined;
      if (tool !== null) {
        const gateway = this.options.qccFactory(signal);
        try {
          const payload = await gateway.call('operation', tool, { searchKey: profile.identity.creditCode });
          if (signal.aborted) throw new Error('question-aborted');
          const found = mapQccToolResult('operation', tool, payload, profile.identity, this.now()).items;
          items.push(...found);
          const topic = qccTopic(tool);
          if (topic !== null && found.length > 0) {
            qccCovered = topic;
            found.forEach(item => tagged.set(item.evidenceId, topic));
          }
        } catch { signal.throwIfAborted(); limitations.push('企查查定向查询失败'); }
        finally { await gateway.close().catch(() => undefined); }
      }
      const search = this.options.searchFactory(signal);
      const queries = buildQuestionSearchPlan(profile.identity, input.question, qccCovered);
      const planned = new Set(queries.map(queryTopic));
      if (qccCovered !== undefined) planned.add(qccCovered);
      for (const topic of topics) {
        if (!planned.has(topic)) limitations.push(`查询上限内未检索${TOPIC_LABELS[topic]}`);
      }
      for (const query of queries.slice(0, 2)) {
        if (signal.aborted) break;
        try {
          const found = await search.search(query, signal);
          if (signal.aborted) throw new Error('question-aborted');
          const verified = found.map(item => verifyWebSubject(item, profile.identity));
          items.push(...verified);
          const topic = queryTopic(query);
          if (topic !== null) verified.forEach(item => {
            if (!tagged.has(item.evidenceId)) tagged.set(item.evidenceId, topic);
          });
        }
        catch { signal.throwIfAborted(); limitations.push('豆包搜索定向查询失败'); }
      }
      material = snapshotOf(items, this.now().toISOString());
      if (snapshot === null && report !== null) limitations.push('原报告没有可复用的证据快照，已尝试定向补查');
    }
    const confirmed = material.items.filter(item => item.entityScope === 'legal_entity' && item.entityMatch === 'confirmed');
    if (signal.aborted) throw new Error('question-aborted');
    if (confirmed.length === 0 && context.length === 0) {
      return render(input.legalName, [], material.items, limitations, 0, !reuse, material.collectedAt,
        topics, asksPurchaseInference, context, contextWarnings);
    }
    const product = input.question.normalize('NFKC').toLowerCase().match(PRODUCTS)?.[0]?.replace(/\s+/gu, '');
    for (const item of material.items) {
      if (tagged.has(item.evidenceId)) continue;
      const topic = topics.find(candidate => matchesTopic(item, candidate));
      if (topic !== undefined) tagged.set(item.evidenceId, topic);
    }
    const orderedItems = orderEvidence(material.items, topics, tagged);
    if (topics.length < 2) orderedItems.sort((left, right) => {
      const rank = (item: SnapshotItem) => {
        const confirmed = item.entityScope === 'legal_entity' && item.entityMatch === 'confirmed' ? 2 : 0;
        const relevant = product !== undefined && `${item.title} ${item.excerpt ?? ''}`
          .normalize('NFKC').toLowerCase().replace(/\s+/gu, '').includes(product) ? 1 : 0;
        return confirmed + relevant;
      };
      return rank(right) - rank(left);
    });
    const snapshotIds = new Set(material.items.map(item=>item.evidenceId));
    context = context.filter(item=>item.citation.source_type !== 'assessment' || !snapshotIds.has(item.citation.evidence_id ?? ''));
    const answer = await this.options.answerFactory(signal).answer({
      legalName: profile.identity.legalName, question: input.question,
      items: orderedItems, facts: material.facts, context,
    });
    const includedContext = context.filter(item=>(answer.includedContextRefs ?? []).includes(item.citation.ref));
    const included = new Set(answer.includedEvidenceIds ?? material.items.map(item => item.evidenceId));
    const byId = new Map(material.items.map(item => [item.evidenceId, item]));
    const claims = answer.claims.flatMap(claim => {
      let citations: ContextCitation[];
      try { citations = validateContextRefs(claim.contextRefs ?? [],includedContext); } catch { return []; }
      if (claim.evidenceIds.some(id => !included.has(id) || !byId.has(id))) return [];
      const hasUnconfirmedSource = claim.evidenceIds.some(id => {
        const item = byId.get(id)!;
        return item.entityScope !== 'legal_entity' || item.entityMatch !== 'confirmed';
      });
      if (hasUnconfirmedSource && claim.category !== 'unknown') {
        return [{ ...claim, category: 'unknown' as const }];
      }
      if (claim.category === 'supported') {
        if (claim.evidenceIds.length === 0 && citations.length === 0) return [];
        if ((claim.contextRefs?.length ?? 0) > 0 && /(?:拥有|具有|有|掌握|负责).{0,8}(?:采购权|采购决定权|采购决策权)/u.test(claim.text)) return [];
        const affirmativePurchase = /(?:已(?:经)?采购|采购了|计划采购|拟采购|正在采购|准备采购|即将采购|采购意向|采购需求|预算已落实|已有专项预算|已购买|正在购买)/u;
        const directProcurementSource = directlySupportsPurchase(claim, byId, profile.identity.legalName);
        const unsupportedPurchase = claim.text.split(/[，。；;！!]/u).some(clause => {
          const match = affirmativePurchase.exec(clause);
          if (match === null) return false;
          const negated = /(?:不能证明|无法证明|不能据此|不代表|不等于|尚不能|未见证据|没有证据)/u
            .test(clause.slice(0, match.index));
          return !negated && !directProcurementSource;
        });
        if (unsupportedPurchase) return [];
        if (/(?:增长|增加|上升|下降|减少|增至|翻倍|倍增|从\s*\d+.*(?:到|至)\s*\d+)/u.test(claim.text)
          && /\d/u.test(claim.text)) return [];
        if (/(?:持续|增长|增加|上升|下降|减少|同比|环比|趋势)/u.test(claim.text)) {
          const dates = new Set(claim.evidenceIds.map(id => byId.get(id)?.publishedAt?.slice(0, 10)).filter(Boolean));
          if (dates.size < 2) return [];
        }
      }
      return [claim];
    });
    const scopedClaims = claims.flatMap(claim => {
      if (topics.includes('products')
        && /(?:未查询到|未查到|没有|未见|不存在).*(?:产品|新品).*(?:发布|信息)?/u.test(claim.text)) {
        return [{ category: 'unknown' as const, text: '本次纳入的证据不足以核实产品发布。', evidenceIds: [] }];
      }
      if (claim.category === 'supported' && /\d+\s*条招聘/u.test(claim.text)) {
        const hiringIds = claim.evidenceIds.filter(id => {
          const item = byId.get(id);
          return item !== undefined && matchesTopic(item, 'recruitment');
        });
        return hiringIds.length === 0 ? [] : [{ ...claim,
          text: '本次引用的招聘材料显示相关岗位需求。',
          evidenceIds: hiringIds }];
      }
      return [claim];
    });
    const answeredTopics = new Set(scopedClaims.filter(claim => claim.category === 'supported')
      .flatMap(claim => claim.evidenceIds.map(id => tagged.get(id))
        .filter((topic): topic is QuestionTopic => topic !== undefined && claimMentionsTopic(claim.text, topic))));
    const purchaseAnswered = scopedClaims.some(claim =>
      /(?:采购|购买)/u.test(claim.text)
      && /(?:计划|意向|需求|证明|无法|不能|未获证实|已采购)/u.test(claim.text));
    return render(input.legalName, scopedClaims, material.items, limitations,
      answer.omittedCount ?? 0, !reuse && !contextOnly, material.collectedAt,
      topics.length < 2 ? [] : topics.filter(topic => !answeredTopics.has(topic)),
      asksPurchaseInference && !purchaseAnswered, includedContext, contextWarnings);
  }
}
