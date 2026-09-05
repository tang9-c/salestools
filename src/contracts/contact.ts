import { z } from 'zod';
import { UtcTimestampSchema } from './identity.js';
import { DirectEvidenceUrlSchema } from './research.js';

const DirectContactPattern = /(?:[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\+?\d[\d\s().-]{5,}\d)/iu;

export const PublicIdentityTextSchema = z.string().trim().min(1).refine(
  value => !DirectContactPattern.test(value.normalize('NFKC')),
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
  title: PublicIdentityTextSchema,
  roleCategory: ContactRoleCategorySchema,
  sourceType: ContactSourceTypeSchema,
  sourceUrl: DirectEvidenceUrlSchema,
}).strict();

const PublicContactSchema = z.object({
  name: PublicIdentityTextSchema,
  title: PublicIdentityTextSchema,
  source_url: DirectEvidenceUrlSchema,
  published_at: UtcTimestampSchema.nullable(),
}).strict();

const ContactCompanySchema = z.object({
  company_name: PublicIdentityTextSchema,
  contacts: z.array(PublicContactSchema).max(10),
}).strict();

export const GetContactsOutputSchema = z.object({
  companies: z.array(ContactCompanySchema).max(3),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
}).strict();

export type ContactExtractionCandidate = z.infer<typeof ContactExtractionCandidateSchema>;
export type GetContactsOutput = z.infer<typeof GetContactsOutputSchema>;

export interface ContactExtractionResult {
  contacts: ContactExtractionCandidate[];
  selection: {
    totalPages: number;
    includedPages: number;
    textTruncated: boolean;
  };
}
