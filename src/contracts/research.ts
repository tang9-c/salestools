import { z } from 'zod';
import { IdentityProfileSchema, UtcTimestampSchema } from './identity.js';

export const ResearchSourceStatusSchema = z.enum(['completed', 'partial', 'failed']);
export const EntityScopeSchema = z.enum(['legal_entity', 'group', 'subsidiary', 'brand', 'unknown']);
export const EntityMatchSchema = z.enum(['confirmed', 'probable', 'unverified']);

export const DirectEvidenceUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.hostname.length === 0
      || url.username.length > 0
      || url.password.length > 0) {
      context.addIssue({ code: 'custom', message: 'expected a credential-free HTTP(S) direct evidence URL' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'expected a valid direct evidence URL' });
  }
});

export const ResearchItemSchema = z.object({
  evidenceId: z.string(),
  source: z.enum(['qcc', 'doubao_search']),
  sourceKind: z.enum(['company', 'risk', 'ipr', 'operation', 'web']),
  title: z.string(),
  url: DirectEvidenceUrlSchema.nullable(),
  originalPublisher: z.string().nullable(),
  originalDomain: z.string().nullable(),
  summary: z.string().nullable(),
  content: z.string().nullable(),
  publishedAt: UtcTimestampSchema.nullable(),
  collectedAt: UtcTimestampSchema,
  mentionedName: z.string(),
  entityScope: EntityScopeSchema,
  entityMatch: EntityMatchSchema,
  matchBasis: z.array(z.string()),
  query: z.string().nullable(),
  position: z.number().nullable(),
  logId: z.string().nullable(),
}).strict().superRefine((item, context) => {
  if (item.source === 'doubao_search' && item.url === null) {
    context.addIssue({ code: 'custom', path: ['url'], message: 'search evidence requires a direct URL' });
  }
});

const SourceResultSchema = z.object({
  status: ResearchSourceStatusSchema,
  error: z.string().nullable(),
}).strict();

export const ResearchBundleSchema = z.object({
  identity: IdentityProfileSchema,
  items: z.array(ResearchItemSchema),
  sourceStatus: z.object({
    qcc: SourceResultSchema,
    doubaoSearch: SourceResultSchema,
  }).strict(),
  gaps: z.array(z.string()),
  collectedAt: UtcTimestampSchema,
}).strict();

export type ResearchSourceStatus = z.infer<typeof ResearchSourceStatusSchema>;
export type EntityScope = z.infer<typeof EntityScopeSchema>;
export type EntityMatch = z.infer<typeof EntityMatchSchema>;
export type ResearchItem = z.infer<typeof ResearchItemSchema>;
export type ResearchBundle = z.infer<typeof ResearchBundleSchema>;
