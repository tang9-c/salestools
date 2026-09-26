import { z } from 'zod';
import { ProductKeySchema } from './evidence.js';
import { UtcTimestampSchema } from './identity.js';
import { OpportunityLevelSchema } from './opportunity.js';
import { ResearchSourceStatusSchema } from './research.js';

export * from './identity.js';
export * from './gaps.js';
export * from './research.js';
export * from './evidence.js';
export * from './opportunity.js';
export * from './report.js';
export * from './result-audit.js';
export * from './contact.js';
export * from './contact-graph.js';
export * from './contact-import.js';
export * from './company-question.js';

export const CandidateSchema = z.object({
  legal_name: z.string(),
  credit_code: z.string(),
  status: z.string().nullable(),
  registered_address: z.string().nullable(),
  match_reason: z.string(),
}).strict();

export const BasicProfileSchema = z.object({
  industry: z.string().nullable(),
  region: z.string().nullable(),
  company_type: z.string().nullable(),
  founded_year: z.number().nullable(),
  registered_capital: z.string().nullable(),
  legal_representative: z.string().nullable(),
  website: z.string().nullable(),
  employee_range: z.string().nullable(),
  risk_summary: z.string().nullable(),
  collected_at: UtcTimestampSchema,
}).strict();

const CompanyProfileCompletedSchema = z.object({
  source_status: z.literal('completed'),
  candidates: z.array(CandidateSchema),
  basic_profile: BasicProfileSchema.nullable(),
  cache_hit: z.boolean(),
}).strict().superRefine((output, context) => {
  if (output.candidates.length > 1 && (output.basic_profile !== null || output.cache_hit)) {
    context.addIssue({ code: 'custom', message: 'multi-candidate output cannot contain a profile or cache hit' });
  }
  if (output.cache_hit && (output.candidates.length !== 1 || output.basic_profile === null)) {
    context.addIssue({ code: 'custom', message: 'cache hits require one candidate and a cached profile' });
  }
});

const CompanyProfileFailedSchema = z.object({
  source_status: z.literal('failed'),
  candidates: z.array(CandidateSchema).length(0),
  basic_profile: z.null(),
  cache_hit: z.literal(false),
  message: z.string(),
}).strict();

export const CompanyProfileOutputSchema = z.union([
  CompanyProfileCompletedSchema,
  CompanyProfileFailedSchema,
]);

const SubmitAssessmentProcessingSchema = z.object({
  assessment_id: z.uuid(),
  status: z.literal('processing'),
  estimated_minutes: z.literal('5-40'),
  cache_hit: z.literal(false),
}).strict();

const SubmitAssessmentCompletedSchema = z.object({
  assessment_id: z.uuid(),
  status: z.literal('completed'),
  cache_hit: z.literal(true),
  cached_at: UtcTimestampSchema,
}).strict();

export const SubmitAssessmentOutputSchema = z.discriminatedUnion('status', [
  SubmitAssessmentProcessingSchema,
  SubmitAssessmentCompletedSchema,
]);

export const AssessmentStatusOutputSchema = z.object({
  assessment_id: z.uuid(),
  status: z.enum(['processing', 'completed', 'failed']),
  message: z.string(),
}).strict();

const AssessmentReportPendingSchema = z.object({
  assessment_id: z.uuid(),
  status: z.enum(['processing', 'failed']),
  message: z.string(),
}).strict();

const AssessmentReportCompletedSchema = z.object({
  assessment_id: z.uuid(),
  status: z.literal('completed'),
  legal_name: z.string(),
  overall_opportunity: OpportunityLevelSchema,
  recommended_product: ProductKeySchema.nullable(),
  collected_at: UtcTimestampSchema,
  dynamic_signal_freshness: z.enum(['current', 'stale']),
  source_status: z.object({
    qcc: ResearchSourceStatusSchema,
    doubao_search: ResearchSourceStatusSchema,
    ark: z.enum(['completed', 'partial']),
  }).strict(),
  markdown: z.string(),
}).strict();

export const AssessmentReportOutputSchema = z.union([
  AssessmentReportPendingSchema,
  AssessmentReportCompletedSchema,
]);

export type Candidate = z.infer<typeof CandidateSchema>;
export type BasicProfile = z.infer<typeof BasicProfileSchema>;
export type CompanyProfileOutput = z.infer<typeof CompanyProfileOutputSchema>;
export type SubmitAssessmentOutput = z.infer<typeof SubmitAssessmentOutputSchema>;
export type AssessmentStatusOutput = z.infer<typeof AssessmentStatusOutputSchema>;
export type AssessmentReportOutput = z.infer<typeof AssessmentReportOutputSchema>;
