import {
  EvidenceBundleSchema,
  ResearchBundleSchema,
  validateEvidenceProvenance,
  type EvidenceBundle,
  type ProductKey,
  type ResearchBundle,
  type ResearchItem,
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
  /(?:(?:预计|估算|预估|推算|倒推).{0,16}(?:营收|销售收入|营业收入))|(?:(?:营收|销售收入|营业收入).{0,16}(?:预计|估算|预估|推算|倒推))|(?:(?:员工人数|社保人数|行业人效|人效|人均产值).{0,32}(?:营收|销售收入|营业收入))|(?:(?:营收|销售收入|营业收入).{0,32}(?:员工人数|社保人数|行业人效|人效|人均产值))|(?:(?:员工人数|社保人数|行业人效|人效|人均产值).{0,32}(?:倒推|推算|估算|预估|乘以|[×*xX]).{0,32}(?:亿元|万元))|(?:真实营收)/u,
];

const PROCUREMENT_INTENT_PATTERN =
  /(?:采购\s*意向|计划\s*采购|拟\s*采购|即将\s*采购|有\s*采购需求|存在\s*采购需求|准备\s*采购)/u;
const PUBLIC_PROCUREMENT_CARRIER_PATTERN =
  /(?:采购公告|招标公告|中标公告|采购文件|采购项目|采购合同)/u;

const PROCUREMENT_DISCLOSURES = [
  '采购意向',
  '计划采购',
  '拟采购',
  '即将采购',
  '有采购需求',
  '存在采购需求',
  '准备采购',
] as const;

const PRODUCT_PATTERNS: Readonly<Record<ProductKey, readonly RegExp[]>> = {
  windchill: [/\bwindchill\b/iu],
  feigenbaum_qms: [/\bfeigenbaum\s*qms\b/iu, /\bfeigenbaum\b/iu],
  creo: [/\bcreo\b/iu, /\bpro\s*\/\s*e\b/iu, /\bproe\b/iu],
  catia: [/\bcatia\b/iu],
  abaqus: [/\babaqus\b/iu],
  cst: [/\bcst(?:\s+studio(?:\s+suite)?)?\b/iu],
  solidworks: [/\bsolid\s*works\b/iu],
};

function compact(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function researchText(item: ResearchItem): string {
  return [item.title, item.summary ?? '', item.content ?? ''].join('\n').normalize('NFKC');
}

function procurementDisclosures(value: string): readonly string[] {
  const normalized = compact(value);
  return PROCUREMENT_DISCLOSURES.filter(disclosure => normalized.includes(disclosure));
}

function mentionsProduct(value: string, product: ProductKey): boolean {
  return PRODUCT_PATTERNS[product].some(pattern => pattern.test(value.normalize('NFKC')));
}

function rejectUnsupportedInference(
  label: string,
  value: string,
  allowDirectProcurementDisclosure = false,
): void {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const unsupported = UNSUPPORTED_INFERENCE_PATTERNS.some(pattern => pattern.test(normalized));
  const unsupportedProcurement = PROCUREMENT_INTENT_PATTERN.test(normalized)
    && !allowDirectProcurementDisclosure;
  if (unsupported || unsupportedProcurement) {
    invalid(`${label} contains an unsupported inference`);
  }
}

function isDirectProcurementDisclosure(
  fact: EvidenceBundle['facts'][number],
  citedReferences: readonly EvidenceBundle['evidence'][number][],
  citedResearchItems: readonly ResearchItem[],
): boolean {
  const statement = fact.statement.normalize('NFKC');
  const disclosures = procurementDisclosures(statement);
  if (fact.kind !== 'procurement'
    || fact.strength !== 'direct'
    || fact.entityScope !== 'legal_entity'
    || fact.entityMatch !== 'confirmed'
    || fact.evidenceIds.length === 0
    || fact.productTags.length === 0
    || citedReferences.length !== fact.evidenceIds.length
    || citedResearchItems.length !== fact.evidenceIds.length
    || !citedReferences.every(reference =>
      reference.entityScope === 'legal_entity' && reference.entityMatch === 'confirmed')
    || !PUBLIC_PROCUREMENT_CARRIER_PATTERN.test(compact(statement))
    || disclosures.length === 0
    || !fact.productTags.every(product => mentionsProduct(statement, product))) {
    return false;
  }

  return citedResearchItems.every(item => {
    const sourceText = researchText(item);
    const normalizedSource = compact(sourceText);
    return PUBLIC_PROCUREMENT_CARRIER_PATTERN.test(normalizedSource)
      && disclosures.every(disclosure => normalizedSource.includes(disclosure))
      && fact.productTags.every(product => mentionsProduct(sourceText, product));
  });
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
  const researchById = new Map(research.items.map(item => [item.evidenceId, item]));
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
    const citedResearchItems = fact.evidenceIds
      .map(evidenceId => researchById.get(evidenceId))
      .filter(item => item !== undefined);
    if (citedReferences.some(
      reference => reference.entityScope !== fact.entityScope || reference.entityMatch !== fact.entityMatch,
    )) {
      invalid(`Fact ${fact.factId} promotes or changes source attribution`);
    }
    const sourceMatchBasis = new Set(citedReferences.flatMap(reference => reference.matchBasis));
    if (fact.matchBasis.some(basis => !sourceMatchBasis.has(basis))) {
      invalid(`Fact ${fact.factId} contains invented matchBasis`);
    }
    rejectUnsupportedInference(
      `Fact ${fact.factId}`,
      fact.statement,
      isDirectProcurementDisclosure(fact, citedReferences, citedResearchItems),
    );
  }
  for (const [index, conflict] of evidence.conflicts.entries()) {
    rejectUnsupportedInference(`Conflict ${index}`, conflict);
  }
  for (const [index, gap] of evidence.gaps.entries()) {
    rejectUnsupportedInference(`Gap ${index}`, gap);
  }
  for (const [index, record] of evidence.financingRecords.entries()) {
    if (record.evidenceIds.length === 0) invalid(`Financing record ${index} requires evidence`);
    if (record.summary !== undefined && record.summary !== null) {
      rejectUnsupportedInference(`Financing record ${index} summary`, record.summary);
    }
    if (record.typeOrRound !== null) {
      rejectUnsupportedInference(`Financing record ${index} typeOrRound`, record.typeOrRound);
    }
    if (record.disclosedAmount !== null) {
      rejectUnsupportedInference(`Financing record ${index} disclosedAmount`, record.disclosedAmount);
    }
    for (const [investorIndex, investor] of record.investors.entries()) {
      rejectUnsupportedInference(`Financing record ${index} investor ${investorIndex}`, investor);
    }
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
