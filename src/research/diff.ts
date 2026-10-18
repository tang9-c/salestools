import type {
  ResearchSnapshot,
  ResearchClaim,
  ProductKey,
} from './contracts.js';
import { sha256 } from './evidence.js';
const semanticKey = (c: ResearchClaim) =>
  c.subject_key && c.predicate && c.object_key
    ? JSON.stringify([
        c.subject_key,
        [...c.product_keys].sort(),
        c.predicate,
        c.object_key,
      ])
    : null;
const analysisRepresentation = (claim: ResearchClaim, scope: ProductKey[]) =>
  JSON.stringify({
    text: claim.text.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
    kind: claim.kind,
    temporal_scope: claim.temporal_scope,
    products: claim.product_keys.filter((p) => scope.includes(p)).sort(),
    evidence_ids: [...claim.evidence_ids].sort(),
    subject: claim.subject_key,
    predicate: claim.predicate,
    object: claim.object_key,
  });
/** Business changes require stable source identity or structured semantics, never prose similarity. */
export function compare(
  base: ResearchSnapshot,
  next: ResearchSnapshot,
): ResearchSnapshot['changes'] {
  const out: ResearchSnapshot['changes'] = {
    business_changes: [],
    method_changes: [],
    analysis_changes: [],
  };
  const add = (
    group: keyof typeof out,
    kind: string,
    key: string,
    description: string,
    products: ProductKey[],
    ids: string[] = [],
  ) => {
    if (products.length && out[group].length < 100)
      out[group].push({
        kind,
        key: sha256(key),
        description,
        product_keys: products,
        evidence_ids: ids,
      });
  };
  const scope = next.product_keys;
  for (const field of [
    'template',
    'method_version',
    'evaluator_version',
  ] as const) {
    const before = base[field];
    if (JSON.stringify(before) !== JSON.stringify(next[field]))
      add('method_changes', field, field, `${field}发生变化`, scope);
  }
  for (const product of scope)
    if (base.product_goals[product] !== next.product_goals[product])
      add('method_changes', 'product_goal', product, '产品研究目标变化', [
        product,
      ]);
  const oldSources = new Map<string, Set<string>>();
  for (const e of base.evidence) {
    const ids = oldSources.get(e.source_key) ?? new Set<string>();
    ids.add(e.evidence_id);
    oldSources.set(e.source_key, ids);
  }
  for (const e of next.evidence) {
    if (base.evidence.some((x) => x.evidence_id === e.evidence_id)) continue;
    const products = e.product_keys.filter((p) => scope.includes(p));
    add(
      'business_changes',
      oldSources.has(e.source_key)
        ? 'source_content_changed'
        : 'evidence_added',
      e.evidence_id,
      e.source_type === 'qcc' && e.locator.record_id.includes('unlocated')
        ? '来源聚合材料变化，无法定位单条记录'
        : '新增或变化的来源材料',
      products,
      [e.evidence_id],
    );
  }
  const oldClaims = new Map(
    base.claims.flatMap((c) => {
      const k = semanticKey({
        ...c,
        product_keys: c.product_keys.filter((p) => scope.includes(p)),
      });
      return k ? [[k, c] as const] : [];
    }),
  );
  for (const c of next.claims) {
    const k = semanticKey(c);
    if (!k) {
      const previous = base.claims.find((old) => old.claim_id === c.claim_id);
      if (
        !previous ||
        analysisRepresentation(previous, scope) !==
          analysisRepresentation(c, scope)
      )
        add(
          'analysis_changes',
          previous ? 'claim_changed' : 'claim_added',
          `analysis:${c.claim_id}`,
          previous ? '未归一结论的分析判断修正' : '新增未归一的分析结论',
          c.product_keys,
          c.evidence_ids,
        );
      continue;
    }
    const old = oldClaims.get(k);
    if (!old || old.kind !== c.kind || old.temporal_scope !== c.temporal_scope)
      add(
        c.evidence_ids.some((id) => {
          const current = next.evidence.find((e) => e.evidence_id === id);
          return (
            current &&
            !base.evidence.some(
              (e) =>
                e.evidence_id === id ||
                (e.source_key === current.source_key &&
                  e.quote === current.quote),
            )
          );
        })
          ? 'business_changes'
          : 'analysis_changes',
        'claim_changed',
        k,
        '结构化结论或时间范围变化',
        c.product_keys,
        c.evidence_ids,
      );
  }
  for (const previous of base.claims) {
    if (
      semanticKey(previous) ||
      next.claims.some((c) => c.claim_id === previous.claim_id)
    )
      continue;
    add(
      'analysis_changes',
      'claim_removed',
      `analysis:${previous.claim_id}`,
      '旧版未归一分析结论不再保留',
      previous.product_keys.filter((p) => scope.includes(p)),
      previous.evidence_ids.filter((id) =>
        next.evidence.some((e) => e.evidence_id === id),
      ),
    );
  }
  for (const p of next.product_assessments) {
    const old = base.product_assessments.find((x) => x.product === p.product);
    if (old && JSON.stringify(old) !== JSON.stringify(p))
      add(
        'analysis_changes',
        'rating_changed',
        p.product,
        '确定性评级或评级依据变化',
        [p.product],
        p.evidenceIds,
      );
  }
  for (const g of next.gaps.filter((g) => g.kind === 'conflict'))
    if (!base.gaps.some((x) => x.gap_id === g.gap_id))
      add(
        'business_changes',
        'conflict_added',
        g.gap_id,
        '新增证据冲突',
        g.product_keys,
        g.evidence_ids,
      );
  for (const product of scope) {
    const old =
      base.template_result.kind === 'product_sales_scenario'
        ? base.template_result.products.find((p) => p.product === product)
        : undefined;
    const current =
      next.template_result.kind === 'product_sales_scenario'
        ? next.template_result.products.find((p) => p.product === product)
        : undefined;
    for (const kind of ['new_purchase', 'replacement', 'complement'] as const) {
      const before = old?.paths.find((p) => p.kind === kind),
        after = current?.paths.find((p) => p.kind === kind);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const ids = new Set([
        ...(after?.supporting_claim_ids ?? []),
        ...(after?.contradicting_claim_ids ?? []),
      ]);
      const evidence = [
        ...new Set(
          next.claims
            .filter((c) => ids.has(c.claim_id))
            .flatMap((c) => c.evidence_ids),
        ),
      ];
      add(
        'analysis_changes',
        after
          ? before
            ? 'sales_path_changed'
            : 'sales_path_added'
          : 'sales_path_removed',
        `scenario:${product}:${kind}`,
        '销售探索路径分析变化',
        [product],
        evidence,
      );
    }
    const metadata = (p: typeof current) =>
      p
        ? JSON.stringify([
            p.scene_claim_ids,
            p.software_claim_ids,
            p.known_blocker_claim_ids,
            p.unknowns,
          ])
        : null;
    if (metadata(old) !== metadata(current))
      add(
        'analysis_changes',
        'sales_context_changed',
        `scenario:${product}:context`,
        '专题场景引用或未知项变化',
        [product],
      );
  }
  return out;
}
