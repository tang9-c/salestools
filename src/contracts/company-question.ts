import { z } from 'zod';
import { ContextCitationSchema } from './company-context.js';
import { EvidenceFactSchema, EvidenceReferenceSchema } from './evidence.js';
import { UtcTimestampSchema } from './identity.js';

export const SnapshotItemSchema = EvidenceReferenceSchema.extend({
  source: z.enum(['qcc', 'doubao_search']),
  sourceKind: z.enum(['company', 'risk', 'ipr', 'operation', 'web']),
  excerpt: z.string().max(600).nullable(),
  excerptTruncated: z.boolean(),
}).strict();

export const EvidenceSnapshotSchema = z.object({
  collectedAt: UtcTimestampSchema,
  items: z.array(SnapshotItemSchema),
  facts: z.array(EvidenceFactSchema),
}).strict();

export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

export const CompanyAnswerClaimSchema = z.object({
  category: z.enum(['supported', 'interpretation', 'unknown']),
  text: z.string().trim().min(1).max(1000),
  evidenceIds: z.array(z.string()),
  contextRefs: z.array(z.string()).max(20).optional(),
}).strict();

export const CompanyAnswerSchema = z.object({
  claims: z.array(CompanyAnswerClaimSchema).max(20),
}).strict();

export const CompanyQuestionSourceSchema = z.object({
  title: z.string(),
  source: z.enum(['qcc', 'doubao_search']),
  url: z.string().nullable(),
  publishedAt: UtcTimestampSchema.nullable(),
}).strict();

export const CompanyQuestionResultSchema = z.object({
  status: z.enum(['answered', 'insufficient', 'failed']),
  legalName: z.string(),
  markdown: z.string(),
  usedFreshResearch: z.boolean(),
  collectedAt: UtcTimestampSchema.nullable(),
  sources: z.array(CompanyQuestionSourceSchema),
  context_citations: z.array(ContextCitationSchema).max(20).optional(),
  context_warnings: z.array(z.string()).optional(),
}).strict();

export type CompanyAnswerClaim = z.infer<typeof CompanyAnswerClaimSchema>;
export type CompanyQuestionResult = z.infer<typeof CompanyQuestionResultSchema>;
