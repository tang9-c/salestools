import { z } from 'zod';
import { IdentityProfileSchema, UtcTimestampSchema } from './identity.js';

export const ResearchSourceStatusSchema = z.enum(['completed', 'partial', 'failed']);
export const EntityScopeSchema = z.enum(['legal_entity', 'group', 'subsidiary', 'brand', 'unknown']);
export const EntityMatchSchema = z.enum(['confirmed', 'probable', 'unverified']);

export const ResearchItemSchema = z.object({
  evidenceId: z.string(),
  source: z.enum(['qcc', 'doubao_search']),
  sourceKind: z.enum(['company', 'risk', 'ipr', 'operation', 'web']),
  title: z.string(),
  url: z.string(),
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
}).strict();

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
