import type {
  ResearchSnapshot,
  ProductKey,
  ResearchEvidence,
} from './contracts.js';
import { containsPrivateContact, evidenceDependencyGroup } from './evidence.js';
/** First-screen budget; full excerpts remain in fixed-version evidence pagination. */
export function renderSummary(s: ResearchSnapshot): string {
  const excerpt = (value: string, limit: number) => {
    const text = containsPrivateContact(value)
      ? '敏感内容已省略'
      : value.replace(/\s+/gu, ' ').trim();
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  };
  const refs = (ids: string[]) =>
    ids.length ? ` [${ids.slice(0, 1).join(',')}]` : '';
  const sections = [
    `企业研究：${excerpt(s.legal_name, 100)}`,
    `研究范围：${s.product_keys.join('、')}`,
    '产品机会',
    ...s.product_assessments.map(
      (p) =>
        `${p.product}：${p.level}；置信度${p.confidence}；${excerpt(p.reasons.join('；'), 100)}${refs(p.evidenceIds)}`,
    ),
    '范围与缺口',
    ...s.coverage.map(
      (p) =>
        `${p.product}：${p.scope_complete ? '处理范围已完成' : '处理范围未完成'}`,
    ),
  ];
  const rank = (g: ResearchSnapshot['gaps'][number]) =>
    (g.kind === 'conflict' ? 0 : g.kind === 'technical' ? 1 : 2) * 3 +
    (g.priority === 'high' ? 0 : g.priority === 'medium' ? 1 : 2);
  const gaps = [...s.gaps].sort((a, b) => rank(a) - rank(b));
  sections.push(
    ...gaps.slice(0, 3).map(
      (g) => `${g.kind}：${excerpt(g.text, 140)}${refs(g.evidence_ids)}`,
    ),
  );
  if (gaps.length > 3)
    sections.push(`另有${gaps.length - 3}项缺口，见固定版本结构化结果。`);
  sections.push('软件判断与事实摘录');
  const details = [
    ...s.claims.slice(0, 2).map(
      (c) =>
        `${c.kind}/${c.temporal_scope}：${excerpt(c.text, 140)}${refs(c.evidence_ids)}`,
    ),
    ...s.facts.slice(0, 2).map(
      (f) => `${excerpt(f.text, 140)}${refs(f.evidence_ids)}`,
    ),
    ...Object.values(s.changes)
      .flat()
      .slice(0, 2)
      .map((c) => `版本变化：${excerpt(c.description, 100)}`),
  ];
  const footer = '完整事实、原文及其余引用请按固定版本分页读取证据。';
  let result = sections.join('\n');
  for (const line of details) {
    if (result.length + line.length + footer.length + 2 > 4000) break;
    result += `\n${line}`;
  }
  return `${result}\n${footer}`;
}
export interface EvidenceFilter {
  claim_id?: string;
  product?: ProductKey;
}
export function selectEvidence(
  version: { version_id: string; snapshot: ResearchSnapshot },
  filter: EvidenceFilter = {},
  page: { offset?: number; limit?: number } = {},
) {
  if (filter.claim_id && filter.product)
    throw new Error('RESEARCH_EVIDENCE_FILTER_CONFLICT');
  const offset = page.offset ?? 0,
    limit = page.limit ?? 10;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error('RESEARCH_PAGE_INVALID');
  const s = version.snapshot;
  let roots: ResearchEvidence[] = s.evidence;
  if (filter.claim_id) {
    const c = s.claims.find((c) => c.claim_id === filter.claim_id);
    if (!c) throw new Error('RESEARCH_CLAIM_NOT_FOUND');
    roots = s.evidence.filter((e) => c.evidence_ids.includes(e.evidence_id));
  }
  if (filter.product) {
    const referenced = new Set(
      [...s.facts, ...s.claims, ...s.gaps]
        .filter((item) => item.product_keys.includes(filter.product!))
        .flatMap((item) => item.evidence_ids),
    );
    roots = s.evidence.filter(
      (e) =>
        e.product_keys.includes(filter.product!) ||
        referenced.has(e.evidence_id),
    );
  }
  const selected = new Map<string, ResearchEvidence>();
  for (const root of roots) {
    const closure = evidenceDependencyGroup(root, s.evidence);
    if (!closure) throw new Error('RESEARCH_EVIDENCE_INCOMPLETE');
    for (const e of closure) selected.set(e.evidence_id, e);
  }
  const items = [...selected.values()].sort((a, b) =>
    a.evidence_id.localeCompare(b.evidence_id),
  );
  return {
    version_id: version.version_id,
    items: structuredClone(items.slice(offset, offset + limit)),
    total: items.length,
    next_offset: offset + limit < items.length ? offset + limit : null,
  };
}
