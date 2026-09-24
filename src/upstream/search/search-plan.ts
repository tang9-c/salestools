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

export function buildQuestionSearchPlan(identity: IdentityProfile, question: string): SearchQuery[] {
  const names = normalizedNames(identity);
  const searchedName = names.find(name => name.length < 80);
  if (searchedName === undefined) return [];
  const dynamic = /(?:最新|近期|最近|目前|当前|趋势|近一年|今年|发布|招聘|融资|扩产|招标|采购)/u.test(question);
  const purpose: SearchQuery['purpose'] = /(?:招聘|岗位|职位)/u.test(question) ? 'recruitment'
    : /(?:融资|扩产)/u.test(question) ? 'expansion_financing'
      : /(?:招标|采购)/u.test(question) ? 'procurement' : 'question';
  const aliases = names.filter(name => name !== identity.legalName.normalize('NFKC').trim());
  const suffixes = [question.normalize('NFKC').trim(), `${question.normalize('NFKC').trim()} 官网`];
  const uniqueQueries = [...new Set(suffixes.map(suffix =>
    `${searchedName} ${suffix.slice(0, Math.max(1, 100 - searchedName.length - 1))}`.slice(0, 100)))];
  return uniqueQueries.map(query => SearchQuerySchema.parse({
    Query: query,
    SearchType: 'web', Count: 10,
    Filter: { NeedUrl: true, NeedContent: true, ...(dynamic || purpose === 'recruitment' ? { TimeRange: 'OneYear' as const } : {}) },
    purpose,
    subjectLegalName: identity.legalName, subjectAliases: aliases,
    subjectOfficialDomains: [...identity.officialDomains],
    subjectRegisteredAddress: identity.registeredAddress, searchedName,
  }));
}
