import { z } from 'zod';
import { ProductKeySchema, type ProductKey } from '../../contracts/evidence.js';
export const PRODUCT_SALES_SCENARIO_TEMPLATE_REF = {
  id: 'product_sales_scenario',
  version: 1,
} as const;
const text = z.string().trim().min(1);
const refs = z
  .array(text.max(200))
  .max(20)
  .refine((v) => new Set(v).size === v.length, 'duplicate claim references');
export const ScenarioPathSchema = z
  .object({
    kind: z.enum(['new_purchase', 'replacement', 'complement']),
    state: z.enum(['worth_exploring', 'insufficient', 'contradicted']),
    rationale: text.max(1000),
    supporting_claim_ids: refs,
    contradicting_claim_ids: refs,
    prerequisites: z.array(text.max(300)).max(5),
    questions: z.array(text.max(300)).max(5),
  })
  .strict()
  .superRefine((p, c) => {
    if (p.state === 'worth_exploring' && !p.supporting_claim_ids.length)
      c.addIssue({
        code: 'custom',
        message: 'exploration requires supporting claims',
      });
    if (p.state === 'contradicted' && !p.contradicting_claim_ids.length)
      c.addIssue({
        code: 'custom',
        message: 'contradiction requires counterevidence',
      });
  });
export const ProductScenarioSchema = z
  .object({
    product: ProductKeySchema,
    scene_claim_ids: refs,
    software_claim_ids: refs,
    paths: z
      .array(ScenarioPathSchema)
      .length(3)
      .refine(
        (paths) => new Set(paths.map((p) => p.kind)).size === 3,
        'three distinct paths required',
      ),
    known_blocker_claim_ids: refs,
    unknowns: z.array(text.max(300)).max(10),
  })
  .strict();
export const SalesScenarioResultSchema = z
  .object({
    kind: z.literal('product_sales_scenario'),
    products: z
      .array(ProductScenarioSchema)
      .min(1)
      .max(7)
      .refine(
        (p) => new Set(p.map((x) => x.product)).size === p.length,
        'duplicate products',
      ),
  })
  .strict();
export type SalesScenarioResult = z.infer<typeof SalesScenarioResultSchema>;
export type ProductScenario = z.infer<typeof ProductScenarioSchema>;

import { containsPrivateContact } from '../privacy.js';
/** Inspect every free-text leaf; identifiers and controlled enums are not prose. */
export function hasPrivateScenarioText(value: unknown, key = ''): boolean {
  if (key.endsWith('_claim_ids') || ['product', 'kind', 'state'].includes(key))
    return false;
  if (typeof value === 'string') return containsPrivateContact(value);
  if (Array.isArray(value))
    return value.some((v) => hasPrivateScenarioText(v, key));
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => hasPrivateScenarioText(v, k));
  return false;
}
