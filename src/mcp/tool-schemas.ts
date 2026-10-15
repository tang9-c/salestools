import { ContextCitationSchema } from '../contracts/company-context.js';
import { z } from 'zod';
import { ZohoConnectionIdSchema } from '../contracts/zoho-contact.js';
export * from '../contracts/zoho-contact.js';
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
  source: z.enum(['web', 'zoho', 'all']).default('web'),
  web_offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  web_limit: z.number().int().min(1).max(100).optional(),
  web_snapshot_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  zoho_accounts: z.array(ZohoConnectionIdSchema).min(1).optional(),
  zoho_account_records: z.array(z.object({ connection_id: ZohoConnectionIdSchema,
    account_id: z.string().trim().min(1) }).strict()).min(1).optional(),
}).strict().superRefine((input, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  if (input.source === 'zoho' && [input.web_offset, input.web_limit, input.web_snapshot_id].some(value => value !== undefined)) issue('source', '纯 Zoho 不支持网页分页参数');
  if ((input.web_offset ?? 0) > 0 && input.web_snapshot_id === undefined) issue('web_snapshot_id', '网页分页缺少快照 ID，请从第 0 页重新发起');
  if (input.source === 'web' && (input.zoho_accounts !== undefined || input.zoho_account_records !== undefined)) {
    issue('source', 'Zoho selections require zoho or all source');
  }
  if (input.zoho_accounts && new Set(input.zoho_accounts).size !== input.zoho_accounts.length) {
    issue('zoho_accounts', 'duplicate connection selection');
  }
  const records = input.zoho_account_records;
  if (records && new Set(records.map(record => JSON.stringify([record.connection_id, record.account_id]))).size !== records.length) {
    issue('zoho_account_records', 'duplicate account record selection');
  }
  if (records && input.zoho_accounts && records.some(record => !input.zoho_accounts!.includes(record.connection_id))) {
    issue('zoho_account_records', 'account record must belong to a selected connection');
  }
});

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
  context_citations:z.array(ContextCitationSchema).max(20).optional(),
  context_warnings:z.array(z.string()).optional(),
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
