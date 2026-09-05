import {
  DoubaoWebSearchRequestSchema,
  type DoubaoWebSearchRequest,
} from './search-plan.js';

const intents = [
  '官网 官方新闻 公众号 会议 嘉宾 董事长 总经理',
  '招投标 专利 研发 技术 信息化 数字化 采购 质量 负责人',
] as const;

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function buildContactSearchPlan(query: string, regionHint?: string): DoubaoWebSearchRequest[] {
  const normalizedQuery = normalize(query);
  const normalizedRegion = regionHint === undefined ? '' : normalize(regionHint);
  const subject = normalizedRegion.length === 0
    ? normalizedQuery
    : `${normalizedQuery} ${normalizedRegion}`;

  return intents.map(intent => DoubaoWebSearchRequestSchema.parse({
    Query: `${subject} ${intent}`,
    SearchType: 'web',
    Count: 10,
    Filter: { NeedUrl: true, NeedContent: true },
  }));
}
