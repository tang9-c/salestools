import { evidenceDependencyGroup } from './evidence.js';
import {
  ResearchRepository,
  ResearchError,
  type ResearchStartResult,
} from './repository.js';
import {
  ProductKeySchema,
  normalizeResearchRequest,
  type ProductKey,
  type ResearchSnapshot,
} from './contracts.js';
export interface CompanyResearchServiceOptions {
  identityLookup: (creditCode: string, legalName: string) => boolean;
}
export class CompanyResearchService {
  constructor(
    readonly repository: ResearchRepository,
    private readonly options: CompanyResearchServiceOptions,
  ) {}
  start(input: unknown, actor: string): ResearchStartResult {
    return this.repository.begin(
      normalizeResearchRequest(input),
      actor,
      this.options.identityLookup,
    );
  }
  read(versionId: string): ResearchSnapshot {
    const version = this.repository.getVersion(versionId);
    if (!version) throw new ResearchError('RESEARCH_VERSION_NOT_FOUND');
    return version.snapshot;
  }
  readProductContext(
    creditCode: string,
    product: ProductKey,
    asOf: string,
    versionId?: string,
  ) {
    ProductKeySchema.parse(product);
    if (!Number.isFinite(Date.parse(asOf)))
      throw new Error('RESEARCH_AS_OF_INVALID');
    const normalizedAsOf = new Date(asOf).toISOString();
    const dossier = this.repository.dossierByCreditCode(creditCode);
    const version = versionId
      ? this.repository.getVersion(versionId)
      : dossier
        ? this.repository.latestProducts(dossier.dossier_id, normalizedAsOf)[
            product
          ]
        : null;
    if (
      versionId &&
      (!version ||
        version.dossier_id !== dossier?.dossier_id ||
        !version.scope.includes(product) ||
        version.created_at > normalizedAsOf)
    )
      throw new ResearchError('RESEARCH_VERSION_CONFLICT');
    if (!version)
      return {
        researched: false as const,
        version_id: null,
        opportunity: null,
      };
    const s = version.snapshot;
    const facts = s.facts.filter((f) => f.product_keys.includes(product));
    const claims = s.claims.filter((c) => c.product_keys.includes(product));
    const gaps = s.gaps.filter((g) => g.product_keys.includes(product));
    const referenced = new Set(
      [...facts, ...claims, ...gaps].flatMap((e) => e.evidence_ids),
    );
    const ids = new Set<string>();
    for (const root of s.evidence.filter(
      (e) => e.product_keys.includes(product) || referenced.has(e.evidence_id),
    )) {
      const closure = evidenceDependencyGroup(root, s.evidence);
      if (!closure) throw new ResearchError('RESEARCH_EVIDENCE_INCOMPLETE');
      for (const e of closure) ids.add(e.evidence_id);
    }
    return {
      researched: true as const,
      version_id: version.version_id,
      template: s.template,
      schema_version: s.schema_version,
      as_of: version.created_at,
      evaluator_version: s.evaluator_version,
      coverage: s.coverage.find((p) => p.product === product)!,
      facts,
      claims,
      gaps,
      opportunity:
        s.product_assessments.find((p) => p.product === product) ?? null,
      evidence: s.evidence.filter((e) => ids.has(e.evidence_id)),
      evidence_checks: s.evidence_checks.filter((c) => ids.has(c.evidence_id)),
    };
  }
}
