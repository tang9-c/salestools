import {
  DoubaoWebSearchRequestSchema,
  type DoubaoWebSearchRequest,
} from './search-plan.js';
import type { IdentityProfile } from '../../contracts/index.js';

const intents = [
  '官网 新闻 公众号 人物专访 团队 员工故事',
  '会议 论坛 展会 协会 演讲 嘉宾 技术分享',
  '项目 研发 技术文章 论文 专利 成果 获奖',
  '企业活动 员工代表 培训 竞赛 部门 供应商 客户交流',
] as const;

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function buildContactSearchPlan(query: string, regionHint?: string, profile?: IdentityProfile): DoubaoWebSearchRequest[] {
  const normalizedQuery = normalize(query);
  const normalizedRegion = regionHint === undefined ? '' : normalize(regionHint);
  const subject = normalizedRegion.length === 0
    ? normalizedQuery
    : `${normalizedQuery} ${normalizedRegion}`;

  return intents.map((intent, index) => {
    const aliases = profile?.aliases ?? [];
    const alias = aliases.length ? aliases[index % aliases.length] : undefined;
    const withAlias = `${subject}${alias ? ` ${alias}` : ''} ${intent}`;
    return DoubaoWebSearchRequestSchema.parse({
      Query: withAlias.length <= 100 ? withAlias : `${subject} ${intent}`,
      SearchType: 'web',
      Count: 10,
      Filter: { NeedUrl: true, NeedContent: true },
    });
  });
}
