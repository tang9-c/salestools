import {
  EvidenceBundleSchema,
  ResearchBundleSchema,
  validateEvidenceProvenance,
  type EvidenceBundle,
  type ResearchBundle,
} from '../../contracts/index.js';

export class ArkEvidenceValidationError extends Error {
  override readonly name = 'ArkEvidenceValidationError';
}

function invalid(message: string, cause?: unknown): never {
  throw new ArkEvidenceValidationError(message, cause === undefined ? undefined : { cause });
}

function isCompleteText(value: string): boolean {
  return value.trim().length > 0;
}

function requireCompleteAttribution(
  label: string,
  mentionedName: string,
  matchBasis: readonly string[],
): void {
  if (!isCompleteText(mentionedName)) invalid(`${label} is missing mentionedName`);
  if (matchBasis.length === 0 || matchBasis.some(basis => !isCompleteText(basis))) {
    invalid(`${label} is missing matchBasis`);
  }
}

function requireMatchBasis(label: string, matchBasis: readonly string[]): void {
  if (matchBasis.length === 0 || matchBasis.some(basis => !isCompleteText(basis))) {
    invalid(`${label} is missing matchBasis`);
  }
}

const UNSUPPORTED_INFERENCE_PATTERNS: readonly RegExp[] = [
  /(?:(?:高管|董事长|实控人|负责人|管理层).{0,24}(?:人格|性格|决策风格|保守|激进|求稳|冒险))|(?:(?:年龄|年纪|\d{1,3}\s*岁|老年|年轻).{0,24}(?:决策|掌权|风格|保守|激进|求稳|冒险))|(?:(?:决策|掌权|风格|保守|激进|求稳|冒险).{0,24}(?:年龄|年纪|\d{1,3}\s*岁|老年|年轻))/u,
  /(?:(?:预计|估算|预估|推算|倒推).{0,16}(?:营收|销售收入|营业收入))|(?:(?:营收|销售收入|营业收入).{0,16}(?:预计|估算|预估|推算|倒推))|(?:(?:员工人数|社保人数|行业人效|人效|人均产值).{0,32}(?:营收|销售收入|营业收入))|(?:(?:营收|销售收入|营业收入).{0,32}(?:员工人数|社保人数|行业人效|人效|人均产值))|(?:(?:员工人数|社保人数|行业人效|人效|人均产值).{0,32}(?:乘以|[×*xX]).{0,32}(?:亿元|万元))|(?:真实营收)/u,
  /(?:采购\s*意向|计划\s*采购|拟\s*采购|即将\s*采购|有\s*采购需求|存在\s*采购需求|准备\s*采购)/u,
];

function rejectUnsupportedInference(label: string, value: string): void {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (UNSUPPORTED_INFERENCE_PATTERNS.some(pattern => pattern.test(normalized))) {
    invalid(`${label} contains an unsupported inference`);
  }
}

export function validateArkEvidence(researchInput: ResearchBundle, candidate: unknown): EvidenceBundle {
  let research: ResearchBundle;
  let evidence: EvidenceBundle;
  try {
    research = ResearchBundleSchema.parse(researchInput);
    evidence = EvidenceBundleSchema.parse(candidate);
  } catch (error) {
    invalid('Ark output does not match the EvidenceBundle contract', error);
  }

  if (JSON.stringify(evidence.identity) !== JSON.stringify(research.identity)) {
    invalid('Ark output changed the confirmed identity profile');
  }
  if (evidence.collectedAt !== research.collectedAt) {
    invalid('Ark output changed the ResearchBundle collectedAt timestamp');
  }

  try {
    validateEvidenceProvenance(research, evidence);
  } catch (error) {
    invalid('Ark output contains invalid evidence provenance', error);
  }

  for (const item of research.items) {
    requireCompleteAttribution(`Research item ${item.evidenceId}`, item.mentionedName, item.matchBasis);
  }
  for (const reference of evidence.evidence) {
    requireCompleteAttribution(`Evidence reference ${reference.evidenceId}`, reference.mentionedName, reference.matchBasis);
  }

  if (evidence.industryClassification !== 'unverified' && evidence.industryEvidenceIds.length === 0) {
    invalid('A verified industry classification requires evidence');
  }

  const referenceById = new Map(evidence.evidence.map(reference => [reference.evidenceId, reference]));
  if (evidence.industryClassification !== 'unverified') {
    const industryReferences = evidence.industryEvidenceIds
      .map(evidenceId => referenceById.get(evidenceId))
      .filter(reference => reference !== undefined);
    if (industryReferences.every(reference => reference.entityMatch === 'unverified')) {
      invalid('A verified industry classification requires attributed entity evidence');
    }
  }

  for (const fact of evidence.facts) {
    if (fact.evidenceIds.length === 0) invalid(`Fact ${fact.factId} requires evidence`);
    requireMatchBasis(`Fact ${fact.factId}`, fact.matchBasis);
    const citedReferences = fact.evidenceIds
      .map(evidenceId => referenceById.get(evidenceId))
      .filter(reference => reference !== undefined);
    if (citedReferences.some(
      reference => reference.entityScope !== fact.entityScope || reference.entityMatch !== fact.entityMatch,
    )) {
      invalid(`Fact ${fact.factId} promotes or changes source attribution`);
    }
    const sourceMatchBasis = new Set(citedReferences.flatMap(reference => reference.matchBasis));
    if (fact.matchBasis.some(basis => !sourceMatchBasis.has(basis))) {
      invalid(`Fact ${fact.factId} contains invented matchBasis`);
    }
    rejectUnsupportedInference(`Fact ${fact.factId}`, fact.statement);
  }
  for (const [index, conflict] of evidence.conflicts.entries()) {
    rejectUnsupportedInference(`Conflict ${index}`, conflict);
  }
  for (const [index, gap] of evidence.gaps.entries()) {
    rejectUnsupportedInference(`Gap ${index}`, gap);
  }
  for (const [index, record] of evidence.financingRecords.entries()) {
    if (record.evidenceIds.length === 0) invalid(`Financing record ${index} requires evidence`);
  }

  if (research.items.length === 0) {
    const hasClaimedEvidence = evidence.industryClassification !== 'unverified'
      || evidence.industryEvidenceIds.length > 0
      || evidence.evidence.length > 0
      || evidence.facts.length > 0
      || evidence.financingRecords.length > 0;
    if (hasClaimedEvidence) invalid('An empty ResearchBundle only permits an unverified fact-free result');
  }

  return evidence;
}
