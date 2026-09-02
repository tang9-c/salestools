import { z } from 'zod';
import type { IdentityProfile } from '../../contracts/index.js';

const SearchFilterSchema = z.object({
  NeedUrl: z.literal(true),
  NeedContent: z.boolean(),
  TimeRange: z.literal('OneYear').optional(),
}).strict();

export const SearchQuerySchema = z.object({
  Query: z.string().trim().min(1).max(100),
  SearchType: z.literal('web'),
  Count: z.number().int().min(1).max(50).default(10),
  Filter: SearchFilterSchema,
  purpose: z.enum([
    'official_products',
    'engineering',
    'quality',
    'software_ecosystem',
    'recruitment',
    'procurement',
    'expansion_financing',
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
  if (!isDynamic && query.Filter.TimeRange !== undefined) {
    context.addIssue({ code: 'custom', message: 'non-dynamic queries must omit TimeRange' });
  }
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

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
    const needsContent = plan.purpose === 'recruitment'
      || plan.purpose === 'engineering'
      || plan.purpose === 'software_ecosystem';
    const needsOneYear = plan.purpose === 'recruitment'
      || plan.purpose === 'procurement'
      || plan.purpose === 'expansion_financing';
    return SearchQuerySchema.parse({
      Query: `${searchedName} ${plan.terms}`,
      SearchType: 'web',
      Count: 10,
      Filter: {
        NeedUrl: true,
        NeedContent: needsContent,
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
