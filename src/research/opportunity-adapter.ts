import type { EvidenceBundle, EvidenceFact } from '../contracts/evidence.js';
import { evaluateOpportunities } from '../opportunity/evaluate-all.js';
import {
  ResearchSnapshotSchema,
  ResearchEvidenceSchema,
  RESEARCH_EVALUATOR_VERSION,
  type ResearchSnapshot,
  type ResearchEvidence,
  type ResearchFact,
  type ResearchGap,
  type ResearchClaim,
} from './contracts.js';
import type { ResearchResultInput } from './runner.js';
import {
  containsPrivateContact,
  packEvidenceGroups,
  evidenceDependencyGroup,
  validateClaim,
  sha256,
  hasUseLimitation,
  normalizeClaimSemantics,
} from './evidence.js';
import { compare } from './diff.js';
import { renderSummary } from './render.js';
/* Keep URL/content provenance separate from the original publisher's scoring weight. */
export function toOpportunityEvidence(
  evidence: ResearchEvidence[],
  facts: ResearchFact[],
  gaps: ResearchGap[],
  legalName: string,
  creditCode: string,
  assessedAt: string,
): EvidenceBundle {
  const originals = new Map<string, ResearchEvidence>();
  const normalized = (text: string) =>
    text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  const references = evidence.map((e) => {
    // Exact recruitment reprints share the first publisher, even at another URL/domain.
    const jobKey =
      e.source_type === 'web' && e.signal_kind === 'job_requirement'
        ? JSON.stringify([
            normalized(e.locator.publisher),
            normalized(e.title),
            normalized(e.quote),
            e.published_at,
          ])
        : e.source_key;
    const original =
      originals.get(e.source_key) ?? originals.get(jobKey) ?? e;
    originals.set(e.source_key, original);
    originals.set(jobKey, original);
    return {
      evidenceId: e.evidence_id,
      title: e.title,
      url: e.url,
      originalPublisher:
        original.source_type === 'web'
          ? original.locator.publisher
          : original.source_key,
      originalDomain:
        original.source_type === 'web' ? new URL(original.url).hostname : null,
      publishedAt: e.published_at ? new Date(e.published_at).toISOString() : null,
      collectedAt: new Date(e.collected_at).toISOString(),
      mentionedName: legalName,
      entityScope: 'legal_entity' as const,
      entityMatch: e.company_scope,
      matchBasis: ['validated_research_source'],
    };
  });
  const mapped: EvidenceFact[] = facts
    .filter((f) => f.kind !== 'other')
    .map((f) => {
      const roots = evidence.filter((e) =>
        f.evidence_ids.includes(e.evidence_id),
      );
      const weak =
        roots.some((e) =>
          ['associated_skill', 'supplier_project'].includes(e.signal_kind),
        ) ||
        gaps.some(
          (g) =>
            g.kind === 'conflict' &&
            g.evidence_ids.some((id) => f.evidence_ids.includes(id)),
        );
      const match = roots.every((e) => e.company_scope === 'confirmed')
        ? 'confirmed'
        : roots.some((e) => e.company_scope === 'unverified')
          ? 'unverified'
          : 'probable';
      return {
        factId: f.fact_id,
        statement: f.text,
        kind: f.kind as EvidenceFact['kind'],
        productTags: f.product_keys,
        strength: weak ? 'weak' : 'direct',
        evidenceIds: f.evidence_ids,
        entityScope: 'legal_entity',
        entityMatch: match,
        matchBasis: ['validated_research_source'],
      };
    });
  return {
    identity: {
      legalName,
      creditCode,
      formerNames: [],
      aliases: [],
      englishNames: [],
      brands: [],
      officialDomains: [],
      registeredAddress: null,
      parentLegalName: null,
      subsidiaryLegalNames: [],
    },
    industryLabel: null,
    industryEvidenceIds: [],
    evidence: references,
    facts: mapped,
    financingRecords: [],
    conflicts: gaps
      .filter((g) => g.kind === 'conflict')
      .map((g) => `来源冲突：${g.text}`),
    gaps: gaps.map((g) => g.text),
    collectedAt: new Date(assessedAt).toISOString(),
  };
}
function factKind(e: ResearchEvidence): ResearchFact['kind'] | null {
  if (e.signal_kind === 'job_requirement') return 'recruitment';
  if (['direct_use', 'project_use'].includes(e.signal_kind))
    return 'software_ecosystem';
  if (['associated_skill', 'supplier_project'].includes(e.signal_kind))
    return 'other';
  if (/采购公告|招标公告|采购意向/u.test(e.quote)) return 'procurement';
  if (/采购预算|预算金额|资金预算/u.test(e.quote)) return 'budget';
  if (/所属行业|行业分类/u.test(e.quote)) return 'industry';
  if (/质量管理|质量体系|质量认证/u.test(e.quote)) return 'quality';
  if (/研发中心|设计团队|多部门|跨部门/u.test(e.quote)) return 'organization';
  if (/产线|车间|扩产|制造基地/u.test(e.quote)) return 'manufacturing';
  if (/主营|生产|研发|制造|工程场景|产品设计/u.test(e.quote))
    return 'product_scene';
  return null;
}
/** Current assertions require current source wording and explicit, nonfuture validity. */
function supportsCurrent(e: ResearchEvidence, assessedAt: string): boolean {
  return Boolean(
    e.published_at &&
    e.valid_from &&
    !e.valid_to &&
    Date.parse(e.published_at) <= Date.parse(assessedAt) &&
    Date.parse(e.valid_from) <= Date.parse(assessedAt) &&
    new Date(e.published_at).toISOString().slice(0, 10) ===
      new Date(assessedAt).toISOString().slice(0, 10) &&
    /目前|当前|现正/u.test(e.quote),
  );
}
/** Pure, bounded local result assembly; no source reads and no fabricated timestamps. */
export function buildResult(
  input: ResearchResultInput,
): ResearchSnapshot | null {
  const scope = input.scope;
  const safe = (text: string) => !containsPrivateContact(text);
  const candidate = input.evidence.filter(
    (e) =>
      ResearchEvidenceSchema.safeParse(e).success &&
      safe(e.quote) &&
      safe(e.title),
  );
  const packed = packEvidenceGroups(candidate);
  let evidence = packed.evidence;
  const retained = new Set(evidence.map((e) => e.evidence_id));
  const validEntity = (e: {
    product_keys: ResearchFact['product_keys'];
    evidence_ids: string[];
    text: string;
  }) =>
    safe(e.text) &&
    e.product_keys.every((p) => scope.includes(p)) &&
    e.evidence_ids.every((id) => retained.has(id));
  const inheritedFacts = Object.values(input.baselines).flatMap(
    (base) => base?.facts ?? [],
  );
  const inheritedClaims = Object.values(input.baselines).flatMap(
    (base) => base?.claims ?? [],
  );
  const literalSupport = (entity: { text: string; evidence_ids: string[] }) =>
    entity.evidence_ids.some((id) =>
      evidence.find((e) => e.evidence_id === id)?.quote.includes(entity.text),
    );
  const meaningful = (entity: { evidence_ids: string[] }) =>
    entity.evidence_ids.some((id) => {
      const source = evidence.find((e) => e.evidence_id === id);
      return (
        source &&
        source.company_scope !== 'unverified' &&
        factKind(source) !== null
      );
    });
  const sameReferences = (
    left: { evidence_ids: string[] },
    right: { evidence_ids: string[] },
  ) =>
    left.evidence_ids.length === right.evidence_ids.length &&
    left.evidence_ids.every((id) => right.evidence_ids.includes(id));
  const inheritedFact = (f: ResearchFact) =>
    inheritedFacts.some(
      (old) =>
        old.fact_id === f.fact_id &&
        old.text === f.text &&
        old.kind === f.kind &&
        sameReferences(old, f),
    );
  const inheritedClaim = (c: ResearchClaim) =>
    inheritedClaims.some(
      (old) =>
        old.claim_id === c.claim_id &&
        old.text === c.text &&
        old.kind === c.kind &&
        old.temporal_scope === c.temporal_scope &&
        old.subject_key === c.subject_key &&
        old.predicate === c.predicate &&
        old.object_key === c.object_key &&
        sameReferences(old, c),
    );
  let facts = input.facts.filter(
    (f) =>
      validEntity(f) &&
      f.evidence_ids.length > 0 &&
      (inheritedFact(f) || (meaningful(f) && literalSupport(f))),
  );
  let claims = input.claims
    .map((c) => normalizeClaimSemantics(c, evidence, input.dossier.credit_code))
    .filter(
      (c) =>
        validEntity(c) &&
        (c.temporal_scope !== 'current_supported' ||
          inheritedClaim(c) ||
          c.evidence_ids.every((id) => {
            const source = evidence.find((e) => e.evidence_id === id);
            return source && supportsCurrent(source, input.assessed_at);
          })) &&
        (inheritedClaim(c) ||
          (meaningful(c) &&
            (c.kind === 'unknown' ||
              c.kind === 'hypothesis' ||
              literalSupport(c)))) &&
        validateClaim(c, evidence, {
          conflict_evidence_ids: input.conflict_evidence_ids,
        }),
    );
  let gaps = input.gaps.filter(validEntity);
  const addGap = (
    kind: ResearchGap['kind'],
    key: string,
    text: string,
    products = scope,
    ids: string[] = [],
  ) => {
    if (!products.length) return;
    const gap_id = sha256(`${kind}:${key}`);
    if (!gaps.some((g) => g.gap_id === gap_id))
      gaps.push({
        gap_id,
        kind,
        text: safe(text) ? text : '来源处理未完成',
        product_keys: products,
        evidence_ids: ids,
        priority: 'high',
      });
  };
  if (facts.length < input.facts.length || claims.length < input.claims.length)
    addGap(
      'technical',
      'unsupported_entities',
      '部分事实或结论因引用不完整或原文不支持而省略',
    );
  for (const e of evidence) {
    const products = e.product_keys.filter((p) => scope.includes(p)),
      kind = factKind(e);
    if (!kind || !products.length || e.company_scope === 'unverified') continue;
    if (
      !facts.some(
        (f) => f.evidence_ids.includes(e.evidence_id) && f.kind === kind,
      )
    )
      facts.push({
        fact_id: sha256(`fact:${e.evidence_id}:${kind}`),
        kind,
        text: e.quote,
        product_keys: products,
        evidence_ids: [e.evidence_id],
      });
    const conflict = (evidenceDependencyGroup(e, evidence) ?? []).some((x) =>
      input.conflict_evidence_ids.includes(x.evidence_id),
    );
    if (conflict)
      addGap(
        'conflict',
        e.evidence_id,
        '来源存在冲突，软件使用归属待核实',
        products,
        [e.evidence_id],
      );
    if (['associated_skill', 'supplier_project'].includes(e.signal_kind)) {
      for (const product of products) {
        const c: ResearchClaim = {
          claim_id: sha256(`clue:${e.evidence_id}:${product}`),
          kind: 'hypothesis',
          text: `待核实线索：${e.quote}`,
          product_keys: [product],
          evidence_ids: [e.evidence_id],
          temporal_scope: e.published_at ? 'historical' : 'unknown',
          subject_key: input.dossier.credit_code,
          predicate: 'associated_clue',
          object_key: product,
        };
        if (validateClaim(c, evidence)) claims.push(c);
      }
      addGap(
        'knowledge',
        `attribution:${e.evidence_id}`,
        '关联线索不能确认目标企业部署',
        products,
        [e.evidence_id],
      );
    } else if (
      ['direct_use', 'project_use'].includes(e.signal_kind) &&
      e.company_scope === 'confirmed' &&
      !conflict &&
      !hasUseLimitation(e.quote)
    ) {
      for (const product of products) {
        const c: ResearchClaim = {
          claim_id: sha256(`use:${e.evidence_id}:${product}`),
          kind: 'supported',
          text: e.quote,
          product_keys: [product],
          evidence_ids: [e.evidence_id],
          temporal_scope: supportsCurrent(e, input.assessed_at)
            ? 'current_supported'
            : e.published_at
              ? 'historical'
              : 'unknown',
          subject_key: input.dossier.credit_code,
          predicate: 'uses',
          object_key: product,
        };
        if (validateClaim(c, evidence)) claims.push(c);
      }
    }
  }
  if (
    !facts.length &&
    !claims.some((c) => c.kind !== 'unknown' && c.evidence_ids.length)
  )
    return null;
  for (const warning of input.warnings)
    addGap('technical', warning, `处理警告：${warning}`);
  for (const status of input.source_status)
    if (
      ['failed', 'unavailable', 'partial'].includes(status.status) ||
      (status.omitted ?? 0) > 0
    )
      addGap(
        'technical',
        `source:${status.source}`,
        `${status.source}来源处理未完成`,
      );
  for (const work of input.pending_work)
    addGap(
      'technical',
      `pending:${work.key}`,
      `待查事项尚未完成`,
      work.product_keys,
    );
  if (input.stop_reason === 'TIME_BUDGET_EXHAUSTED')
    addGap('technical', 'timeout', '时间预算耗尽，部分处理尚未完成');
  if (packed.omitted || candidate.length < input.evidence.length)
    addGap('technical', 'omitted', '部分证据因容量、隐私或依赖不完整而省略');
  if (facts.length > 80 || claims.length > 60)
    addGap('technical', 'entities_omitted', '事实或结论因容量限制省略');
  facts = facts.slice(0, 80);
  claims = [...new Map(claims.map((c) => [c.claim_id, c])).values()].slice(
    0,
    60,
  );
  if (gaps.length > 99) {
    gaps = gaps.slice(0, 98);
    addGap('technical', 'gaps_omitted', '部分缺口因容量限制省略');
  }
  const s: ResearchSnapshot = {
    schema_version: 1,
    template: input.run.request.template,
    method_version: input.run.request.method_version,
    evaluator_version: RESEARCH_EVALUATOR_VERSION,
    dossier_id: input.dossier.dossier_id,
    run_id: input.run.run_id,
    credit_code: input.dossier.credit_code,
    legal_name: input.dossier.legal_name,
    effective_goal: input.run.request.effective_goal,
    product_keys: scope,
    product_goals: input.run.request.product_goals,
    parent_version_id: input.run.base_version_id,
    evidence_base_version_ids: [
      ...new Set(
        Object.values(input.run.request.product_base_versions).filter(
          (v): v is string => !!v,
        ),
      ),
    ],
    template_result: { kind: 'company_research' },
    summary: '研究结果',
    evidence,
    facts,
    claims,
    gaps,
    product_assessments: [],
    coverage: [],
    changes: { business_changes: [], method_changes: [], analysis_changes: [] },
    source_status: input.source_status,
    budget_usage: input.budget_usage,
    evidence_checks: input.evidence_checks.filter((c) =>
      retained.has(c.evidence_id),
    ),
  };
  const derive = () => {
    s.coverage = scope.map((product) => {
      const relevant = s.gaps.filter((g) => g.product_keys.includes(product));
      return {
        product,
        scope_complete: !relevant.some((g) => g.kind !== 'knowledge'),
        technical_gap_ids: relevant
          .filter((g) => g.kind === 'technical')
          .map((g) => g.gap_id),
        knowledge_gap_ids: relevant
          .filter((g) => g.kind === 'knowledge')
          .map((g) => g.gap_id),
        blocking_conflict_ids: relevant
          .filter((g) => g.kind === 'conflict')
          .map((g) => g.gap_id),
      };
    });
    const bundle = toOpportunityEvidence(
      s.evidence,
      s.facts,
      s.gaps,
      s.legal_name,
      s.credit_code,
      input.assessed_at,
    );
    s.product_assessments = evaluateOpportunities(
      bundle,
      new Date(input.assessed_at),
    ).products.filter((p) => scope.includes(p.product));
    s.changes = {
      business_changes: [],
      method_changes: [],
      analysis_changes: [],
    };
    const seen = new Set<ResearchSnapshot>();
    for (const product of scope) {
      const base = input.baselines[product];
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const delta = compare(base, s);
      for (const key of Object.keys(delta) as (keyof typeof delta)[])
        s.changes[key].push(
          ...delta[key]
            .filter((c) =>
              c.product_keys.some(
                (p) => scope.includes(p) && input.baselines[p] === base,
              ),
            )
            .map((c) => ({
              ...c,
              product_keys: c.product_keys.filter(
                (p) => scope.includes(p) && input.baselines[p] === base,
              ),
            }))
            .slice(0, 100 - s.changes[key].length),
        );
    }
    s.summary = renderSummary(s);
  };
  derive();
  // Actual serialized byte limit includes metadata, reports and references. Remove a root and all dependants together.
  while (
    Buffer.byteLength(JSON.stringify(s), 'utf8') > 2 * 1024 * 1024 &&
    s.evidence.length
  ) {
    const removed = new Set([s.evidence.at(-1)!.evidence_id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of s.evidence)
        if (
          !removed.has(e.evidence_id) &&
          e.required_evidence_ids.some((id) => removed.has(id))
        ) {
          removed.add(e.evidence_id);
          changed = true;
        }
    }
    s.evidence = s.evidence.filter((e) => !removed.has(e.evidence_id));
    s.facts = s.facts.filter((f) =>
      f.evidence_ids.every((id) => !removed.has(id)),
    );
    s.claims = s.claims.filter((c) =>
      c.evidence_ids.every((id) => !removed.has(id)),
    );
    s.gaps = s.gaps.filter((g) =>
      g.evidence_ids.every((id) => !removed.has(id)),
    );
    s.evidence_checks = s.evidence_checks.filter(
      (c) => !removed.has(c.evidence_id),
    );
    gaps = s.gaps;
    addGap(
      'technical',
      'snapshot_trimmed',
      '版本容量限制导致证据及其依赖结论省略',
    );
    s.gaps = gaps;
    derive();
  }
  if (
    !s.facts.length &&
    !s.claims.some((c) => c.kind !== 'unknown' && c.evidence_ids.length)
  )
    return null;
  return ResearchSnapshotSchema.parse(s);
}
