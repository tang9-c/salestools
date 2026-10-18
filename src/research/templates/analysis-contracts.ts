import { z } from 'zod';
import {
  ProductKeySchema,
  ResearchClaimSchema,
  ResearchGapSchema,
} from '../contracts.js';
import type { SalesScenarioResult } from './sales-scenario-contracts.js';
export const ResearchTopicSchema = z.enum([
  'business',
  'engineering',
  'recruitment',
  'software',
  'quality',
  'procurement',
  'project',
]);
export type ResearchTopic = z.infer<typeof ResearchTopicSchema>;
/** The model selects a controlled topic. It cannot inject arbitrary companies, URLs or tool names. */
export const ResearchQuerySuggestionSchema = z
  .object({
    gap_id: z.string().min(1).max(200),
    product_keys: z.array(ProductKeySchema).min(1).max(7),
    topic: ResearchTopicSchema,
  })
  .strict();
export const CompanyResearchAnalysisSchema = z
  .object({
    claims: z.array(ResearchClaimSchema).max(60),
    gaps: z.array(ResearchGapSchema).max(100),
    queries: z.array(ResearchQuerySuggestionSchema).max(8),
  })
  .strict();
export type ResearchAnalysis = z.infer<typeof CompanyResearchAnalysisSchema> & {
  template_result?: SalesScenarioResult;
  template_warnings?: string[];
};
