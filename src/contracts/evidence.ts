import { z } from 'zod';
import { IdentityProfileSchema, UtcTimestampSchema } from './identity.js';
import {
  EntityMatchSchema,
  EntityScopeSchema,
  DirectEvidenceUrlSchema,
  ResearchBundleSchema,
  type ResearchBundle,
} from './research.js';

export const ProductKeySchema = z.enum([
  'windchill',
  'feigenbaum_qms',
  'creo',
  'catia',
  'abaqus',
  'cst',
  'solidworks',
]);

export const FactKindSchema = z.enum([
  'industry',
  'product_scene',
  'recruitment',
  'software_ecosystem',
  'organization',
  'quality',
  'manufacturing',
  'procurement',
  'budget',
  'decision_power',
  'risk',
]);

export const EvidenceReferenceSchema = z.object({
  evidenceId: z.string(),
  title: z.string(),
  url: DirectEvidenceUrlSchema.nullable(),
  originalPublisher: z.string().nullable(),
  originalDomain: z.string().nullable(),
  publishedAt: UtcTimestampSchema.nullable(),
  collectedAt: UtcTimestampSchema,
  mentionedName: z.string(),
  entityScope: EntityScopeSchema,
  entityMatch: EntityMatchSchema,
  matchBasis: z.array(z.string()),
}).strict();

export const EvidenceFactSchema = z.object({
  factId: z.string(),
  statement: z.string(),
  kind: FactKindSchema,
  productTags: z.array(ProductKeySchema),
  strength: z.enum(['direct', 'supporting', 'weak']),
  evidenceIds: z.array(z.string()),
  entityScope: EntityScopeSchema,
  entityMatch: EntityMatchSchema,
  matchBasis: z.array(z.string()),
}).strict();

export const FinancingRecordSchema = z.object({
  occurredAt: UtcTimestampSchema.nullable(),
  typeOrRound: z.string().nullable(),
  disclosedAmount: z.string().nullable(),
  investors: z.array(z.string()),
  summary: z.string().trim().min(1).nullable().optional(),
  evidenceIds: z.array(z.string()),
}).strict();

export const IndustryLabelSchema = z.string().trim().min(2).max(40).nullable();

export const EvidenceBundleSchema = z.object({
  identity: IdentityProfileSchema,
  industryLabel: IndustryLabelSchema,
  industryEvidenceIds: z.array(z.string()),
  evidence: z.array(EvidenceReferenceSchema),
  facts: z.array(EvidenceFactSchema),
  financingRecords: z.array(FinancingRecordSchema),
  conflicts: z.array(z.string()),
  gaps: z.array(z.string()),
  collectedAt: UtcTimestampSchema,
}).strict().superRefine((bundle, context) => {
  const hasLabel = bundle.industryLabel !== null;
  const hasEvidence = bundle.industryEvidenceIds.length > 0;
  if (hasLabel !== hasEvidence) {
    context.addIssue({
      code: 'custom',
      path: ['industryEvidenceIds'],
      message: 'industry label and evidence IDs must either both be present or both be absent',
    });
  }
});

export type ProductKey = z.infer<typeof ProductKeySchema>;
export type FactKind = z.infer<typeof FactKindSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type EvidenceFact = z.infer<typeof EvidenceFactSchema>;
export type FinancingRecord = z.infer<typeof FinancingRecordSchema>;
export type IndustryLabel = z.infer<typeof IndustryLabelSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export class EvidenceContractError extends Error {
  override readonly name = 'EvidenceContractError';
}

const provenanceKeys = [
  'evidenceId',
  'title',
  'url',
  'originalPublisher',
  'originalDomain',
  'publishedAt',
  'collectedAt',
  'mentionedName',
  'entityScope',
  'entityMatch',
  'matchBasis',
] as const;

function sameProvenance(
  reference: EvidenceReference,
  researchItem: ResearchBundle['items'][number],
): boolean {
  return provenanceKeys.every(key => JSON.stringify(reference[key]) === JSON.stringify(researchItem[key]));
}

export function validateEvidenceProvenance(
  research: ResearchBundle,
  evidence: EvidenceBundle,
): EvidenceBundle {
  const parsedResearch = ResearchBundleSchema.parse(research);
  const parsedEvidence = EvidenceBundleSchema.parse(evidence);
  const researchById = new Map(parsedResearch.items.map(item => [item.evidenceId, item]));
  const referenceIds = new Set(parsedEvidence.evidence.map(reference => reference.evidenceId));

  for (const reference of parsedEvidence.evidence) {
    const researchItem = researchById.get(reference.evidenceId);
    if (researchItem === undefined || !sameProvenance(reference, researchItem)) {
      throw new EvidenceContractError(`Invalid evidence provenance: ${reference.evidenceId}`);
    }
  }

  const usedIds = [
    ...parsedEvidence.industryEvidenceIds,
    ...parsedEvidence.facts.flatMap(fact => fact.evidenceIds),
    ...parsedEvidence.financingRecords.flatMap(record => record.evidenceIds),
  ];
  for (const evidenceId of usedIds) {
    if (!referenceIds.has(evidenceId)) {
      throw new EvidenceContractError(`Unknown evidence reference: ${evidenceId}`);
    }
  }

  return parsedEvidence;
}

function normalizePublisher(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export function countIndependentPublishers(references: readonly EvidenceReference[]): number {
  const publishers = new Set<string>();
  for (const reference of references) {
    if (reference.originalDomain !== null) {
      const domain = normalizePublisher(reference.originalDomain).replace(/^www\./, '');
      if (domain.length > 0) publishers.add(`domain:${domain}`);
    } else if (reference.originalPublisher !== null) {
      const publisher = normalizePublisher(reference.originalPublisher);
      if (publisher.length > 0) publishers.add(`publisher:${publisher}`);
    }
  }
  return publishers.size;
}
