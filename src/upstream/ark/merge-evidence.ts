import {
  EvidenceBundleSchema,
  validateEvidenceProvenance,
  type EvidenceBundle,
  type EvidenceFact,
  type FinancingRecord,
  type ResearchBundle,
  type ResearchItem,
} from '../../contracts/index.js';

export interface SuccessfulArkBatch {
  readonly input: ResearchBundle;
  readonly evidence: EvidenceBundle;
}

export interface ArkMergeInput {
  readonly original: ResearchBundle;
  readonly successful: readonly SuccessfulArkBatch[];
  readonly failedEvidenceIds: readonly string[];
  readonly unplannedEvidenceIds: readonly string[];
}

const TRANSIENT_MATERIAL_GAP = /^(?:招聘使用非结构化材料整理|.+使用非结构化材料，待模型整理)$/u;

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizedText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function factKey(fact: EvidenceFact): string {
  return JSON.stringify({
    statement: normalizedText(fact.statement),
    kind: fact.kind,
    productTags: [...fact.productTags].sort(),
    strength: fact.strength,
    entityScope: fact.entityScope,
    entityMatch: fact.entityMatch,
    matchBasis: fact.matchBasis.map(normalizedText).sort(),
  });
}

function financingKey(record: FinancingRecord): string {
  return JSON.stringify({
    occurredAt: record.occurredAt,
    typeOrRound: record.typeOrRound === null ? null : normalizedText(record.typeOrRound),
    disclosedAmount: record.disclosedAmount === null ? null : normalizedText(record.disclosedAmount),
    investors: record.investors.map(normalizedText).sort(),
    summary: record.summary == null ? null : normalizedText(record.summary),
  });
}

function isMaterial(item: ResearchItem): boolean {
  if (item.source !== 'qcc') return false;
  const summary = item.summary ?? '';
  const content = item.content?.trim() ?? '';
  if (summary.includes('待模型整理')) return true;
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && Object.hasOwn(parsed, 'material');
  } catch {
    return false;
  }
}

function usedEvidenceIds(bundle: EvidenceBundle): Set<string> {
  return new Set([
    ...bundle.industryEvidenceIds,
    ...bundle.facts.flatMap(fact => fact.evidenceIds),
    ...bundle.financingRecords.flatMap(record => record.evidenceIds),
  ]);
}

export function mergeArkEvidence(input: ArkMergeInput): EvidenceBundle {
  const evidenceById = new Map<string, EvidenceBundle['evidence'][number]>();
  const factsByKey = new Map<string, EvidenceFact>();
  const financingByKey = new Map<string, FinancingRecord>();
  const conflicts: string[] = [];
  const gaps: string[] = [];
  let industryLabel: string | null = null;
  let industryEvidenceIds: string[] = [];

  const appendGaps = (values: readonly string[]): void => {
    gaps.push(...values.filter(gap => !TRANSIENT_MATERIAL_GAP.test(gap.trim())));
  };
  appendGaps(input.original.gaps);

  for (const batch of input.successful) {
    for (const reference of batch.evidence.evidence) {
      if (!evidenceById.has(reference.evidenceId)) evidenceById.set(reference.evidenceId, reference);
    }
    for (const fact of batch.evidence.facts) {
      const key = factKey(fact);
      const existing = factsByKey.get(key);
      if (existing === undefined) {
        factsByKey.set(key, fact);
      } else {
        factsByKey.set(key, {
          ...existing,
          evidenceIds: [...new Set([...existing.evidenceIds, ...fact.evidenceIds])],
        });
      }
    }
    for (const record of batch.evidence.financingRecords) {
      const key = financingKey(record);
      const existing = financingByKey.get(key);
      if (existing === undefined) {
        financingByKey.set(key, record);
      } else {
        financingByKey.set(key, {
          ...existing,
          evidenceIds: [...new Set([...existing.evidenceIds, ...record.evidenceIds])],
        });
      }
    }
    conflicts.push(...batch.evidence.conflicts);
    appendGaps(batch.evidence.gaps);

    if (batch.evidence.industryLabel !== null) {
      if (industryLabel === null) {
        industryLabel = batch.evidence.industryLabel;
        industryEvidenceIds = [...batch.evidence.industryEvidenceIds];
      } else if (normalizedText(industryLabel) !== normalizedText(batch.evidence.industryLabel)) {
        conflicts.push(`多批次行业标签冲突：${industryLabel} / ${batch.evidence.industryLabel}`);
      }
    }
  }

  const partial: EvidenceBundle = EvidenceBundleSchema.parse({
    identity: input.original.identity,
    industryLabel,
    industryEvidenceIds,
    evidence: [...evidenceById.values()],
    facts: [...factsByKey.values()],
    financingRecords: [...financingByKey.values()],
    conflicts: stableUnique(conflicts),
    gaps: [],
    collectedAt: input.original.collectedAt,
  });
  const cited = usedEvidenceIds(partial);
  const failed = new Set(input.failedEvidenceIds);
  const unplanned = new Set(input.unplannedEvidenceIds);

  for (const batch of input.successful) {
    for (const item of batch.input.items.filter(isMaterial)) {
      if (!cited.has(item.evidenceId)) {
        gaps.push(`模型未从该材料提炼出可采信事实：${item.evidenceId}`);
      }
    }
  }
  for (const item of input.original.items.filter(isMaterial)) {
    if (failed.has(item.evidenceId)) {
      gaps.push(`材料未完成模型整理（批次失败）：${item.evidenceId}`);
    } else if (unplanned.has(item.evidenceId)) {
      gaps.push(`材料未完成模型整理（容量上限）：${item.evidenceId}`);
    }
  }

  const merged = EvidenceBundleSchema.parse({ ...partial, gaps: stableUnique(gaps) });
  return validateEvidenceProvenance(input.original, merged);
}
