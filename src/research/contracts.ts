import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProductKeySchema, type ProductKey } from '../contracts/evidence.js';
import {
  SalesScenarioResultSchema,
  hasPrivateScenarioText,
} from './templates/sales-scenario-contracts.js';
import { ProductOpportunitySchema } from '../contracts/opportunity.js';
export { ProductKeySchema };
export type { ProductKey };
export const RESEARCH_TEMPLATE = {
  id: 'company_research',
  version: 1,
} as const;
export const RESEARCH_METHOD_VERSION = 'research@1';
export const RESEARCH_EVALUATOR_VERSION = 'opportunity@1';
export const DEFAULT_RESEARCH_GOAL =
  '研究企业业务、工程场景及目标产品的软件使用线索，识别有证据的机会与待核实缺口';
const text = z.string().trim().min(1);
const id = text.max(200);
const date = z.iso.datetime({ offset: true });
const webUrl = z
  .url()
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'HTTP(S) URL required',
  );
const products = z
  .array(ProductKeySchema)
  .min(1)
  .max(7)
  .refine((p) => new Set(p).size === p.length, 'duplicate products');
export const ResearchTemplateSchema = z.discriminatedUnion('id', [
  z
    .object({ id: z.literal('company_research'), version: z.literal(1) })
    .strict(),
  z
    .object({ id: z.literal('product_sales_scenario'), version: z.literal(1) })
    .strict(),
]);
export type ResearchTemplateRef = z.infer<typeof ResearchTemplateSchema>;
export const ResearchModeSchema = z.enum(['initial', 'continue', 'refresh']);
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
const common = {
  operation_id: id,
  products: products.optional(),
  goal: text.max(1000).optional(),
  template_id: z
    .enum(['company_research', 'product_sales_scenario'])
    .optional(),
};
export const StartResearchInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...common,
      mode: z.literal('initial'),
      legal_name: text.max(500),
      credit_code: text.max(100),
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal('continue'),
      dossier_id: id,
      base_version_id: id,
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal('refresh'),
      dossier_id: id,
      base_version_id: id,
    })
    .strict(),
]);
export type StartResearchInput = z.infer<typeof StartResearchInputSchema>;
export function normalizeResearchRequest(input: unknown): StartResearchInput {
  const parsed = StartResearchInputSchema.parse(input);
  return {
    ...parsed,
    ...(parsed.products
      ? {
          products: ProductKeySchema.options.filter((p) =>
            parsed.products!.includes(p),
          ),
        }
      : {}),
  };
}
export function researchRequestHash(input: StartResearchInput): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(normalizeResearchRequest(input))))
    .digest('hex');
}
export const SignalKindSchema = z.enum([
  'direct_use',
  'job_requirement',
  'associated_skill',
  'project_use',
  'supplier_project',
  'other',
]);
const evidenceCommon = {
  evidence_id: id,
  source_key: id,
  title: text.max(1000),
  quote: text.max(2000),
  published_at: date.nullable(),
  collected_at: date,
  valid_from: date.nullable(),
  valid_to: date.nullable(),
  company_scope: z.enum(['confirmed', 'probable', 'unverified']),
  signal_kind: SignalKindSchema,
  product_keys: products,
  required_evidence_ids: z.array(id).max(80),
};
export const ResearchEvidenceSchema = z.discriminatedUnion('source_type', [
  z
    .object({
      ...evidenceCommon,
      source_type: z.literal('web'),
      url: webUrl,
      locator: z.object({ url: webUrl, publisher: text.max(500) }).strict(),
    })
    .strict()
    .refine((e) => e.url === e.locator.url, 'web locator URL mismatch'),
  z
    .object({
      ...evidenceCommon,
      source_type: z.literal('qcc'),
      url: webUrl.nullable(),
      locator: z.object({ tool: id, record_id: id }).strict(),
    })
    .strict(),
  z
    .object({
      ...evidenceCommon,
      source_type: z.literal('graph'),
      url: z.null(),
      locator: z
        .object({
          entity_id: id,
          entity_version: z.union([id, z.number().int().nonnegative()]),
          evidence_id: id.optional(),
          relation_id: id.optional(),
          file_sha256: id.optional(),
          page: z.number().int().positive().optional(),
          text_hash: id.optional(),
        })
        .strict()
        .refine(
          (l) =>
            Boolean(l.evidence_id || l.relation_id) &&
            Boolean(l.file_sha256 || l.text_hash),
          'graph provenance required',
        ),
    })
    .strict(),
  z
    .object({
      ...evidenceCommon,
      source_type: z.literal('assessment'),
      url: webUrl.nullable(),
      locator: z.object({ assessment_id: id, evidence_id: id }).strict(),
    })
    .strict(),
]);
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
export const ResearchClaimSchema = z
  .object({
    claim_id: id,
    kind: z.enum(['supported', 'strong_signal', 'hypothesis', 'unknown']),
    text: text.max(4000),
    product_keys: products,
    evidence_ids: z.array(id).max(80),
    temporal_scope: z.enum(['historical', 'current_supported', 'unknown']),
    subject_key: id.nullable(),
    predicate: id.nullable(),
    object_key: id.nullable(),
  })
  .strict()
  .refine(
    (c) => c.kind === 'unknown' || c.evidence_ids.length > 0,
    'claim requires derivation evidence',
  );
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;
export const ResearchFactSchema = z
  .object({
    fact_id: id,
    kind: z.enum([
      'industry',
      'product_scene',
      'recruitment',
      'software_ecosystem',
      'organization',
      'quality',
      'manufacturing',
      'procurement',
      'budget',
      'other',
    ]),
    text: text.max(4000),
    product_keys: products,
    evidence_ids: z.array(id).min(1).max(80),
  })
  .strict();
export type ResearchFact = z.infer<typeof ResearchFactSchema>;
export const ResearchGapSchema = z
  .object({
    gap_id: id,
    kind: z.enum(['knowledge', 'technical', 'conflict']),
    text: text.max(2000),
    product_keys: products,
    evidence_ids: z.array(id).max(80),
    priority: z.enum(['high', 'medium', 'low']).default('medium'),
  })
  .strict();
export type ResearchGap = z.infer<typeof ResearchGapSchema>;
export const ResearchCoverageSchema = z
  .object({
    product: ProductKeySchema,
    scope_complete: z.boolean(),
    technical_gap_ids: z.array(id),
    knowledge_gap_ids: z.array(id),
    blocking_conflict_ids: z.array(id),
  })
  .strict();
export const ResearchChangeSchema = z
  .object({
    kind: id,
    key: id,
    description: text.max(2000),
    product_keys: products,
    evidence_ids: z.array(id),
  })
  .strict();
export const ResearchChangesSchema = z
  .object({
    business_changes: z.array(ResearchChangeSchema).max(100),
    method_changes: z.array(ResearchChangeSchema).max(100),
    analysis_changes: z.array(ResearchChangeSchema).max(100),
  })
  .strict();
export const ResearchSourceStatusSchema = z
  .object({
    source: z.enum(['qcc', 'web', 'graph', 'assessment', 'model']),
    status: z.enum([
      'not_started',
      'available',
      'unavailable',
      'partial',
      'failed',
      'completed',
    ]),
    error_code: id.nullable().optional(),
    omitted: z.number().int().nonnegative().optional(),
  })
  .strict();
export const ResearchBudgetUsageSchema = z
  .object({
    qcc: z.number().int().nonnegative(),
    search: z.number().int().nonnegative(),
    ark: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    graph: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((b) => b.total === b.qcc + b.search + b.ark, 'invalid total');
export const ResearchEvidenceCheckSchema = z
  .object({
    evidence_id: id,
    last_checked_at: date.nullable(),
    check_outcome: z.enum([
      'unchanged',
      'changed',
      'unavailable',
      'not_checked',
    ]),
    attempts: z
      .array(
        z.object({ attempted_at: date, error_code: id.nullable() }).strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
const productGoals = z.partialRecord(ProductKeySchema, text.max(1000));
const productBases = z.partialRecord(ProductKeySchema, id.nullable());
function sameKeys(keys: string[], scope: string[]): boolean {
  return keys.length === scope.length && scope.every((p) => keys.includes(p));
}
export const AcceptedResearchRequestSchema = z
  .object({
    client_request: StartResearchInputSchema,
    schema_version: z.literal(1),
    template: ResearchTemplateSchema,
    method_version: id,
    product_keys: products,
    product_goals: productGoals,
    product_base_versions: productBases,
    effective_goal: text.max(10000),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      !sameKeys(Object.keys(r.product_goals), r.product_keys) ||
      !sameKeys(Object.keys(r.product_base_versions), r.product_keys)
    )
      c.addIssue({ code: 'custom', message: 'product maps must equal scope' });
  });
export type AcceptedResearchRequest = z.infer<
  typeof AcceptedResearchRequestSchema
>;
export const ResearchSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    template: ResearchTemplateSchema,
    method_version: id,
    evaluator_version: id,
    dossier_id: id,
    run_id: id,
    credit_code: text.max(100),
    legal_name: text.max(500),
    effective_goal: text.max(10000),
    product_keys: products,
    product_goals: productGoals,
    parent_version_id: id.nullable(),
    evidence_base_version_ids: z.array(id).max(7),
    template_result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('company_research') }).strict(),
      SalesScenarioResultSchema,
    ]),
    summary: text.max(12000),
    evidence: z.array(ResearchEvidenceSchema).max(80),
    facts: z.array(ResearchFactSchema).max(80),
    claims: z.array(ResearchClaimSchema).max(60),
    gaps: z.array(ResearchGapSchema).max(100),
    product_assessments: z.array(ProductOpportunitySchema).max(7),
    coverage: z.array(ResearchCoverageSchema).min(1).max(7),
    changes: ResearchChangesSchema,
    source_status: z.array(ResearchSourceStatusSchema).max(10),
    budget_usage: ResearchBudgetUsageSchema,
    evidence_checks: z.array(ResearchEvidenceCheckSchema).max(80),
  })
  .strict()
  .superRefine((s, c) => {
    const error = (message: string) => c.addIssue({ code: 'custom', message });
    if (s.template.id !== s.template_result.kind)
      error('template/result mismatch');
    if (s.template_result.kind === 'product_sales_scenario') {
      if (hasPrivateScenarioText(s.template_result))
        error('TEMPLATE_OUTPUT_INVALID');
      if (
        !sameKeys(
          s.template_result.products.map((p) => p.product),
          s.product_keys,
        )
      )
        error('scenario products must equal scope');
      const claims = new Map(s.claims.map((c) => [c.claim_id, c]));
      for (const p of s.template_result.products) {
        const ids = [
          ...p.scene_claim_ids,
          ...p.software_claim_ids,
          ...p.known_blocker_claim_ids,
          ...p.paths.flatMap((path) => [
            ...path.supporting_claim_ids,
            ...path.contradicting_claim_ids,
          ]),
        ];
        if (ids.some((id) => !claims.get(id)?.product_keys.includes(p.product)))
          error('scenario claim reference invalid');
      }
    }
    const evidence = new Set(s.evidence.map((e) => e.evidence_id));
    const gaps = new Map(s.gaps.map((g) => [g.gap_id, g]));
    if (evidence.size !== s.evidence.length) error('duplicate evidence');
    if (
      new Set(s.claims.map((v) => v.claim_id)).size !== s.claims.length ||
      gaps.size !== s.gaps.length
    )
      error('duplicate claims/gaps');
    if (!sameKeys(Object.keys(s.product_goals), s.product_keys))
      error('product goals must equal scope');
    if (
      !sameKeys(
        s.coverage.map((v) => v.product),
        s.product_keys,
      )
    )
      error('coverage must equal scope');
    const scoped = (p: ProductKey[]) =>
      p.every((k) => s.product_keys.includes(k));
    for (const e of s.evidence) {
      if (
        !e.required_evidence_ids.every(
          (x) => evidence.has(x) && x !== e.evidence_id,
        )
      )
        error('evidence dependency missing');
    }
    for (const entity of [
      ...s.claims,
      ...s.facts,
      ...s.gaps,
      ...Object.values(s.changes).flat(),
    ]) {
      if (!entity.evidence_ids.every((x) => evidence.has(x)))
        error('reference missing');
      if (!scoped(entity.product_keys)) error('entity outside scope');
    }
    for (const coverage of s.coverage) {
      for (const [field, kind] of [
        ['technical_gap_ids', 'technical'],
        ['knowledge_gap_ids', 'knowledge'],
        ['blocking_conflict_ids', 'conflict'],
      ] as const)
        if (
          !coverage[field].every(
            (x) =>
              gaps.get(x)?.kind === kind &&
              gaps.get(x)!.product_keys.includes(coverage.product),
          )
        )
          error('coverage gap reference invalid');
      if (
        coverage.scope_complete &&
        (coverage.technical_gap_ids.length ||
          coverage.blocking_conflict_ids.length)
      )
        error('complete coverage contains processing gaps');
    }
    const assessed = new Set<string>();
    for (const p of s.product_assessments) {
      if (
        assessed.has(p.product) ||
        !s.product_keys.includes(p.product) ||
        !p.evidenceIds.every((x) => evidence.has(x))
      )
        error('assessment reference invalid');
      assessed.add(p.product);
    }
    if (
      !s.evidence_checks.every((v) => evidence.has(v.evidence_id)) ||
      new Set(s.evidence_checks.map((v) => v.evidence_id)).size !==
        s.evidence_checks.length
    )
      error('invalid evidence checks');
    if (Buffer.byteLength(JSON.stringify(s), 'utf8') > 2 * 1024 * 1024)
      error('snapshot exceeds 2 MiB');
  });
export type ResearchSnapshot = z.infer<typeof ResearchSnapshotSchema>;
export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const ResearchProgressSchema = z
  .object({ phase: id, completed_rounds: z.number().int().min(0).max(3) })
  .strict();
export const ResearchRunSchema = z
  .object({
    run_id: id,
    dossier_id: id,
    actor: id,
    operation_id: id,
    request_hash: id,
    mode: ResearchModeSchema,
    base_version_id: id.nullable(),
    request: AcceptedResearchRequestSchema,
    status: RunStatusSchema,
    progress: ResearchProgressSchema,
    budget_usage: ResearchBudgetUsageSchema,
    source_status: z.array(ResearchSourceStatusSchema),
    stop_reason: id.nullable(),
    error_code: id.nullable(),
    cancelled_by: id.nullable(),
    created_at: date,
    started_at: date.nullable(),
    completed_at: date.nullable(),
    version_id: id.nullable(),
  })
  .strict();
export type ResearchRun = z.infer<typeof ResearchRunSchema>;
export const ResearchDossierSchema = z
  .object({
    dossier_id: id,
    credit_code: text,
    legal_name: text,
    created_by: id,
    created_at: date,
    updated_at: date,
  })
  .strict();
export type ResearchDossier = z.infer<typeof ResearchDossierSchema>;
export const ResearchVersionSchema = z
  .object({
    version_id: id,
    dossier_id: id,
    run_id: id,
    sequence: z.number().int().positive(),
    parent_version_id: id.nullable(),
    scope: products,
    status: z.enum(['completed', 'partial']),
    snapshot: ResearchSnapshotSchema,
    created_at: date,
  })
  .strict();
export type ResearchVersion = z.infer<typeof ResearchVersionSchema>;
export function parseResearchSnapshot(value: unknown): ResearchSnapshot {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schema_version?: unknown }).schema_version !== 1 ||
    !['company_research', 'product_sales_scenario'].includes(
      String((value as { template?: { id?: unknown } }).template?.id),
    ) ||
    (value as { template?: { version?: unknown } }).template?.version !== 1
  )
    throw new Error('RESEARCH_VERSION_UNSUPPORTED');
  return ResearchSnapshotSchema.parse(value);
}
