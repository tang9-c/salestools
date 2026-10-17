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
  ): Promise<ResearchAnalysis>;
  close(): Promise<void>;
}
export function parseAnalysis(
  raw: unknown,
  materials: readonly ResearchEvidence[],
  gaps: readonly ResearchGap[],
  scope: readonly ProductKey[],
  companyKey?: string,
): ResearchAnalysis {
  const parsed = CompanyResearchAnalysisSchema.parse(raw);
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
  return result;
}
export function packModelRequest(
  model: string,
  materials: readonly ResearchEvidence[],
  gaps: readonly ResearchGap[],
  scope: readonly ProductKey[],
  context: ResearchModelContext,
  maxBytes = ARK_REQUEST_MAX_BYTES,
) {
  const fixed = ResearchModelContextSchema.parse(context);
  if (
    Object.keys(fixed.product_goals).length !== scope.length ||
    scope.some((p) => !fixed.product_goals[p])
  )
    throw new Error('INVALID_MODEL_CONTEXT');
  const serialize = (admitted: ResearchEvidence[]) => {
    const ids = new Set(admitted.map((e) => e.evidence_id));
    return JSON.stringify({
      model,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: COMPANY_RESEARCH_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            ...fixed,
            subject_key: fixed.company_identity.credit_code,
            product_scope: scope,
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
    materials: admitted,
    omitted: materials.length - admitted.length,
  };
}
export interface ArkResearchModelOptions {
  url: string;
  credential: string;
  model: string;
  context: ResearchModelContext;
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
  ): Promise<ResearchAnalysis> {
    const packed = packModelRequest(
      this.options.model,
      materials,
      gaps,
      scope,
      this.options.context,
      this.options.requestMaxBytes,
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
    );
    this.policy.assertOpen(stage);
    signal.throwIfAborted();
    return result;
  }
  async close() {
    this.lifecycle.abort();
  }
}
