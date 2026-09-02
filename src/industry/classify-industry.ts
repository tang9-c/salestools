import type {
  EvidenceBundle,
  EvidenceFact,
  EvidenceReference,
  IndustryClassification,
} from '../contracts/index.js';

const ELIGIBLE_FACT_KINDS = new Set<EvidenceFact['kind']>([
  'industry',
  'product_scene',
  'manufacturing',
]);

const INDUSTRY_RULES: ReadonlyArray<{
  classification: Exclude<IndustryClassification, 'unverified' | 'non_target'>;
  keywords: readonly string[];
}> = [
  {
    classification: 'P1',
    keywords: [
      '移动储能', '便携式电源', '便携储能', '家庭储能', '储能设备',
      '储能系统', '光伏逆变器', '太阳能逆变器', '清洁能源设备',
    ],
  },
  {
    classification: 'P2',
    keywords: ['射频通信', '通信设备', '无线通信设备'],
  },
];

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function eligibleFact(
  fact: EvidenceFact,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): boolean {
  if (!ELIGIBLE_FACT_KINDS.has(fact.kind)
    || fact.strength === 'weak'
    || fact.entityScope !== 'legal_entity'
    || fact.entityMatch !== 'confirmed'
    || fact.evidenceIds.length === 0) return false;
  return fact.evidenceIds.every(evidenceId => {
    const reference = referencesById.get(evidenceId);
    return reference?.entityScope === 'legal_entity' && reference.entityMatch === 'confirmed';
  });
}

export function supplementIndustryClassification(input: EvidenceBundle): EvidenceBundle {
  if (input.industryClassification !== 'unverified') return input;
  const referencesById = new Map(input.evidence.map(reference => [reference.evidenceId, reference]));
  const matches = input.facts.flatMap(fact => {
    if (!eligibleFact(fact, referencesById)) return [];
    const statement = normalized(fact.statement);
    return INDUSTRY_RULES.flatMap(rule => rule.keywords.some(keyword => statement.includes(normalized(keyword)))
      ? [{ classification: rule.classification, evidenceIds: fact.evidenceIds }]
      : []);
  });
  const classifications = new Set(matches.map(match => match.classification));
  if (classifications.size !== 1) return input;
  return {
    ...input,
    industryClassification: [...classifications][0]!,
    industryEvidenceIds: [...new Set(matches.flatMap(match => match.evidenceIds))],
  };
}
