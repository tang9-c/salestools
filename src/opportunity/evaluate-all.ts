import {
  EvidenceBundleSchema,
  OpportunityAssessmentSchema,
  type EvidenceBundle,
  type OpportunityAssessment,
  type OpportunityLevel,
} from '../contracts/index.js';
import { evaluateProduct, type ProductEvaluation } from './evaluate-product.js';
import { PRODUCT_RULES } from './product-rules.js';

const LEVEL_RANK: Readonly<Record<OpportunityLevel, number>> = {
  '待核实': 0,
  '低': 1,
  '中': 2,
  '高': 3,
};

function compareEvaluations(left: ProductEvaluation, right: ProductEvaluation): number {
  const levelDifference = LEVEL_RANK[right.opportunity.level] - LEVEL_RANK[left.opportunity.level];
  if (levelDifference !== 0) return levelDifference;
  const directDifference = right.directConfirmedEvidenceCount - left.directConfirmedEvidenceCount;
  if (directDifference !== 0) return directDifference;
  return left.opportunity.blockers.length - right.opportunity.blockers.length;
}

export function evaluateOpportunities(evidenceInput: EvidenceBundle, now: Date): OpportunityAssessment {
  const evidence = EvidenceBundleSchema.parse(evidenceInput);
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date');

  const evaluations = PRODUCT_RULES.map(rule => evaluateProduct(evidence, rule, now));
  const ranked = evaluations.map((evaluation, index) => ({ evaluation, index }))
    .sort((left, right) => compareEvaluations(left.evaluation, right.evaluation) || left.index - right.index);
  const best = ranked[0]!.evaluation;
  const positiveEvaluations = evaluations.filter(evaluation => evaluation.hasPositiveSupport);
  const globallyOnlyWeakOrProbablePositiveSupport = positiveEvaluations.length > 0
    && positiveEvaluations.every(evaluation => evaluation.onlyWeakOrProbablePositiveSupport);
  const aggregateIsUnsupported = positiveEvaluations.length === 0
    || best.opportunity.level === '待核实'
    || best.onlyWeakOrProbablePositiveSupport
    || globallyOnlyWeakOrProbablePositiveSupport;
  const overallOpportunity = aggregateIsUnsupported ? '待核实' : best.opportunity.level;
  const recommendedProduct = aggregateIsUnsupported ? null : best.opportunity.product;
  const summaryReasons = aggregateIsUnsupported
    ? ['最高机会仍仅有弱证据、未确认主体证据或关键证据缺口']
    : best.opportunity.reasons.slice(0, 3);

  return OpportunityAssessmentSchema.parse({
    products: evaluations.map(evaluation => evaluation.opportunity),
    overallOpportunity,
    recommendedProduct,
    summaryReasons,
  });
}
