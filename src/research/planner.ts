import { SALES_SCENARIO_QUESTIONS } from './templates/product-sales-scenario.js';
import type {
  ProductKey,
  ResearchEvidence,
  ResearchGap,
  ResearchRun,
  ResearchSnapshot,
} from './contracts.js';
import { packEvidenceGroups, sha256 } from './evidence.js';
import {
  COMPANY_RESEARCH_TOPICS,
  type ResearchTopic,
  type ResearchAnalysis,
} from './templates/company-research.js';
export type ProductBaselines = Partial<Record<ProductKey, ResearchSnapshot>>;
export interface PendingResearchItem {
  key: string;
  focus_terms?: string[];
  topic: ResearchTopic;
  product_keys: ProductKey[];
  gap_ids: string[];
  evidence_ids: string[];
  reason:
    | 'missing_background'
    | 'unresolved_gap'
    | 'explicit_goal'
    | 'due_check'
    | 'unknown_date'
    | 'conflict';
}
export const RESEARCH_FOCUS_TERMS = [
  '曲面',
  '模具',
  '钣金',
  '结构',
  '热',
  '振动',
  '疲劳',
  '电磁',
  '高频',
  '天线',
  '射频',
  '流程',
  '变更',
  'BOM',
  '协同',
  '认证',
  '制造',
  '预算',
  '有限元',
  '许可证',
  '仿真',
  '设计',
  '建模',
  '装配',
  '变型',
  '追溯',
  '协作',
  '复杂产品',
  '非线性',
  '材料',
  'EMC',
  '工程图',
  '机械',
] as const;
export function focusForText(text: string): string[] {
  return RESEARCH_FOCUS_TERMS.filter((term) => text.includes(term)).slice(0, 4);
}
export function topicForText(text: string): ResearchTopic {
  if (/招聘|岗位|职位|job|recruit/iu.test(text)) return 'recruitment';
  if (/采购|招标|投标/u.test(text)) return 'procurement';
  if (/质量|体系|认证/u.test(text)) return 'quality';
  if (/项目|project/iu.test(text)) return 'project';
  if (/软件|生态|Creo|CATIA|CST|Abaqus|PLM|QMS|PDM|SolidWorks/iu.test(text))
    return 'software';
  if (/工程|研发|设计/u.test(text)) return 'engineering';
  return 'business';
}
function evidenceTopic(e: ResearchEvidence): ResearchTopic {
  if (e.signal_kind === 'job_requirement') return 'recruitment';
  if (
    ['project_use', 'supplier_project', 'associated_skill'].includes(
      e.signal_kind,
    )
  )
    return 'project';
  if (e.signal_kind === 'direct_use') return 'software';
  return topicForText(`${e.title} ${e.quote}`);
}
export function planResearch(
  run: ResearchRun,
  bases: ProductBaselines,
  existing: readonly ResearchEvidence[],
  now: Date,
): PendingResearchItem[] {
  const items: PendingResearchItem[] = [];
  const add = (
    topic: ResearchTopic,
    products: ProductKey[],
    reason: PendingResearchItem['reason'],
    gaps: string[] = [],
    evidence: string[] = [],
    focus: string[] = [],
  ) => {
    const key = sha256(
      JSON.stringify([topic, products, gaps, evidence, reason, focus]),
    );
    if (!items.some((t) => t.key === key))
      items.push({
        key,
        topic,
        product_keys: products,
        gap_ids: gaps,
        evidence_ids: evidence,
        reason,
        focus_terms: focus,
      });
  };
  const missing = new Map<ResearchTopic, ProductKey[]>();
  for (const product of run.request.product_keys) {
    const base = bases[product];
    const related = [...existing, ...(base?.evidence ?? [])].filter(
      (e) =>
        e.product_keys.includes(product) && e.company_scope === 'confirmed',
    );
    if (run.mode === 'initial' || !base || related.length === 0) {
      for (const topic of [
        'business',
        'engineering',
        'recruitment',
        'software',
      ] as const) {
        const covered = related.some(
          (e) =>
            evidenceTopic(e) === topic ||
            (topic === 'business' &&
              /业务|产品|官网/u.test(`${e.title} ${e.quote}`)) ||
            (topic === 'engineering' &&
              /工程|研发/u.test(`${e.title} ${e.quote}`)),
        );
        if (!covered)
          missing.set(topic, [...(missing.get(topic) ?? []), product]);
      }
    }
    if (run.mode === 'continue')
      for (const gap of base?.gaps ?? []) {
        if (gap.product_keys.includes(product))
          add(
            topicForText(gap.text),
            [product],
            'unresolved_gap',
            [gap.gap_id],
            gap.evidence_ids,
            focusForText(gap.text),
          );
      }
    if (run.mode === 'refresh')
      for (const e of related) {
        const conflict = base?.gaps.some(
          (g) =>
            g.kind === 'conflict' && g.evidence_ids.includes(e.evidence_id),
        );
        const checked = base?.evidence_checks.find(
          (c) => c.evidence_id === e.evidence_id,
        )?.last_checked_at;
        const days = ['recruitment', 'software', 'project'].includes(
          evidenceTopic(e),
        )
          ? 30
          : 180;
        const unknown = e.published_at === null || !checked;
        if (
          conflict ||
          unknown ||
          now.getTime() - Date.parse(checked!) >= days * 86400000
        )
          add(
            evidenceTopic(e),
            [product],
            conflict ? 'conflict' : unknown ? 'unknown_date' : 'due_check',
            [],
            [e.evidence_id],
          );
      }
    if (
      run.request.template?.id === 'product_sales_scenario' &&
      (run.mode === 'initial' || !base || related.length === 0)
    ) {
      const question = SALES_SCENARIO_QUESTIONS[product];
      if (
        !related.some((e) =>
          question.terms.some((term) => e.quote.includes(term)),
        )
      )
        add(
          question.topic,
          [product],
          'missing_background',
          [],
          [],
          [...question.terms],
        );
    }
    const explicitGoal = run.request.client_request.goal;
    const unchangedSalesGoal =
      run.mode === 'continue' &&
      run.request.template?.id === 'product_sales_scenario' &&
      base?.template.id === run.request.template.id &&
      base.template.version === run.request.template.version &&
      base.product_goals[product] === explicitGoal;
    const analysisOnlySalesGoal =
      run.mode === 'continue' &&
      run.request.template?.id === 'product_sales_scenario' &&
      base !== undefined &&
      related.length > 0 &&
      base.gaps.length === 0 &&
      explicitGoal !== undefined &&
      /分析|整理|归纳|评估|探索|解读/u.test(explicitGoal) &&
      !/补查|查询|搜索|更新|最新|近期|核实/u.test(explicitGoal) &&
      focusForText(explicitGoal).every((term) =>
        related.some((e) => e.quote.includes(term)),
      );
    if (explicitGoal && !unchangedSalesGoal && !analysisOnlySalesGoal)
      add(
        topicForText(explicitGoal),
        [product],
        'explicit_goal',
        [],
        [],
        focusForText(explicitGoal),
      );
    if (
      run.mode === 'refresh' &&
      base &&
      !explicitGoal &&
      !items.some((t) => t.product_keys.includes(product))
    )
      add('software', [product], 'explicit_goal');
  }
  for (const [topic, products] of missing)
    add(topic, products, 'missing_background');
  // Actual hiring source work takes QCC priority without changing the search round bounds.
  return items;
}
export function suggestedWork(
  analysis: ResearchAnalysis,
): PendingResearchItem[] {
  return analysis.queries.map((q) => ({
    key: sha256(JSON.stringify([q.topic, q.product_keys, q.gap_id])),
    focus_terms: focusForText(
      analysis.gaps.find((g) => g.gap_id === q.gap_id)?.text ?? '',
    ),
    topic: q.topic,
    product_keys: q.product_keys,
    gap_ids: [q.gap_id],
    evidence_ids:
      analysis.gaps.find((g) => g.gap_id === q.gap_id)?.evidence_ids ?? [],
    reason: 'unresolved_gap',
  }));
}
export function mergeEvidence(
  previous: readonly ResearchEvidence[],
  incoming: readonly ResearchEvidence[],
) {
  const byId = new Map(previous.map((e) => [e.evidence_id, e]));
  let added = 0;
  for (const e of incoming)
    if (!byId.has(e.evidence_id)) {
      byId.set(e.evidence_id, e);
      added++;
    }
  const packed = packEvidenceGroups([...byId.values()]);
  return {
    ...packed,
    added: Math.min(
      added,
      packed.evidence.filter(
        (e) => !previous.some((old) => old.evidence_id === e.evidence_id),
      ).length,
    ),
  };
}
export function workGap(item: PendingResearchItem): ResearchGap {
  return {
    gap_id: `pending:${sha256(item.key)}`,
    kind: 'knowledge',
    text: COMPANY_RESEARCH_TOPICS[item.topic].question,
    product_keys: item.product_keys,
    evidence_ids: item.evidence_ids,
    priority: 'medium',
  };
}
