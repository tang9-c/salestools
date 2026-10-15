import { z } from 'zod';
import { UtcTimestampSchema } from './identity.js';
import { DirectEvidenceUrlSchema } from './research.js';

const DirectContactPattern = /(?:[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\+?\d[\d\s().-]{5,}\d)/iu;
const ContactAccountPattern = /(?:(?:微信(?:号|ID)|wechat\s*id|QQ号|账号)\s*[:：]?\s*[\p{L}\p{N}_-]+|(?:微信|wechat|wx|QQ)\s*[:：]\s*[\p{L}\p{N}_-]+|(?:微信|wechat|wx)\s+[a-z0-9_-]+|QQ\s*[0-9]{5,})/iu;

export function redactPublicIdentityText(value: string): string {
  return value.normalize('NFKC')
    .replace(new RegExp(DirectContactPattern.source, 'giu'), '')
    .replace(new RegExp(ContactAccountPattern.source, 'giu'), '').trim();
}

export const PublicIdentityTextSchema = z.string().trim().min(1).refine(
  value => !DirectContactPattern.test(value.normalize('NFKC'))
    && !ContactAccountPattern.test(value.normalize('NFKC')),
  { message: 'direct contact details are forbidden' },
);

export const ContactRoleCategorySchema = z.enum([
  'executive',
  'research_and_development',
  'digital_and_it',
  'procurement',
  'quality',
]);

export const ContactSourceTypeSchema = z.enum([
  'official_website',
  'official_news',
  'official_wechat',
  'tender',
  'patent',
  'conference',
]);

export const ContactExtractionCandidateSchema = z.object({
  companyName: PublicIdentityTextSchema,
  name: PublicIdentityTextSchema,
  title: PublicIdentityTextSchema.nullable(),
  affiliationStatus: z.enum(['employment_evidence', 'unverified']),
  evidenceQuote: z.string().trim().min(1),
  sourceChunkId: z.string().min(1),
  sourceUrl: DirectEvidenceUrlSchema,
}).strict();

export const PublicContactSchema = z.object({
  name: PublicIdentityTextSchema,
  title: PublicIdentityTextSchema.nullable(),
  source_url: DirectEvidenceUrlSchema,
  published_at: UtcTimestampSchema.nullable(),
  affiliation_status: z.enum(['employment_evidence', 'unverified']).optional(),
  evidence_quote: PublicIdentityTextSchema.optional(),
}).strict();

export const ContactSnapshotCompanySchema = z.object({
  company_name: PublicIdentityTextSchema,
  contacts: z.array(PublicContactSchema),
}).strict();

export const ContactCoverageSchema = z.object({
  version: z.literal(2),
  total_pages: z.number().int().nonnegative(),
  total_chunks: z.number().int().nonnegative(),
  processed_chunks: z.number().int().nonnegative(),
  pending_pages: z.array(DirectEvidenceUrlSchema),
  complete: z.boolean(),
}).strict();

export const ContactSnapshotPayloadSchema = z.object({
  companies: z.array(ContactSnapshotCompanySchema),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
  coverage: ContactCoverageSchema.optional(),
}).strict();

export const HistoricalContactSchema = PublicContactSchema.extend({
  first_seen_at: UtcTimestampSchema,
  last_seen_at: UtcTimestampSchema,
  status: z.literal('historical_evidence'),
}).strict();

const ContactCompanySchema = ContactSnapshotCompanySchema.extend({
  historical_contacts: z.array(HistoricalContactSchema),
}).strict();

export const GetContactsOutputSchema = z.object({
  web_page: z.object({ snapshot_id: z.number().int().positive(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), total: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative().nullable() }).strict().optional(),
  web_coverage: ContactCoverageSchema.nullable().optional(),
  companies: z.array(ContactCompanySchema),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
}).strict();

export type ContactExtractionCandidate = z.infer<typeof ContactExtractionCandidateSchema>;
export type ContactSnapshotPayload = z.infer<typeof ContactSnapshotPayloadSchema>;
export type HistoricalContact = z.infer<typeof HistoricalContactSchema>;
export type GetContactsOutput = z.infer<typeof GetContactsOutputSchema>;

export interface ContactExtractionResult {
  contacts: ContactExtractionCandidate[];
  selection: {
    totalPages: number;
    includedPages: number;
    textTruncated: boolean;
  };
  coverage?: z.infer<typeof ContactCoverageSchema>;
  warnings?: string[];
}
