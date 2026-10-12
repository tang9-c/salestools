import { z } from 'zod';
import { UtcTimestampSchema } from './identity.js';
import { BasicProfileSchema } from './index.js';
import { validCreditCode } from '../companies/company-link.js';

export const ReadStateSchema = z.enum(['ok','partial','unavailable','not_applicable']);
export const LinkStateSchema = z.enum(['unlinked','candidate','confirmed','conflict','revoked']);
const readMeta = { state: ReadStateSchema, warnings: z.array(z.string()) };
export const LinkResolutionSchema = z.object({
  state: LinkStateSchema, organization_id:z.string(),
  credit_code:z.string().nullable(), basis:z.enum(['manual','identifier_match']).nullable(),
  version:z.int().nonnegative(), candidates:z.array(z.object({credit_code:z.string(),legal_name:z.string()}).strict()),
  warnings:z.array(z.string()),
}).strict();
export const CompanyLinkSchema = z.object({
  organization_id:z.string(),credit_code:z.string().nullable(),state:z.enum(['confirmed','revoked']),
  version:z.int().nonnegative(),identity_hash:z.string(),organization_version:z.int().nonnegative(),
  note:z.string(),actor:z.string(),updated_at:UtcTimestampSchema,
}).strict();
export const LinkCompanyInputSchema = z.object({
  action:z.enum(['confirm','unlink']), organization_id:z.string().trim().min(1).max(128),
  credit_code:z.string().refine(validCreditCode,'Invalid credit code').optional(),
  operation_id:z.string().trim().min(1).max(200),expected_link_version:z.int().nonnegative(),
  expected_organization_version:z.int().positive(),
  note:z.string().trim().min(1).refine(v=>[...v].length<=500,'审核说明最多 500 字符'),
}).strict().superRefine((v,c)=>{if(v.action==='confirm'&&!v.credit_code)c.addIssue({code:'custom',message:'Confirm requires credit_code'});});
export const ReportItemSchema = z.object({assessment_id:z.uuid(),generated_at:UtcTimestampSchema,
  collected_at:UtcTimestampSchema,overall_opportunity:z.string(),recommended_product:z.string().nullable()}).strict();
export const CompanySummarySchema = z.object({...readMeta,link:LinkResolutionSchema,
  has_profile:z.boolean().nullable(),report_count:z.int().nonnegative().nullable(),latest_report_at:UtcTimestampSchema.nullable()}).strict();
export const CompanyDetailSchema = CompanySummarySchema.extend({
  profile:z.object({legal_name:z.string(),credit_code:z.string(),basic_profile:z.lazy(()=>BasicProfileSchema),
    collected_at:UtcTimestampSchema,stale:z.boolean()}).strict().nullable(),
  latest_report:ReportItemSchema.nullable(),reports:z.object({items:z.array(ReportItemSchema),total:z.int().nonnegative().nullable(),next_offset:z.int().nonnegative().nullable(),complete:z.boolean()}).strict(),
});
export const CountSchema=z.object({count:z.int().nonnegative().nullable(),loaded_count:z.int().nonnegative(),complete:z.boolean()}).strict();
export const ReportSummarySchema=z.object({count:z.int().nonnegative(),latest:ReportItemSchema.nullable()}).strict();
export const CompanyOverviewSchema=z.object({...readMeta,organization_ids:z.array(z.string()),organizations_complete:z.boolean(),
  people:CountSchema,projects:CountSchema,reports:ReportSummarySchema.nullable()}).strict();
export const RecentRecordSchema=z.object({kind:z.enum(['entity','relation','evidence','profile','assessment']),id:z.string(),entity_id:z.string().optional(),recorded_at:UtcTimestampSchema,label:z.string()}).strict();
export const RelatedUpdatesSchema=z.object({...readMeta,since:UtcTimestampSchema,scope:z.array(z.string()),truncated:z.boolean(),
  items:z.array(RecentRecordSchema).max(20)}).strict();
