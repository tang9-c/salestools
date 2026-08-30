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
const POSITIVE_BUDGET_KEYWORDS = ['预算已批准', '预算充足', '有预算', '专项预算', '资金充足', '融资到账'] as const;
const POSITIVE_DECISION_KEYWORDS = ['独立决策权', '独立采购', '自主采购', '采购决策权', '采购审批权'] as const;

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

function isRecentTimestamp(timestamp: string | null, nowMs: number): boolean {
  if (timestamp === null) return false;
  const occurredAt = Date.parse(timestamp);
  return occurredAt <= nowMs && nowMs - occurredAt <= RECENT_DAYS * DAY_MS;
}

function factHasRecentReference(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
  nowMs: number,
): boolean {
  return citedReferences(fact, referencesById)
    .some(reference => isRecentTimestamp(reference.publishedAt, nowMs));
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

function isAttributedToTarget(fact: EvidenceFact): boolean {
  return fact.entityScope === 'legal_entity' && fact.entityMatch === 'confirmed';
}

function isReliable(fact: EvidenceFact): boolean {
  return fact.strength !== 'weak' && fact.entityMatch !== 'unverified';
}

function isRelevant(fact: EvidenceFact, product: ProductKey): boolean {
  return fact.productTags.includes(product)
    || (fact.productTags.length === 0 && SUPPORT_KINDS.has(fact.kind));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function positiveDecisionFact(fact: EvidenceFact): boolean {
  if (fact.kind !== 'decision_power' || !isAttributedToTarget(fact) || !isReliable(fact)) return false;
  return !containsAny(fact.statement, [...GENERAL_BLOCKER_KEYWORDS, ...UNKNOWN_SIGNAL_KEYWORDS])
    && containsAny(fact.statement, POSITIVE_DECISION_KEYWORDS);
}

function positiveBudgetFact(fact: EvidenceFact): boolean {
  if (fact.kind !== 'budget' || !isAttributedToTarget(fact) || !isReliable(fact)) return false;
  return !containsAny(fact.statement, [...GENERAL_BLOCKER_KEYWORDS, ...UNKNOWN_SIGNAL_KEYWORDS])
    && containsAny(fact.statement, POSITIVE_BUDGET_KEYWORDS);
}

function hasReplacementSignal(facts: readonly EvidenceFact[]): boolean {
  return facts.some(fact => containsAny(fact.statement, REPLACEMENT_KEYWORDS));
}

function blockerDescriptions(rule: ProductRule, facts: readonly EvidenceFact[]): string[] {
  const hasReplacement = hasReplacementSignal(facts);
  const blockers: string[] = [];
  for (const fact of facts) {
    if (!isAttributedToTarget(fact) || fact.strength === 'weak') continue;
    const general = GENERAL_BLOCKER_KEYWORDS.find(keyword => containsKeyword(fact.statement, keyword));
    const productBlocker = rule.blockerKeywords.find(keyword => containsKeyword(fact.statement, keyword));
    const competitor = rule.competitorKeywords.find(keyword => containsKeyword(fact.statement, keyword));
    if (general !== undefined) blockers.push(`已知预算或决策阻碍：${general}`);
    if (productBlocker !== undefined) blockers.push(`已知系统阻碍：${productBlocker}`);
    if (competitor !== undefined && !hasReplacement
      && ['recruitment', 'software_ecosystem', 'product_scene'].includes(fact.kind)) {
      blockers.push(`已发现竞品或替代生态 ${competitor}，未发现替换信号`);
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
  const usableFacts = relevantFacts.filter(isReliable);
  const productFacts = relevantFacts.filter(fact => fact.productTags.includes(rule.product));
  const attributedProductFacts = productFacts.filter(isAttributedToTarget);
  const oldRecruitment = attributedProductFacts.filter(fact => fact.kind === 'recruitment'
    && containsAny(fact.statement, [...rule.positiveKeywords, ...rule.engineeringMethods])
    && !factHasRecentReference(fact, referencesById, nowMs));

  const targetNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.positiveKeywords);
  const methodNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.engineeringMethods);
  const competitorNamed = (fact: EvidenceFact): boolean => containsAny(fact.statement, rule.competitorKeywords);
  const isPositiveProductFact = (fact: EvidenceFact): boolean => {
    if (fact.kind === 'product_scene') return !competitorNamed(fact);
    if (!['recruitment', 'software_ecosystem', 'procurement'].includes(fact.kind)) return false;
    return targetNamed(fact) || methodNamed(fact);
  };
  const recentDirectRecruitment = attributedProductFacts.filter(fact => fact.kind === 'recruitment'
    && fact.strength === 'direct'
    && (targetNamed(fact) || methodNamed(fact))
    && factHasRecentReference(fact, referencesById, nowMs));
  const directSceneFacts = attributedProductFacts.filter(fact => fact.strength === 'direct'
    && ((fact.kind === 'product_scene')
      || (fact.kind === 'procurement' && (targetNamed(fact) || methodNamed(fact)))))
    .concat(recentDirectRecruitment);
  const confirmedScene = directSceneFacts.length > 0;

  const complexityFacts = usableFacts.filter(fact => isAttributedToTarget(fact)
    && (COMPLEXITY_KINDS.has(fact.kind)
      || (fact.kind === 'product_scene' && methodNamed(fact))));
  const targetEcosystemFacts = attributedProductFacts.filter(fact => fact.strength !== 'weak'
    && ((fact.kind === 'software_ecosystem' && (targetNamed(fact) || methodNamed(fact)))
      || (fact.kind === 'recruitment' && (targetNamed(fact) || methodNamed(fact)))));
  const blockers = blockerDescriptions(rule, relevantFacts);
  const strongBlocker = blockers.length > 0;

  const recentFinancing = evidence.financingRecords.filter(record =>
    isRecentTimestamp(record.occurredAt, nowMs)
    && financingIsAttributedToTarget(record.evidenceIds, referencesById));
  const recentTimingFacts = usableFacts.filter(fact => isAttributedToTarget(fact)
    && ((fact.kind === 'recruitment'
      && (targetNamed(fact) || methodNamed(fact))
      && factHasRecentReference(fact, referencesById, nowMs))
      || (fact.kind === 'procurement' && factHasRecentReference(fact, referencesById, nowMs))
      || (['organization', 'manufacturing', 'budget'].includes(fact.kind)
        && factHasRecentReference(fact, referencesById, nowMs)
        && containsAny(fact.statement, ['扩产', '新建', '新增', '升级', '数字化', '研发中心']))));
  const recentTiming = recentTimingFacts.length > 0 || recentFinancing.length > 0;
  const budgetSupport = usableFacts.some(positiveBudgetFact) || recentFinancing.length > 0;
  const decisionSupport = usableFacts.some(positiveDecisionFact);

  const supportingEvidenceIds = uniqueInOrder([
    ...usableFacts.flatMap(fact => fact.evidenceIds),
    ...(confirmedScene ? recentFinancing.flatMap(record => record.evidenceIds) : []),
  ]);
  const supportingReferences = supportingEvidenceIds.flatMap(id => {
    const reference = referencesById.get(id);
    return reference === undefined ? [] : [reference];
  });
  const publisherCount = countIndependentPublishers(supportingReferences);

  let level: OpportunityLevel;
  const reasons: string[] = [];
  const gaps: string[] = [];
  const allSupportingUnverified = evidence.facts.length > 0
    && evidence.facts.every(fact => fact.entityMatch === 'unverified');

  if (evidence.industryClassification === 'unverified'
    || criticalConflict(evidence.conflicts)
    || allSupportingUnverified) {
    level = '待核实';
    if (evidence.industryClassification === 'unverified') gaps.push('行业尚未核实');
    if (criticalConflict(evidence.conflicts)) gaps.push('存在关键主体或来源冲突');
    if (allSupportingUnverified) gaps.push('相关证据的主体归属均未核实');
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

  if (oldRecruitment.length > 0) gaps.push('招聘信息超过 365 天，仅作历史软件生态证据');
  const outputEvidenceIds = uniqueInOrder([
    ...relevantFacts.flatMap(fact => fact.evidenceIds),
    ...(confirmedScene ? recentFinancing.flatMap(record => record.evidenceIds) : []),
  ]);
  const positiveFacts = productFacts.filter(isPositiveProductFact);

  return {
    opportunity: {
      product: rule.product,
      level,
      evidenceIds: outputEvidenceIds,
      reasons: uniqueInOrder(reasons),
      blockers,
      gaps: uniqueInOrder(gaps),
    },
    directConfirmedEvidenceCount: productFacts.filter(fact => fact.strength === 'direct'
      && isAttributedToTarget(fact)
      && isPositiveProductFact(fact)).length,
    hasPositiveSupport: positiveFacts.length > 0,
    onlyWeakOrProbablePositiveSupport: positiveFacts.length > 0
      && positiveFacts.every(fact => fact.strength === 'weak' || !isAttributedToTarget(fact)),
  };
}
