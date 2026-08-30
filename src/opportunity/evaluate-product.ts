import {
  countIndependentPublishers,
  type EvidenceBundle,
  type EvidenceFact,
  type EvidenceReference,
  type OpportunityLevel,
  type ProductKey,
  type ProductOpportunity,
} from '../contracts/index.js';
import {
  CRITICAL_CONFLICT_KEYWORDS,
  GENERAL_BLOCKER_KEYWORDS,
  REPLACEMENT_KEYWORDS,
  type ProductRule,
} from './product-rules.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_DAYS = 365;
const COMPLEXITY_KINDS = new Set<EvidenceFact['kind']>(['organization', 'quality', 'manufacturing']);
const SUPPORT_KINDS = new Set<EvidenceFact['kind']>([
  'product_scene', 'recruitment', 'software_ecosystem', 'organization', 'quality',
  'manufacturing', 'procurement', 'budget', 'decision_power', 'risk',
]);
const UNKNOWN_SIGNAL_KEYWORDS = ['待核实', '未知', '未确认', '未披露', '无法确认', '不明确', '尚未'] as const;
const POSITIVE_BUDGET_KEYWORDS = ['预算已批准', '预算充足', '专项预算已落实', '资金充足', '融资到账'] as const;
const POSITIVE_DECISION_KEYWORDS = ['具有独立决策权', '独立采购决策权', '拥有独立采购权', '可自主采购', '采购审批权归属目标主体'] as const;
const NEGATIVE_BUDGET_PATTERN = /(?:(?:无|没有|并无|并非|不具备|缺少|暂无|未有).{0,8}(?:预算|资金))|(?:(?:预算|资金).{0,6}(?:不足|未落实|未批准|冻结))/u;
const NEGATIVE_DECISION_PATTERN = /(?:无|没有|并无|并非|并不|不具备|缺少|暂无|未有).{0,12}(?:独立|自主)?.{0,8}(?:采购|决策|审批)(?:权)?/u;
const NEGATED_REPLACEMENT_PATTERN = /(?:暂无|尚无|没有|无|不|暂不|不计划).{0,8}(?:替换|替代|迁移|重新选型|重选|换型)/u;

type PublicationState = 'recent' | 'expired' | 'future' | 'missing';
type AttributionState = 'confirmed' | 'probable' | 'unverified';

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsKeyword(statement: string, keyword: string): boolean {
  const text = normalized(statement);
  const term = normalized(keyword);
  if (term.length === 0) return false;
  const startsWithWord = /^[a-z0-9]/.test(term);
  const endsWithWord = /[a-z0-9]$/.test(term);
  const prefix = startsWithWord ? '(?:^|[^a-z0-9])' : '';
  const suffix = endsWithWord ? '(?=$|[^a-z0-9])' : '';
  return new RegExp(`${prefix}${escapeRegex(term)}${suffix}`, 'u').test(text);
}

function containsAny(statement: string, keywords: readonly string[]): boolean {
  return keywords.some(keyword => containsKeyword(statement, keyword));
}

function citedReferences(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): EvidenceReference[] {
  return fact.evidenceIds.flatMap(id => {
    const reference = referencesById.get(id);
    return reference === undefined ? [] : [reference];
  });
}

function publicationState(timestamp: string | null, nowMs: number): PublicationState {
  if (timestamp === null) return 'missing';
  const publishedAt = Date.parse(timestamp);
  if (publishedAt > nowMs) return 'future';
  return nowMs - publishedAt <= RECENT_DAYS * DAY_MS ? 'recent' : 'expired';
}

function factPublicationState(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
  nowMs: number,
): PublicationState {
  const states = citedReferences(fact, referencesById)
    .map(reference => publicationState(reference.publishedAt, nowMs));
  if (states.includes('recent')) return 'recent';
  if (states.includes('future')) return 'future';
  if (states.includes('expired')) return 'expired';
  return 'missing';
}

function isRecentTimestamp(timestamp: string | null, nowMs: number): boolean {
  return publicationState(timestamp, nowMs) === 'recent';
}

function factAttribution(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): AttributionState {
  if (fact.entityScope !== 'legal_entity' || fact.entityMatch === 'unverified') return 'unverified';
  const references = citedReferences(fact, referencesById);
  if (references.length !== fact.evidenceIds.length || references.length === 0) return 'unverified';
  const agrees = references.every(reference =>
    reference.entityScope === fact.entityScope && reference.entityMatch === fact.entityMatch);
  return agrees ? fact.entityMatch : 'unverified';
}

function isConfirmedTargetFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  return factAttribution(fact, referencesById) === 'confirmed';
}

function isReliableConfirmedFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  return fact.strength !== 'weak' && isConfirmedTargetFact(fact, referencesById);
}

function isReliableTargetFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  const attribution = factAttribution(fact, referencesById);
  return fact.strength !== 'weak'
    && (attribution === 'confirmed' || (attribution === 'probable' && fact.strength === 'direct'));
}

function financingIsAttributedToTarget(
  evidenceIds: readonly string[],
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  if (evidenceIds.length === 0) return false;
  return evidenceIds.every(evidenceId => {
    const reference = referencesById.get(evidenceId);
    return reference?.entityScope === 'legal_entity' && reference.entityMatch === 'confirmed';
  });
}

function isRelevant(fact: EvidenceFact, product: ProductKey): boolean {
  return fact.productTags.includes(product)
    || (fact.productTags.length === 0 && SUPPORT_KINDS.has(fact.kind));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function positiveDecisionFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  if (fact.kind !== 'decision_power' || !isReliableConfirmedFact(fact, referencesById)) return false;
  return !NEGATIVE_DECISION_PATTERN.test(normalized(fact.statement))
    && !containsAny(fact.statement, [...GENERAL_BLOCKER_KEYWORDS, ...UNKNOWN_SIGNAL_KEYWORDS])
    && containsAny(fact.statement, POSITIVE_DECISION_KEYWORDS);
}

function positiveBudgetFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  if (fact.kind !== 'budget' || !isReliableConfirmedFact(fact, referencesById)) return false;
  return !NEGATIVE_BUDGET_PATTERN.test(normalized(fact.statement))
    && !containsAny(fact.statement, [...GENERAL_BLOCKER_KEYWORDS, ...UNKNOWN_SIGNAL_KEYWORDS])
    && containsAny(fact.statement, POSITIVE_BUDGET_KEYWORDS);
}

function negativeSupportKind(fact: EvidenceFact): 'budget' | 'decision' | null {
  const statement = normalized(fact.statement);
  if (fact.kind === 'budget' && NEGATIVE_BUDGET_PATTERN.test(statement)) return 'budget';
  if (fact.kind === 'decision_power' && NEGATIVE_DECISION_PATTERN.test(statement)) return 'decision';
  return null;
}

function explicitReplacement(statement: string): boolean {
  const text = normalized(statement);
  return !NEGATED_REPLACEMENT_PATTERN.test(text) && containsAny(text, REPLACEMENT_KEYWORDS);
}

function hasReplacementSignal(
  rule: ProductRule,
  facts: readonly EvidenceFact[],
  referencesById: ReadonlyMap<string, EvidenceReference>,
  nowMs: number,
): boolean {
  return facts.some(fact => isReliableTargetFact(fact, referencesById)
    && factPublicationState(fact, referencesById, nowMs) === 'recent'
    && explicitReplacement(fact.statement)
    && containsAny(fact.statement, [...rule.positiveKeywords, ...rule.engineeringMethods, ...rule.competitorKeywords]));
}

function blockerDescriptions(
  rule: ProductRule,
  facts: readonly EvidenceFact[],
  referencesById: ReadonlyMap<string, EvidenceReference>,
  nowMs: number,
): string[] {
  const replacement = hasReplacementSignal(rule, facts, referencesById, nowMs);
  const blockers: string[] = [];
  for (const fact of facts) {
    if (!isReliableTargetFact(fact, referencesById)) continue;
    const general = GENERAL_BLOCKER_KEYWORDS.find(keyword => containsKeyword(fact.statement, keyword));
    const negativeKind = negativeSupportKind(fact);
    const productBlocker = rule.blockerKeywords.find(keyword => containsKeyword(fact.statement, keyword));
    const competitor = rule.competitorKeywords.find(keyword => containsKeyword(fact.statement, keyword));
    if (general !== undefined) blockers.push(`已知预算或决策阻碍：${general}`);
    if (general === undefined && negativeKind !== null) {
      blockers.push(negativeKind === 'budget' ? '已知预算阻碍：明确否定预算能力' : '已知决策阻碍：明确否定独立采购权');
    }
    if (productBlocker !== undefined) blockers.push(`已知系统阻碍：${productBlocker}`);
    if (competitor !== undefined && !replacement
      && ['recruitment', 'software_ecosystem', 'product_scene'].includes(fact.kind)) {
      blockers.push(`已发现竞品或替代生态 ${competitor}，未发现有效替换信号`);
    }
  }
  return uniqueInOrder(blockers);
}

function criticalConflict(conflicts: readonly string[]): boolean {
  return conflicts.some(conflict => containsAny(conflict, CRITICAL_CONFLICT_KEYWORDS));
}

export type ProductEvaluation = Readonly<{
  opportunity: ProductOpportunity;
  directConfirmedEvidenceCount: number;
  hasPositiveSupport: boolean;
  onlyWeakOrProbablePositiveSupport: boolean;
}>;

export function evaluateProduct(
  evidence: EvidenceBundle,
  rule: ProductRule,
  now: Date,
): ProductEvaluation {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid Date');

  const referencesById = new Map(evidence.evidence.map(reference => [reference.evidenceId, reference]));
  const relevantFacts = evidence.facts.filter(fact => isRelevant(fact, rule.product));
  const productFacts = relevantFacts.filter(fact => fact.productTags.includes(rule.product));
  const usableFacts = relevantFacts.filter(fact => isReliableConfirmedFact(fact, referencesById));
  const targetNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.positiveKeywords);
  const methodNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.engineeringMethods);
  const competitorNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.competitorKeywords);
  const hasProductSignal = (fact: EvidenceFact): boolean => targetNamed(fact) || methodNamed(fact);
  const isPositiveProductFact = (fact: EvidenceFact): boolean => {
    if (!['product_scene', 'recruitment', 'software_ecosystem', 'procurement'].includes(fact.kind)) return false;
    return hasProductSignal(fact) && !competitorNamed(fact);
  };
  const confirmedProductFacts = productFacts.filter(fact => isConfirmedTargetFact(fact, referencesById));
  const recruitmentWithSignal = confirmedProductFacts.filter(fact =>
    fact.kind === 'recruitment' && hasProductSignal(fact));
  const recentDirectRecruitment = recruitmentWithSignal.filter(fact => fact.strength === 'direct'
    && factPublicationState(fact, referencesById, nowMs) === 'recent');
  const directSceneFacts = confirmedProductFacts.filter(fact => fact.strength === 'direct'
    && ((fact.kind === 'product_scene' && hasProductSignal(fact))
      || (fact.kind === 'procurement' && hasProductSignal(fact))))
    .concat(recentDirectRecruitment);
  const confirmedScene = directSceneFacts.length > 0;

  const complexityFacts = usableFacts.filter(fact => (fact.productTags.includes(rule.product)
    && COMPLEXITY_KINDS.has(fact.kind))
    || (fact.kind === 'product_scene' && methodNamed(fact)));
  const targetEcosystemFacts = confirmedProductFacts.filter(fact => fact.strength !== 'weak'
    && ((fact.kind === 'software_ecosystem' && hasProductSignal(fact))
      || (fact.kind === 'recruitment' && hasProductSignal(fact))));
  const blockers = blockerDescriptions(rule, relevantFacts, referencesById, nowMs);
  const strongBlocker = blockers.length > 0;

  const recentFinancing = evidence.financingRecords.filter(record =>
    isRecentTimestamp(record.occurredAt, nowMs)
    && financingIsAttributedToTarget(record.evidenceIds, referencesById));
  const recentTimingFacts = usableFacts.filter(fact =>
    ((fact.kind === 'recruitment' && fact.productTags.includes(rule.product) && hasProductSignal(fact)
      && factPublicationState(fact, referencesById, nowMs) === 'recent')
      || (fact.kind === 'procurement' && fact.productTags.includes(rule.product) && hasProductSignal(fact)
        && factPublicationState(fact, referencesById, nowMs) === 'recent')
      || (['organization', 'manufacturing'].includes(fact.kind)
        && factPublicationState(fact, referencesById, nowMs) === 'recent'
        && containsAny(fact.statement, ['扩产', '新建', '新增', '升级', '数字化', '研发中心']))));
  const recentTiming = recentTimingFacts.length > 0 || recentFinancing.length > 0;
  const budgetSupport = usableFacts.some(fact => positiveBudgetFact(fact, referencesById))
    || recentFinancing.length > 0;
  const decisionSupport = usableFacts.some(fact => positiveDecisionFact(fact, referencesById));

  const publisherFactIds = uniqueInOrder([
    ...directSceneFacts,
    ...complexityFacts,
    ...recentTimingFacts,
  ].flatMap(fact => fact.evidenceIds));
  const supportingEvidenceIds = uniqueInOrder([
    ...publisherFactIds,
    ...(confirmedScene ? recentFinancing.flatMap(record => record.evidenceIds) : []),
  ]);
  const supportingReferences = supportingEvidenceIds.flatMap(id => {
    const reference = referencesById.get(id);
    if (reference?.entityScope !== 'legal_entity' || reference.entityMatch !== 'confirmed') return [];
    return [reference];
  });
  const publisherCount = countIndependentPublishers(supportingReferences);

  const positiveFacts = productFacts.filter(isPositiveProductFact);
  const allSupportingUnverified = positiveFacts.length > 0
    && positiveFacts.every(fact => factAttribution(fact, referencesById) === 'unverified');
  let level: OpportunityLevel;
  const reasons: string[] = [];
  const gaps: string[] = [];

  if (evidence.industryClassification === 'unverified'
    || criticalConflict(evidence.conflicts)
    || allSupportingUnverified) {
    level = '待核实';
    if (evidence.industryClassification === 'unverified') gaps.push('行业尚未核实');
    if (criticalConflict(evidence.conflicts)) gaps.push('存在关键主体或来源冲突');
    if (allSupportingUnverified) gaps.push('当前产品相关证据的主体归属均未核实');
  } else if (confirmedScene
    && publisherCount >= 2
    && complexityFacts.length > 0
    && recentTiming
    && budgetSupport
    && decisionSupport
    && !strongBlocker) {
    level = '高';
    reasons.push('已确认具体产品或工程场景');
    reasons.push(`有 ${publisherCount} 个独立原始发布方支持`);
    reasons.push('复杂度、近期时机、预算与决策权证据齐备');
  } else if (confirmedScene
    && usableFacts.length > 0
    && (complexityFacts.length > 0 || targetEcosystemFacts.length > 0)
    && !strongBlocker) {
    level = '中';
    reasons.push('已确认产品或工程场景，但高机会条件未齐备');
    if (publisherCount < 2) gaps.push('少于两个独立原始发布方');
    if (!recentTiming) gaps.push('缺少最近 365 天的采购时机信号');
    if (!budgetSupport) gaps.push('预算能力待核实');
    if (!decisionSupport) gaps.push('独立决策权待核实');
  } else if (evidence.industryClassification === 'P1'
    || evidence.industryClassification === 'P2'
    || evidence.industryClassification === 'non_target') {
    level = '低';
    if (!confirmedScene) gaps.push('未发现可归属于目标法定主体的具体产品场景');
    if (confirmedScene && complexityFacts.length === 0 && targetEcosystemFacts.length === 0) {
      gaps.push('缺少匹配的工程、组织复杂度或软件生态证据');
    }
    if (strongBlocker) reasons.push('已知替代生态或预算/决策阻碍使切入机会偏低');
  } else {
    level = '待核实';
    gaps.push('证据不足，无法形成稳定判断');
  }

  const recruitmentStates = recruitmentWithSignal.map(fact =>
    factPublicationState(fact, referencesById, nowMs));
  if (recruitmentStates.includes('expired')) gaps.push('招聘信息超过 365 天，仅作历史软件生态证据');
  if (recruitmentStates.includes('missing')) gaps.push('招聘信息发布时间缺失，无法作为近期时机信号');
  if (recruitmentStates.includes('future')) gaps.push('招聘信息发布时间晚于评估时间，无法作为当前信号');

  const outputEvidenceIds = uniqueInOrder([
    ...relevantFacts.flatMap(fact => fact.evidenceIds),
    ...(confirmedScene ? recentFinancing.flatMap(record => record.evidenceIds) : []),
  ]);
  return {
    opportunity: {
      product: rule.product,
      level,
      evidenceIds: outputEvidenceIds,
      reasons: uniqueInOrder(reasons),
      blockers,
      gaps: uniqueInOrder(gaps),
    },
    directConfirmedEvidenceCount: positiveFacts.filter(fact => fact.strength === 'direct'
      && isConfirmedTargetFact(fact, referencesById)).length,
    hasPositiveSupport: positiveFacts.length > 0,
    onlyWeakOrProbablePositiveSupport: positiveFacts.length > 0
      && positiveFacts.every(fact => fact.strength === 'weak'
        || factAttribution(fact, referencesById) !== 'confirmed'),
  };
}
