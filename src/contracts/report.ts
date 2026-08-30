import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  FinancingRecordSchema,
  IndustryClassificationSchema,
  ProductKeySchema,
} from './evidence.js';
import { UtcTimestampSchema } from './identity.js';
import { CompleteProductOpportunitiesSchema, OpportunityLevelSchema } from './opportunity.js';
import { ResearchSourceStatusSchema } from './research.js';

export const ArkSourceStatusSchema = z.enum(['completed', 'failed']);

export const ReportModelSchema = z.object({
  legalName: z.string(),
  industryClassification: IndustryClassificationSchema,
  companyScaleClues: z.array(z.string()),
  overallOpportunity: OpportunityLevelSchema,
  recommendedProduct: ProductKeySchema.nullable(),
  summaryReasons: z.array(z.string()),
  latestFinancing: FinancingRecordSchema.nullable(),
  products: CompleteProductOpportunitiesSchema,
  evidence: z.array(EvidenceReferenceSchema),
  salesQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  gaps: z.array(z.string()),
  nextVerificationActions: z.array(z.string()),
  sourceStatus: z.object({
    qcc: ResearchSourceStatusSchema,
    doubaoSearch: ResearchSourceStatusSchema,
    ark: z.literal('completed'),
  }).strict(),
  collectedAt: UtcTimestampSchema,
  dynamicSignalFreshness: z.enum(['current', 'stale']),
}).strict();

export type ArkSourceStatus = z.infer<typeof ArkSourceStatusSchema>;
export type ReportModel = z.infer<typeof ReportModelSchema>;
