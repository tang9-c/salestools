import { z } from 'zod';
import type { IdentityProfile } from '../../contracts/index.js';

export const SearchFilterSchema = z.object({
  NeedUrl: z.literal(true),
  NeedContent: z.boolean(),
  TimeRange: z.literal('OneYear').optional(),
}).strict();

export const DoubaoWebSearchRequestSchema = z.object({
  Query: z.string().trim().min(1).max(100),
  SearchType: z.literal('web'),
  Count: z.number().int().min(1).max(50).default(10),
  Filter: SearchFilterSchema,
}).strict();

export const SearchQuerySchema = DoubaoWebSearchRequestSchema.extend({
  purpose: z.enum([
    'official_products',
    'engineering',
    'quality',
    'software_ecosystem',
    'recruitment',
    'procurement',
    'expansion_financing',
    'question',
  ]),
  subjectLegalName: z.string().min(1),
  subjectAliases: z.array(z.string().min(1)),
  subjectOfficialDomains: z.array(z.string().min(1)),
  subjectRegisteredAddress: z.string().min(1).nullable(),
  searchedName: z.string().min(1),
}).strict().superRefine((query, context) => {
  const isRecruitment = query.purpose === 'recruitment';
  const isDynamic = isRecruitment
    || query.purpose === 'procurement'
    || query.purpose === 'expansion_financing';
  if (isRecruitment && (!query.Filter.NeedContent || query.Filter.TimeRange !== 'OneYear')) {
    context.addIssue({ code: 'custom', message: 'recruitment queries require content and OneYear' });
  }
  if (isDynamic && query.Filter.TimeRange !== 'OneYear') {
    context.addIssue({ code: 'custom', message: 'dynamic queries require OneYear' });
  }
  if (!isDynamic && query.purpose !== 'question' && query.Filter.TimeRange !== undefined) {
    context.addIssue({ code: 'custom', message: 'non-dynamic queries must omit TimeRange' });
  }
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type DoubaoWebSearchRequest = z.infer<typeof DoubaoWebSearchRequestSchema>;
export type QuestionTopic = 'products' | 'recruitment' | 'expansion' | 'procurement';

export function questionTopics(question: string): QuestionTopic[] {
  const topicText = question.replace(/产品经理/gu, '');
  return ([
    ['products', /(?:产品|新品|新机型)/u],
    ['recruitment', /(?:招聘|岗位|职位|JD)/iu],
    ['expansion', /(?:融资|扩产|产能|扩张|新工厂)/u],
    ['procurement', /(?:采购公告|招标|招投标|中标|采购项目)/u],
  ] as const).flatMap(([topic, pattern]) => pattern.test(topicText) ? [topic] : []);
}

const plans = [
  { purpose: 'official_products', terms: '官网 产品 技术' },
  { purpose: 'engineering', terms: '研发 工程 中心' },
  { purpose: 'quality', terms: '质量 体系 认证' },
  { purpose: 'software_ecosystem', terms: 'PLM QMS PDM' },
  { purpose: 'recruitment', terms: '招聘 Creo CATIA SolidWorks CAD PDM' },
  { purpose: 'recruitment', terms: '招聘 Abaqus CST CAE 有限元 电磁仿真' },
  { purpose: 'procurement', terms: '招投标 数字化 采购' },
  { purpose: 'expansion_financing', terms: '扩产 融资' },
] as const;

function normalizedNames(identity: IdentityProfile): string[] {
  return [identity.legalName, ...identity.aliases]
    .map(name => name.normalize('NFKC').trim())
    .filter((name, index, values) => name.length > 0 && values.indexOf(name) === index);
}

function selectSearchName(identity: IdentityProfile): string {
  const candidates = normalizedNames(identity);
  const selected = candidates.find(name => plans.every(plan => `${name} ${plan.terms}`.length <= 100));
  if (selected === undefined) throw new Error('No confirmed legal name or alias fits the search query limit');
  return selected;
}

export function buildSearchPlan(identity: IdentityProfile): SearchQuery[] {
  const searchedName = selectSearchName(identity);
  const aliases = normalizedNames(identity).filter(name => name !== identity.legalName.normalize('NFKC').trim());

  return plans.map(plan => {
    const needsOneYear = plan.purpose === 'recruitment'
      || plan.purpose === 'procurement'
      || plan.purpose === 'expansion_financing';
    return SearchQuerySchema.parse({
      Query: `${searchedName} ${plan.terms}`,
      SearchType: 'web',
      Count: 10,
      Filter: {
        NeedUrl: true,
        NeedContent: true,
        ...(needsOneYear ? { TimeRange: 'OneYear' as const } : {}),
      },
      purpose: plan.purpose,
      subjectLegalName: identity.legalName,
      subjectAliases: aliases,
      subjectOfficialDomains: [...identity.officialDomains],
      subjectRegisteredAddress: identity.registeredAddress,
      searchedName,
    });
  });
}

export function buildQuestionSearchPlan(
  identity: IdentityProfile, question: string, qccCovered?: QuestionTopic,
): SearchQuery[] {
  const names = normalizedNames(identity);
  const searchedName = names.find(name => name.length < 80);
  if (searchedName === undefined) return [];
  const dynamic = /(?:最新|近期|最近|目前|当前|趋势|近一年|今年|发布|招聘|融资|扩产|招标|采购)/u.test(question);
  const purpose: SearchQuery['purpose'] = /(?:招聘|岗位|职位)/u.test(question) ? 'recruitment'
    : /(?:融资|扩产)/u.test(question) ? 'expansion_financing'
      : /(?:招标|采购)/u.test(question) ? 'procurement' : 'question';
  const aliases = names.filter(name => name !== identity.legalName.normalize('NFKC').trim());
  const topics = questionTopics(question);
  const selectedTopics = (topics.length > 2 && qccCovered !== undefined
    ? topics.filter(topic => topic !== qccCovered) : topics).slice(0, 2);
  const terms: Record<QuestionTopic, string> = {
    products: '产品 新品 发布 官网', recruitment: '招聘 岗位 工程师',
    expansion: '融资 扩产 产能', procurement: '采购公告 招标 数字化',
  };
  const topicPurpose: Record<QuestionTopic, SearchQuery['purpose']> = {
    products: 'question', recruitment: 'recruitment',
    expansion: 'expansion_financing', procurement: 'procurement',
  };
  const planned = selectedTopics.length === 0
    ? [question.normalize('NFKC').trim(), `${question.normalize('NFKC').trim()} 官网`]
      .map(text => ({ text, purpose }))
    : selectedTopics.length === 1
      ? [{ text: terms[selectedTopics[0]!], purpose: topicPurpose[selectedTopics[0]!] },
        { text: question.normalize('NFKC').trim(), purpose: topicPurpose[selectedTopics[0]!] }]
      : selectedTopics.map(topic => ({ text: terms[topic], purpose: topicPurpose[topic] }));
  const uniqueQueries = [...new Map(planned.map(entry => {
    const query = `${searchedName} ${entry.text.slice(0, Math.max(1, 100 - searchedName.length - 1))}`.slice(0, 100);
    return [query, { query, purpose: entry.purpose }] as const;
  })).values()];
  return uniqueQueries.map(entry => SearchQuerySchema.parse({
    Query: entry.query,
    SearchType: 'web', Count: 10,
    Filter: { NeedUrl: true, NeedContent: true, ...(dynamic || entry.purpose === 'recruitment' ? { TimeRange: 'OneYear' as const } : {}) },
    purpose: entry.purpose,
    subjectLegalName: identity.legalName, subjectAliases: aliases,
    subjectOfficialDomains: [...identity.officialDomains],
    subjectRegisteredAddress: identity.registeredAddress, searchedName,
  }));
}
