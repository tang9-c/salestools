import { getResearchTemplate } from './templates/registry.js';
import {
  SALES_SCENARIO_QUESTIONS,
  SalesScenarioResultSchema,
  validateScenarioPaths,
} from './templates/product-sales-scenario.js';
import { z } from 'zod';
import {
  CompanyResearchAnalysisSchema,
  COMPANY_RESEARCH_SYSTEM_PROMPT,
  type ResearchAnalysis,
} from './templates/company-research.js';
import {
  ProductKeySchema,
  type ProductKey,
  type ResearchEvidence,
  type ResearchGap,
  type ResearchClaim,
  type ResearchTemplateRef,
} from './contracts.js';
import {
  evidenceDependencyGroup,
  validateClaim,
  normalizeClaimSemantics,
} from './evidence.js';
import { ARK_REQUEST_MAX_BYTES } from '../upstream/ark/payload-budget.js';
import { requestArkJsonContent } from '../upstream/ark/json-request.js';
import { ResearchPolicy, type ResearchStage } from './policy.js';
const ResearchModelContextSchema = z
  .object({
    company_identity: z
      .object({
        legal_name: z.string().trim().min(1).max(500),
        credit_code: z.string().trim().min(1).max(100),
      })
      .strict(),
    effective_goal: z.string().trim().min(1).max(10000),
    product_goals: z.partialRecord(
      ProductKeySchema,
      z.string().trim().min(1).max(1000),
    ),
  })
  .strict();
export type ResearchModelContext = z.infer<typeof ResearchModelContextSchema>;
export interface ResearchModel {
  readonly omitted?: number;
  analyze(
    materials: ResearchEvidence[],
    gaps: ResearchGap[],
    scope: ProductKey[],
    signal: AbortSignal,
    stage?: ResearchStage,
    claims?: ResearchClaim[],
  ): Promise<ResearchAnalysis>;
  close(): Promise<void>;
}
export function parseAnalysis(
  raw: unknown,
  materials: readonly ResearchEvidence[],
  gaps: readonly ResearchGap[],
  scope: readonly ProductKey[],
  companyKey?: string,
  options: {
    template?: ResearchTemplateRef;
    stage?: ResearchStage;
    claims?: readonly ResearchClaim[];
    asOf?: Date;
  } = {},
): ResearchAnalysis {
  const salesFinal =
    options.template?.id === 'product_sales_scenario' &&
    options.stage === 'final';
  let parsed: ResearchAnalysis;
  try {
    parsed = salesFinal
      ? CompanyResearchAnalysisSchema.extend({
          template_result: SalesScenarioResultSchema,
        }).parse(raw)
      : CompanyResearchAnalysisSchema.parse(raw);
  } catch (error) {
    if (salesFinal) throw new Error('TEMPLATE_OUTPUT_INVALID');
    throw error;
  }
  if (salesFinal && parsed.queries.length)
    throw new Error('TEMPLATE_OUTPUT_INVALID');
  if (
    parsed.claims.some(
      (c) => c.subject_key !== null && c.subject_key !== companyKey,
    )
  )
    throw new Error('INVALID_EVIDENCE');
  const result = {
    ...parsed,
    claims: parsed.claims.map((c) =>
      normalizeClaimSemantics(c, materials, companyKey),
    ),
  };
  const ids = new Set(materials.map((e) => e.evidence_id));
  const scoped = (products: ProductKey[]) =>
    new Set(products).size === products.length &&
    products.every((p) => scope.includes(p));
  if (
    new Set(result.claims.map((c) => c.claim_id)).size !==
      result.claims.length ||
    new Set(result.gaps.map((g) => g.gap_id)).size !== result.gaps.length ||
    result.claims.some(
      (c) => !scoped(c.product_keys) || !validateClaim(c, materials),
    ) ||
    result.gaps.some(
      (g) =>
        !scoped(g.product_keys) || g.evidence_ids.some((id) => !ids.has(id)),
    )
  )
    throw new Error('INVALID_EVIDENCE');
  const knownGaps = new Map(
    [...gaps, ...result.gaps].map((g) => [g.gap_id, g]),
  );
  if (
    result.queries.some(
      (q) =>
        !scoped(q.product_keys) ||
        !knownGaps.has(q.gap_id) ||
        q.product_keys.some(
          (p) => !knownGaps.get(q.gap_id)!.product_keys.includes(p),
        ),
    )
  )
    throw new Error('INVALID_QUERY');
  if (salesFinal) {
    const old = new Map((options.claims ?? []).map((c) => [c.claim_id, c]));
    if (
      result.claims.some(
        (c) =>
          old.has(c.claim_id) &&
          JSON.stringify(old.get(c.claim_id)) !== JSON.stringify(c),
      )
    )
      throw new Error('TEMPLATE_OUTPUT_INVALID');
    const checked = validateScenarioPaths(result.template_result!, {
      claims: [...(options.claims ?? []), ...result.claims],
      evidence: materials,
      scope,
      companyKey,
      asOf: options.asOf,
    });
    return {
      ...result,
      template_result: checked.result,
      template_warnings: checked.warnings,
    };
  }
  return result;
}
export function packModelRequest(
  model: string,
  materials: readonly ResearchEvidence[],
  gaps: readonly ResearchGap[],
  scope: readonly ProductKey[],
  context: ResearchModelContext,
  maxBytes = ARK_REQUEST_MAX_BYTES,
  options: {
    template?: ResearchTemplateRef;
    stage?: ResearchStage;
    claims?: readonly ResearchClaim[];
    asOf?: Date;
  } = {},
) {
  const fixed = ResearchModelContextSchema.parse(context);
  if (
    Object.keys(fixed.product_goals).length !== scope.length ||
    scope.some((p) => !fixed.product_goals[p])
  )
    throw new Error('INVALID_MODEL_CONTEXT');
  const sales = options.template?.id === 'product_sales_scenario';
  const visibleClaims = (admitted: ResearchEvidence[]) => {
    const ids = new Set(admitted.map((e) => e.evidence_id));
    return (options.claims ?? [])
      .filter(
        (c) =>
          c.product_keys.every((p) => scope.includes(p)) &&
          (c.subject_key === null ||
            c.subject_key === fixed.company_identity.credit_code) &&
          c.evidence_ids.length > 0 &&
          c.evidence_ids.every((id) => ids.has(id)) &&
          validateClaim(c, admitted),
      )
      .slice(0, 60);
  };
  const serialize = (admitted: ResearchEvidence[]) => {
    const ids = new Set(admitted.map((e) => e.evidence_id));
    return JSON.stringify({
      model,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: sales
            ? getResearchTemplate(options.template!).systemPrompt(
                options.stage ?? 'collect',
              )
            : COMPANY_RESEARCH_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: JSON.stringify({
            ...fixed,
            subject_key: fixed.company_identity.credit_code,
            product_scope: scope,
            ...(sales
              ? {
                  template: options.template,
                  stage: options.stage ?? 'collect',
                  assessed_at: (options.asOf ?? new Date()).toISOString(),
                  claims: visibleClaims(admitted),
                  questions: scope.map((product) => ({
                    product,
                    ...SALES_SCENARIO_QUESTIONS[product],
                  })),
                }
              : {}),
            materials: admitted,
            gaps: gaps.map((g) => ({
              ...g,
              evidence_ids: g.evidence_ids.filter((id) => ids.has(id)),
            })),
          }),
        },
      ],
    });
  };
  if (Buffer.byteLength(serialize([])) > maxBytes)
    throw new Error('INPUT_TOO_LARGE');
  const admitted: ResearchEvidence[] = [];
  const ids = new Set<string>();
  for (const root of materials) {
    const closure = evidenceDependencyGroup(root, materials);
    if (!closure) continue;
    const next = closure.filter((e) => !ids.has(e.evidence_id));
    const candidate = [...admitted, ...next];
    if (
      candidate.length > 80 ||
      Buffer.byteLength(serialize(candidate)) > maxBytes
    )
      continue;
    admitted.push(...next);
    for (const e of next) ids.add(e.evidence_id);
  }
  return {
    body: serialize(admitted),
    claims: sales ? visibleClaims(admitted) : [],
    materials: admitted,
    omitted:
      materials.length -
      admitted.length +
      (sales
        ? (options.claims?.length ?? 0) - visibleClaims(admitted).length
        : 0),
  };
}
export interface ArkResearchModelOptions {
  url: string;
  credential: string;
  model: string;
  context: ResearchModelContext;
  template?: ResearchTemplateRef;
  requestMaxBytes?: number;
  fetchFn?: typeof fetch;
}
export class ArkResearchModel implements ResearchModel {
  private readonly lifecycle = new AbortController();
  omitted = 0;
  constructor(
    private readonly options: ArkResearchModelOptions,
    private readonly policy: ResearchPolicy,
  ) {}
  async analyze(
    materials: ResearchEvidence[],
    gaps: ResearchGap[],
    scope: ProductKey[],
    signal: AbortSignal,
    stage: ResearchStage = 'collect',
    claims: ResearchClaim[] = [],
  ): Promise<ResearchAnalysis> {
    const packed = packModelRequest(
      this.options.model,
      materials,
      gaps,
      scope,
      this.options.context,
      this.options.requestMaxBytes,
      {
        template: this.options.template,
        stage,
        claims,
        asOf: this.policy.clock.wall(),
      },
    );
    this.omitted += packed.omitted;
    const content = await this.policy.call(
      'ark',
      stage,
      (requestSignal) =>
        requestArkJsonContent({
          url: this.options.url,
          credential: this.options.credential,
          body: packed.body,
          fetchFn: this.options.fetchFn ?? fetch,
          signal: requestSignal,
        }),
      AbortSignal.any([signal, this.lifecycle.signal]),
    );
    const result = parseAnalysis(
      JSON.parse(content),
      packed.materials,
      gaps,
      scope,
      this.options.context.company_identity.credit_code,
      {
        template: this.options.template,
        stage,
        claims: packed.claims,
        asOf: this.policy.clock.wall(),
      },
    );
    this.policy.assertOpen(stage);
    signal.throwIfAborted();
    return result;
  }
  async close() {
    this.lifecycle.abort();
  }
}
