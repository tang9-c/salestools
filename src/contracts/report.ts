import { z } from 'zod';
import {
  EvidenceFactSchema,
  EvidenceReferenceSchema,
  FinancingRecordSchema,
  IndustryLabelSchema,
  ProductKeySchema,
} from './evidence.js';
import { UtcTimestampSchema } from './identity.js';
import { CompleteProductOpportunitiesSchema, OpportunityLevelSchema } from './opportunity.js';
import { ResearchSourceStatusSchema } from './research.js';

export const ArkSourceStatusSchema = z.enum(['completed', 'partial', 'failed']);

export const ReportModelSchema = z.object({
  legalName: z.string(),
  industryLabel: IndustryLabelSchema,
  industryEvidenceIds: z.array(z.string()),
  companyScaleClues: z.array(z.string()),
  overallOpportunity: OpportunityLevelSchema,
  recommendedProduct: ProductKeySchema.nullable(),
  summaryReasons: z.array(z.string()),
  latestFinancing: FinancingRecordSchema.nullable(),
  products: CompleteProductOpportunitiesSchema,
  facts: z.array(EvidenceFactSchema),
  evidence: z.array(EvidenceReferenceSchema),
  salesQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  gaps: z.array(z.string()),
  nextVerificationActions: z.array(z.string()),
  sourceStatus: z.object({
    qcc: ResearchSourceStatusSchema,
    doubaoSearch: ResearchSourceStatusSchema,
    ark: z.enum(['completed', 'partial']),
  }).strict(),
  collectedAt: UtcTimestampSchema,
  dynamicSignalFreshness: z.enum(['current', 'stale']),
}).strict().superRefine((report, context) => {
  if ((report.industryLabel !== null) !== (report.industryEvidenceIds.length > 0)) {
    context.addIssue({
      code: 'custom',
      path: ['industryEvidenceIds'],
      message: 'industry label and evidence IDs must either both be present or both be absent',
    });
  }
});

export type ArkSourceStatus = z.infer<typeof ArkSourceStatusSchema>;
export type ReportModel = z.infer<typeof ReportModelSchema>;
