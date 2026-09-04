import { z } from 'zod';
import { ProductKeySchema } from './evidence.js';

export const OpportunityLevelSchema = z.enum(['高', '中', '低', '待核实']);
export const OpportunityConfidenceSchema = z.enum(['高', '中', '低']);

export const ProductOpportunitySchema = z.object({
  product: ProductKeySchema,
  level: OpportunityLevelSchema,
  confidence: OpportunityConfidenceSchema,
  evidenceIds: z.array(z.string()),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
  gaps: z.array(z.string()),
}).strict();

export const CompleteProductOpportunitiesSchema = z.array(ProductOpportunitySchema)
  .length(ProductKeySchema.options.length)
  .superRefine((products, context) => {
    const actual = new Set(products.map(product => product.product));
    if (actual.size !== ProductKeySchema.options.length
      || ProductKeySchema.options.some(product => !actual.has(product))) {
      context.addIssue({
        code: 'custom',
        message: 'products must contain every ProductKey exactly once',
      });
    }
  });

export const OpportunityAssessmentSchema = z.object({
  products: CompleteProductOpportunitiesSchema,
  overallOpportunity: OpportunityLevelSchema,
  recommendedProduct: ProductKeySchema.nullable(),
  summaryReasons: z.array(z.string()),
}).strict();

export type OpportunityLevel = z.infer<typeof OpportunityLevelSchema>;
export type OpportunityConfidence = z.infer<typeof OpportunityConfidenceSchema>;
export type ProductOpportunity = z.infer<typeof ProductOpportunitySchema>;
export type OpportunityAssessment = z.infer<typeof OpportunityAssessmentSchema>;
