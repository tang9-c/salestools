import { z } from 'zod';
import {
  AssessmentReportOutputSchema,
  AssessmentStatusOutputSchema,
  CompanyProfileOutputSchema,
  GetContactsOutputSchema,
  SubmitAssessmentOutputSchema,
} from '../contracts/index.js';

export const CompanyProfileInputSchema = z.object({
  query: z.string().min(1).max(256),
  region_hint: z.string().min(1).max(64).optional(),
  include_company_context: z.boolean().default(false),
}).strict();

export const SubmitAssessmentInputSchema = z.object({
  legal_name: z.string().min(1).max(256),
  credit_code: z.string().regex(/^[0-9A-Z]{18}$/),
  force_refresh: z.boolean().default(false),
}).strict();

export const AssessmentIdInputSchema = z.object({
  assessment_id: z.uuid(),
}).strict();

export const AssessmentReportInputSchema = AssessmentIdInputSchema.extend({
  include_related_updates: z.boolean().default(false),
});

export const GetContactsInputSchema = z.object({
  query: z.string().trim().min(1).max(48),
  region_hint: z.string().trim().min(1).max(16).optional(),
}).strict();

export const AskCompanyInputSchema = z.object({
  legal_name: z.string().trim().min(1).max(256),
  credit_code: z.string().regex(/^[0-9A-Z]{18}$/u),
  question: z.string().trim().min(1).max(1000),
  assessment_id: z.uuid().optional(),
}).strict();

export const AskCompanyOutputSchema = z.object({
  status: z.enum(['answered', 'insufficient', 'failed']),
  legal_name: z.string(),
  markdown: z.string(),
  used_fresh_research: z.boolean(),
  collected_at: z.iso.datetime({ offset: true }).nullable(),
  sources: z.array(z.object({
    title: z.string(), source: z.enum(['qcc', 'doubao_search']),
    url: z.string().nullable(), published_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict()),
}).strict();

export {
  AssessmentReportOutputSchema,
  AssessmentStatusOutputSchema,
  CompanyProfileOutputSchema,
  GetContactsOutputSchema,
  SubmitAssessmentOutputSchema,
};

export type CompanyProfileInput = z.infer<typeof CompanyProfileInputSchema>;
export type SubmitAssessmentInput = z.infer<typeof SubmitAssessmentInputSchema>;
export type GetContactsInput = z.infer<typeof GetContactsInputSchema>;
export type AskCompanyInput = z.infer<typeof AskCompanyInputSchema>;
