import { z } from 'zod';
import { IndustryLabelSchema, ProductKeySchema } from './evidence.js';
import { OpportunityLevelSchema } from './opportunity.js';

const EvidenceCategoryCountsSchema = z.object({
  industry: z.number().int().nonnegative(),
  technology: z.number().int().nonnegative(),
  timing: z.number().int().nonnegative(),
  capacity: z.number().int().nonnegative(),
}).strict();

const EvidenceSelectionAuditInputSchema = z.object({
  selectedEvidenceIds: z.array(z.string()),
  originalCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  categoryCounts: EvidenceCategoryCountsSchema,
  researchBytes: z.number().int().nonnegative(),
  requestBytes: z.number().int().nonnegative(),
  batchCount: z.number().int().nonnegative().optional(),
  successfulBatchCount: z.number().int().nonnegative().optional(),
  failedBatchCount: z.number().int().nonnegative().optional(),
  processedCount: z.number().int().nonnegative().optional(),
  unprocessedCount: z.number().int().nonnegative().optional(),
  deduplicatedCount: z.number().int().nonnegative().optional(),
}).strict();

const EvidenceSelectionAuditSchema = EvidenceSelectionAuditInputSchema.transform(selection => ({
  ...selection,
  batchCount: selection.batchCount ?? 1,
  successfulBatchCount: selection.successfulBatchCount ?? 1,
  failedBatchCount: selection.failedBatchCount ?? 0,
  processedCount: selection.processedCount ?? selection.selectedCount,
  unprocessedCount: selection.unprocessedCount ?? selection.excludedCount,
  deduplicatedCount: selection.deduplicatedCount ?? 0,
})).superRefine((selection, context) => {
  if (new Set(selection.selectedEvidenceIds).size !== selection.selectedEvidenceIds.length) {
    context.addIssue({ code: 'custom', message: 'selected evidence IDs must be unique' });
  }
  if (selection.selectedEvidenceIds.length !== selection.selectedCount) {
    context.addIssue({ code: 'custom', message: 'selected evidence IDs must match selected count' });
  }
  if (selection.selectedCount + selection.excludedCount !== selection.originalCount) {
    context.addIssue({ code: 'custom', message: 'selected and excluded counts must match original count' });
  }
  const categorizedCount = Object.values(selection.categoryCounts)
    .reduce((total, count) => total + count, 0);
  if (categorizedCount > selection.selectedCount) {
    context.addIssue({ code: 'custom', message: 'category counts cannot exceed selected count' });
  }
  if (selection.researchBytes > selection.requestBytes) {
    context.addIssue({ code: 'custom', message: 'research bytes cannot exceed request bytes' });
  }
  if (selection.successfulBatchCount + selection.failedBatchCount !== selection.batchCount) {
    context.addIssue({ code: 'custom', message: 'successful and failed batches must match batch count' });
  }
  if (selection.processedCount + selection.unprocessedCount + selection.deduplicatedCount
    !== selection.originalCount) {
    context.addIssue({ code: 'custom', message: 'processed, unprocessed, and deduplicated counts must match original count' });
  }
  if (selection.processedCount > selection.selectedCount) {
    context.addIssue({ code: 'custom', message: 'processed count cannot exceed selected count' });
  }
});

const ProductOpportunityAuditSchema = z.object({
  product: ProductKeySchema,
  level: OpportunityLevelSchema,
  evidenceIds: z.array(z.string()),
}).strict();

const CompleteProductOpportunityAuditsSchema = z.array(ProductOpportunityAuditSchema)
  .length(ProductKeySchema.options.length)
  .superRefine((opportunities, context) => {
    const products = new Set(opportunities.map(opportunity => opportunity.product));
    if (products.size !== ProductKeySchema.options.length
      || ProductKeySchema.options.some(product => !products.has(product))) {
      context.addIssue({ code: 'custom', message: 'opportunities must contain every ProductKey exactly once' });
    }
  });

export const AssessmentResultAuditSchema = z.object({
  industryLabel: IndustryLabelSchema,
  industryEvidenceIds: z.array(z.string()),
  evidenceSelection: EvidenceSelectionAuditSchema,
  opportunities: CompleteProductOpportunityAuditsSchema,
}).strict().superRefine((audit, context) => {
  if ((audit.industryLabel !== null) !== (audit.industryEvidenceIds.length > 0)) {
    context.addIssue({
      code: 'custom',
      path: ['industryEvidenceIds'],
      message: 'industry label and evidence IDs must either both be present or both be absent',
    });
  }
});

export type AssessmentResultAudit = z.infer<typeof AssessmentResultAuditSchema>;
