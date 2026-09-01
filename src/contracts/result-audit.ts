import { z } from 'zod';
import { IndustryClassificationSchema, ProductKeySchema } from './evidence.js';
import { OpportunityLevelSchema } from './opportunity.js';

const EvidenceCategoryCountsSchema = z.object({
  industry: z.number().int().nonnegative(),
  technology: z.number().int().nonnegative(),
  timing: z.number().int().nonnegative(),
  capacity: z.number().int().nonnegative(),
}).strict();

const EvidenceSelectionAuditSchema = z.object({
  selectedEvidenceIds: z.array(z.string()),
  originalCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  categoryCounts: EvidenceCategoryCountsSchema,
  researchBytes: z.number().int().nonnegative(),
  requestBytes: z.number().int().nonnegative(),
}).strict().superRefine((selection, context) => {
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
  industryClassification: IndustryClassificationSchema,
  industryEvidenceIds: z.array(z.string()),
  evidenceSelection: EvidenceSelectionAuditSchema,
  opportunities: CompleteProductOpportunityAuditsSchema,
}).strict();

export type AssessmentResultAudit = z.infer<typeof AssessmentResultAuditSchema>;
