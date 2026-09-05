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
}).strict();

export const SubmitAssessmentInputSchema = z.object({
  legal_name: z.string().min(1).max(256),
  credit_code: z.string().regex(/^[0-9A-Z]{18}$/),
  force_refresh: z.boolean().default(false),
}).strict();

export const AssessmentIdInputSchema = z.object({
  assessment_id: z.uuid(),
}).strict();

export const GetContactsInputSchema = z.object({
  query: z.string().trim().min(1).max(48),
  region_hint: z.string().trim().min(1).max(16).optional(),
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
