import { z } from 'zod';
import {
  BasicProfileSchema,
  IdentityProfileSchema,
  ResearchItemSchema,
  type BasicProfile,
  type IdentityProfile,
  type ResearchItem,
} from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import type { QccServer } from './tool-allowlist.js';

const RawRootSchema = z.object({ Data: z.unknown() }).passthrough();
const RawRecordSchema = z.record(z.string(), z.unknown());

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const OptionalStringSchema = z.string().nullable().optional();
const OptionalNumberSchema = z.number().nullable().optional();
const OptionalUrlSchema = OptionalStringSchema;
const OptionalDateSchema = OptionalStringSchema.refine(
  value => value == null || !nonBlank(value) || dateTimestamp(value) !== null,
);

const FormalProfileRecordSchema = z.object({
  Name: OptionalStringSchema,
  Industry: OptionalStringSchema,
  Introduction: OptionalStringSchema,
  EmployeeRange: OptionalStringSchema,
  Website: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => [record.Name, record.Industry, record.Introduction].some(nonBlank));

const FinancingRecordSchema = z.object({
  Date: OptionalDateSchema,
  Round: OptionalStringSchema,
  Type: OptionalStringSchema,
  Amount: OptionalStringSchema,
  Investors: z.array(z.string()).optional(),
  Url: OptionalUrlSchema,
}).passthrough().refine(record => [record.Date, record.Round, record.Type, record.Amount].some(nonBlank)
  || (record.Investors?.some(nonBlank) ?? false));

const RecruitmentRecordSchema = z.object({
  PublishDate: OptionalDateSchema,
  JobName: OptionalStringSchema,
  Salary: OptionalStringSchema,
  Education: OptionalStringSchema,
  Experience: OptionalStringSchema,
  Location: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.JobName) || nonBlank(record.PublishDate));

const RiskRecordSchema = z.object({
  RiskCount: OptionalNumberSchema,
  ExceptionCount: OptionalNumberSchema,
  PenaltyCount: OptionalNumberSchema,
  JudicialCount: OptionalNumberSchema,
  Summary: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => [
  record.RiskCount, record.ExceptionCount, record.PenaltyCount, record.JudicialCount, record.Summary,
].some(value => typeof value === 'number' || nonBlank(value)));

const PatentRecordSchema = z.object({
  PatentName: OptionalStringSchema,
  PatentType: OptionalStringSchema,
  ApplicationNumber: OptionalStringSchema,
  ApplicationDate: OptionalDateSchema,
  Status: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.PatentName) || nonBlank(record.ApplicationNumber));

const AnnualReportRecordSchema = z.object({
  Year: z.string().trim().regex(/^\d{4}$/).nullable().optional(),
  EmployeeCount: OptionalNumberSchema,
  TotalAssets: OptionalStringSchema,
  Revenue: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.Year));

const BiddingRecordSchema = z.object({
  Title: OptionalStringSchema,
  PublishDate: OptionalDateSchema,
  Role: OptionalStringSchema,
  Amount: OptionalStringSchema,
  Purchaser: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.Title) || nonBlank(record.PublishDate));

const ShareholderRecordSchema = z.object({
  ShareholderName: OptionalStringSchema,
  ShareholdingRatio: OptionalStringSchema,
  SubscribedCapital: OptionalStringSchema,
  ShareholderType: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.ShareholderName));

const SoftwareCopyrightRecordSchema = z.object({
  SoftwareName: OptionalStringSchema,
  ShortName: OptionalStringSchema,
  RegistrationNumber: OptionalStringSchema,
  RegistrationDate: OptionalDateSchema,
  Version: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.SoftwareName) || nonBlank(record.RegistrationNumber));

const QualificationRecordSchema = z.object({
  QualificationName: OptionalStringSchema,
  CertificateNumber: OptionalStringSchema,
  IssuedAt: OptionalDateSchema,
  ExpiresAt: OptionalDateSchema,
  Issuer: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => nonBlank(record.QualificationName) || nonBlank(record.CertificateNumber));

export interface MappedCandidate {
  legalName: string;
  creditCode: string;
  status: string | null;
  registeredAddress: string | null;
  matchReason: string;
}

export interface MappedQccResult {
  items: ResearchItem[];
  gaps: string[];
}

export interface MappedCompanyDetails {
  identity: IdentityProfile;
  basicProfile: BasicProfile;
}

function invalidResponse(message: string, cause?: unknown): UpstreamError {
  return new UpstreamError('qcc', 'INVALID_RESPONSE', message, cause === undefined ? undefined : { cause });
}

function unwrapPayload(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'structuredContent' in payload) {
    return (payload as { structuredContent?: unknown }).structuredContent;
  }
  if (typeof payload === 'object' && payload !== null && 'content' in payload) {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content.find(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text');
      if (text !== undefined) {
        try {
          return JSON.parse(String((text as { text?: unknown }).text));
        } catch (error) {
          throw invalidResponse('QCC text result is not valid JSON', error);
        }
      }
    }
  }
  return payload;
}

function dataOf(payload: unknown): unknown {
  const unwrapped = unwrapPayload(payload);
  const parsed = RawRootSchema.safeParse(unwrapped);
  if (parsed.success) return parsed.data.Data;
  if (RawRecordSchema.safeParse(unwrapped).success) return unwrapped;
  throw invalidResponse('QCC result does not contain an object payload');
}

function recordsOf(payload: unknown): Record<string, unknown>[] {
  const data = dataOf(payload);
  if (data === null || data === undefined) return [];
  const values = Array.isArray(data) ? data : [data];
  const parsed = z.array(RawRecordSchema).safeParse(values);
  if (!parsed.success) throw invalidResponse('QCC Data has an unsupported shape');
  return parsed.data;
}

export function validateQccPayload(payload: unknown): unknown {
  const unwrapped = unwrapPayload(payload);
  if (RawRootSchema.safeParse(unwrapped).success) {
    recordsOf(payload);
    return payload;
  }
  const chinese = RawRecordSchema.safeParse(unwrapped);
  if (!chinese.success || (!Object.hasOwn(chinese.data, '企业名称') && !Object.hasOwn(chinese.data, '企业信息'))) {
    throw invalidResponse('QCC result has an unsupported shape');
  }
  return payload;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringValueFrom(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record, key);
    if (value !== null) return value;
  }
  return null;
}

function stringValuesFrom(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const values = stringArray(record, key);
    if (values.length > 0) return values;
    const value = stringValue(record, key);
    if (value !== null) return [value];
  }
  return [];
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
}

function numberValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const normalized = dateOnly ? `${value}T00:00:00.000Z` : value;
  try {
    const timestamp = new Date(normalized).toISOString();
    return dateOnly && timestamp.slice(0, 10) !== value ? null : timestamp;
  } catch {
    return null;
  }
}

function yearOf(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{4})/.exec(value);
  return match === null ? null : Number(match[1]);
}

function safeUrl(value: string | null): string {
  if (value !== null) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // Fall through to the public QCC data catalogue.
    }
  }
  return 'https://agent.qcc.com/data';
}

export function mapCompanyCandidates(payload: unknown): MappedCandidate[] {
  const unwrapped = unwrapPayload(payload);
  const chinese = RawRecordSchema.safeParse(unwrapped);
  if (chinese.success && Object.hasOwn(chinese.data, '企业信息')) {
    const rawInformation = chinese.data['企业信息'];
    const information = Array.isArray(rawInformation) ? rawInformation : [rawInformation];
    const parsed = z.array(RawRecordSchema).safeParse(information);
    if (!parsed.success) throw invalidResponse('QCC company information has an unsupported shape');
    const matchReason = stringValue(chinese.data, '匹配结果') ?? '企查查名称查询匹配';
    return parsed.data.map(record => {
      const legalName = stringValue(record, '企业名称');
      const creditCode = stringValue(record, '统一社会信用代码');
      if (legalName === null || creditCode === null) {
        throw invalidResponse('QCC candidate is missing legal name or credit code');
      }
      return {
        legalName,
        creditCode,
        status: stringValue(record, '登记状态'),
        registeredAddress: stringValue(record, '注册地址'),
        matchReason,
      };
    });
  }
  return recordsOf(payload).map(record => {
    const legalName = stringValue(record, 'Name');
    const creditCode = stringValue(record, 'CreditCode');
    if (legalName === null || creditCode === null) throw invalidResponse('QCC candidate is missing Name or CreditCode');
    return {
      legalName,
      creditCode,
      status: stringValue(record, 'Status'),
      registeredAddress: stringValue(record, 'Address'),
      matchReason: stringValue(record, 'MatchReason') ?? '企查查名称查询匹配',
    };
  });
}

function firstRecord(payload: unknown | null): Record<string, unknown> {
  if (payload === null) return {};
  return recordsOf(payload)[0] ?? {};
}

function websiteFromContact(record: Record<string, unknown>): string | null {
  const direct = stringValue(record, 'Website');
  if (direct !== null) return direct;
  const contact = record['联系方式信息'];
  if (typeof contact !== 'object' || contact === null || Array.isArray(contact)) return null;
  const websites = (contact as Record<string, unknown>)['网址'];
  if (!Array.isArray(websites)) return null;
  for (const website of websites) {
    if (typeof website !== 'object' || website === null || Array.isArray(website)) continue;
    const value = stringValue(website as Record<string, unknown>, '网址');
    if (value !== null) return value;
  }
  return null;
}

export function mapCompanyDetails(
  candidate: MappedCandidate,
  registrationPayload: unknown | null,
  profilePayload: unknown | null,
  contactPayload: unknown | null,
  riskPayload: unknown | null,
  collectedAt: Date,
): MappedCompanyDetails {
  const registration = firstRecord(registrationPayload);
  const profile = firstRecord(profilePayload);
  const contact = firstRecord(contactPayload);
  const risk = firstRecord(riskPayload);
  const website = websiteFromContact(contact) ?? stringValueFrom(profile, ['Website', '网址']);
  const officialDomains: string[] = [];
  if (website !== null) {
    try {
      officialDomains.push(new URL(website).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      // Invalid optional websites remain absent rather than being repaired.
    }
  }

  const identity = IdentityProfileSchema.parse({
    legalName: stringValueFrom(registration, ['Name', '企业名称']) ?? candidate.legalName,
    creditCode: stringValueFrom(registration, ['CreditCode', '统一社会信用代码']) ?? candidate.creditCode,
    formerNames: stringValuesFrom(registration, ['FormerNames', '曾用名']),
    aliases: [
      ...stringValuesFrom(profile, ['ShortNames', '企业简称']),
      ...stringValuesFrom(registration, ['企业简称']),
    ],
    englishNames: stringValuesFrom(registration, ['EnglishNames', '英文名']),
    brands: stringArray(profile, 'Brands'),
    officialDomains,
    registeredAddress: stringValueFrom(registration, ['Address', '注册地址']) ?? candidate.registeredAddress,
    parentLegalName: stringValue(registration, 'ParentLegalName'),
    subsidiaryLegalNames: stringArray(registration, 'SubsidiaryLegalNames'),
  });
  const basicProfile = BasicProfileSchema.parse({
    industry: stringValueFrom(registration, ['Industry', '国标行业'])
      ?? stringValueFrom(profile, ['Industry', '企查查行业']),
    region: stringValueFrom(registration, ['Province', '所属地区']),
    company_type: stringValueFrom(registration, ['EconKind', '企业类型']),
    founded_year: yearOf(stringValueFrom(registration, ['StartDate', '成立日期'])),
    registered_capital: stringValueFrom(registration, ['RegistCapi', '注册资本']),
    legal_representative: stringValueFrom(registration, ['OperName', '法定代表人']),
    website,
    employee_range: stringValueFrom(profile, ['EmployeeRange', '人员规模'])
      ?? stringValueFrom(registration, ['人员规模']),
    risk_summary: stringValueFrom(risk, ['Summary', '摘要']),
    collected_at: collectedAt.toISOString(),
  });
  return { identity, basicProfile };
}

function safeMappedRecord(tool: string, record: Record<string, unknown>): {
  titleDetail: string;
  summary: string | null;
  content: Record<string, unknown>;
  publishedAt: string | null;
  url: string;
} {
  if (tool === 'get_financing_records') {
    const parsed = FinancingRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC financing record has an unsupported shape');
    const occurredAt = dateTimestamp(parsed.data.Date);
    const typeOrRound = stringValue(parsed.data, 'Round') ?? stringValue(parsed.data, 'Type');
    const disclosedAmount = stringValue(parsed.data, 'Amount');
    const investors = stringArray(parsed.data, 'Investors');
    return {
      titleDetail: typeOrRound ?? '融资记录',
      summary: [typeOrRound, disclosedAmount].filter(Boolean).join('，') || null,
      content: { occurredAt, typeOrRound, disclosedAmount, investors },
      publishedAt: occurredAt,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_recruitment_info') {
    const parsed = RecruitmentRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC recruitment record has an unsupported shape');
    const publishedAt = dateTimestamp(parsed.data.PublishDate);
    const jobName = stringValue(parsed.data, 'JobName');
    const content = {
      publishedAt,
      jobName,
      salary: stringValue(parsed.data, 'Salary'),
      education: stringValue(parsed.data, 'Education'),
      experience: stringValue(parsed.data, 'Experience'),
      location: stringValue(parsed.data, 'Location'),
    };
    return {
      titleDetail: jobName ?? '招聘记录',
      summary: [jobName, content.location].filter(Boolean).join('，') || null,
      content,
      publishedAt,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_company_profile') {
    const parsed = FormalProfileRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC company profile has an unsupported shape');
    const name = stringValue(parsed.data, 'Name');
    const industry = stringValue(parsed.data, 'Industry');
    const introduction = stringValue(parsed.data, 'Introduction');
    const employeeRange = stringValue(parsed.data, 'EmployeeRange');
    const website = stringValue(parsed.data, 'Website');
    return {
      titleDetail: name ?? '企业简介',
      summary: introduction ?? industry,
      content: { name, industry, introduction, employeeRange, website },
      publishedAt: null,
      url: safeUrl(stringValue(parsed.data, 'Url') ?? website),
    };
  }

  if (tool === 'get_company_risk_scan') {
    const parsed = RiskRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC risk record has an unsupported shape');
    const summary = stringValue(parsed.data, 'Summary');
    return {
      titleDetail: '企业风险扫描',
      summary,
      content: {
        riskCount: numberValue(parsed.data, 'RiskCount'),
        exceptionCount: numberValue(parsed.data, 'ExceptionCount'),
        penaltyCount: numberValue(parsed.data, 'PenaltyCount'),
        judicialCount: numberValue(parsed.data, 'JudicialCount'),
        summary,
      },
      publishedAt: null,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_patent_info') {
    const parsed = PatentRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC patent record has an unsupported shape');
    const patentName = stringValue(parsed.data, 'PatentName');
    const applicationDate = dateTimestamp(parsed.data.ApplicationDate);
    return {
      titleDetail: patentName ?? '专利记录',
      summary: [stringValue(parsed.data, 'PatentType'), stringValue(parsed.data, 'Status')].filter(Boolean).join('，') || null,
      content: {
        patentName,
        patentType: stringValue(parsed.data, 'PatentType'),
        applicationNumber: stringValue(parsed.data, 'ApplicationNumber'),
        applicationDate,
        status: stringValue(parsed.data, 'Status'),
      },
      publishedAt: applicationDate,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_annual_reports') {
    const parsed = AnnualReportRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC annual report has an unsupported shape');
    const year = stringValue(parsed.data, 'Year');
    return {
      titleDetail: `${year ?? '未知年度'}年报`,
      summary: year === null ? null : `${year}年度公开年报信息`,
      content: {
        year,
        employeeCount: numberValue(parsed.data, 'EmployeeCount'),
        totalAssets: stringValue(parsed.data, 'TotalAssets'),
        revenue: stringValue(parsed.data, 'Revenue'),
      },
      publishedAt: null,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_bidding_info') {
    const parsed = BiddingRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC bidding record has an unsupported shape');
    const title = stringValue(parsed.data, 'Title');
    const publishedAt = dateTimestamp(parsed.data.PublishDate);
    return {
      titleDetail: title ?? '招投标记录',
      summary: [stringValue(parsed.data, 'Role'), stringValue(parsed.data, 'Purchaser')].filter(Boolean).join('，') || null,
      content: {
        title,
        publishedAt,
        role: stringValue(parsed.data, 'Role'),
        amount: stringValue(parsed.data, 'Amount'),
        purchaser: stringValue(parsed.data, 'Purchaser'),
      },
      publishedAt,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_shareholder_info') {
    const parsed = ShareholderRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC shareholder record has an unsupported shape');
    const shareholderName = stringValue(parsed.data, 'ShareholderName');
    return {
      titleDetail: shareholderName ?? '股东记录',
      summary: [shareholderName, stringValue(parsed.data, 'ShareholdingRatio')].filter(Boolean).join('，') || null,
      content: {
        shareholderName,
        shareholdingRatio: stringValue(parsed.data, 'ShareholdingRatio'),
        subscribedCapital: stringValue(parsed.data, 'SubscribedCapital'),
        shareholderType: stringValue(parsed.data, 'ShareholderType'),
      },
      publishedAt: null,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_software_copyright_info') {
    const parsed = SoftwareCopyrightRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC software copyright record has an unsupported shape');
    const softwareName = stringValue(parsed.data, 'SoftwareName');
    const registrationDate = dateTimestamp(parsed.data.RegistrationDate);
    return {
      titleDetail: softwareName ?? '软件著作权记录',
      summary: [softwareName, stringValue(parsed.data, 'Version')].filter(Boolean).join('，') || null,
      content: {
        softwareName,
        shortName: stringValue(parsed.data, 'ShortName'),
        registrationNumber: stringValue(parsed.data, 'RegistrationNumber'),
        registrationDate,
        version: stringValue(parsed.data, 'Version'),
      },
      publishedAt: registrationDate,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_qualifications') {
    const parsed = QualificationRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse('QCC qualification record has an unsupported shape');
    const qualificationName = stringValue(parsed.data, 'QualificationName');
    const issuedAt = dateTimestamp(parsed.data.IssuedAt);
    return {
      titleDetail: qualificationName ?? '资质记录',
      summary: [qualificationName, stringValue(parsed.data, 'Issuer')].filter(Boolean).join('，') || null,
      content: {
        qualificationName,
        certificateNumber: stringValue(parsed.data, 'CertificateNumber'),
        issuedAt,
        expiresAt: dateTimestamp(parsed.data.ExpiresAt),
        issuer: stringValue(parsed.data, 'Issuer'),
      },
      publishedAt: issuedAt,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  throw invalidResponse(`QCC tool has no v0.1 mapper: ${tool}`);
}

function recordArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  const parsed = z.array(RawRecordSchema).safeParse(value);
  if (!parsed.success) throw invalidResponse(`QCC ${key} has an unsupported shape`);
  return parsed.data;
}

function joinedStringArray(record: Record<string, unknown>, key: string): string | null {
  const values = stringArray(record, key);
  return values.length === 0 ? null : values.join('、');
}

function formalRecords(tool: string, payload: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapPayload(payload);
  if (RawRootSchema.safeParse(unwrapped).success) return recordsOf(payload);
  const chinese = RawRecordSchema.safeParse(unwrapped);
  if (!chinese.success || !Object.hasOwn(chinese.data, '企业名称')) return recordsOf(payload);
  const root = chinese.data;

  if (tool === 'get_company_profile') {
    return [{
      Name: stringValue(root, '企业名称'),
      Industry: stringValue(root, '企查查行业'),
      Introduction: stringValue(root, '简介'),
      EmployeeRange: stringValue(root, '人员规模'),
      Website: stringValue(root, '网址'),
    }];
  }
  if (tool === 'get_company_risk_scan') {
    return [{
      RiskCount: numberValue(root, '有记录因子数'),
      Summary: stringValue(root, '摘要'),
    }];
  }
  if (tool === 'get_patent_info') {
    return recordArray(root, '专利信息').map(record => ({
      PatentName: stringValue(record, '发明名称'),
      PatentType: stringValue(record, '专利类型'),
      ApplicationNumber: stringValue(record, '申请号'),
      ApplicationDate: stringValue(record, '申请日期'),
      Status: stringValue(record, '法律状态'),
    }));
  }
  if (tool === 'get_recruitment_info') {
    return recordArray(root, '招聘信息').map(record => ({
      PublishDate: stringValue(record, '发布日期'),
      JobName: stringValue(record, '招聘职位'),
      Salary: stringValue(record, '月薪'),
      Education: stringValue(record, '学历'),
      Experience: stringValue(record, '经验'),
      Location: stringValue(record, '办公地点'),
    }));
  }
  if (tool === 'get_bidding_info') {
    return recordArray(root, '招投标信息').map(record => ({
      Title: stringValue(record, '项目名称'),
      PublishDate: stringValue(record, '发布日期'),
      Amount: stringValue(record, '中标金额'),
      Purchaser: joinedStringArray(record, '招采单位'),
    }));
  }
  if (tool === 'get_financing_records' && Object.hasOwn(root, '搜索结果')) {
    return [];
  }
  return recordsOf(payload);
}

export function mapQccToolResult(
  server: QccServer,
  tool: string,
  payload: unknown,
  identity: IdentityProfile,
  collectedAt: Date,
): MappedQccResult {
  const records = formalRecords(tool, payload);
  if (records.length === 0) return { items: [], gaps: [`${tool}未查到或未披露数据`] };
  const sourceKind = server === 'company' ? 'company' : server === 'risk' ? 'risk' : server === 'ipr' ? 'ipr' : 'operation';
  const items = records.map((record, index) => {
    const safe = safeMappedRecord(tool, record);
    return ResearchItemSchema.parse({
      evidenceId: `qcc-${server}-${tool}-${index + 1}`,
      source: 'qcc',
      sourceKind,
      title: `${identity.legalName}｜${safe.titleDetail}`,
      url: safe.url,
      originalPublisher: null,
      originalDomain: null,
      summary: safe.summary,
      content: JSON.stringify(safe.content),
      publishedAt: safe.publishedAt,
      collectedAt: collectedAt.toISOString(),
      mentionedName: identity.legalName,
      entityScope: 'legal_entity',
      entityMatch: 'confirmed',
      matchBasis: ['按已确认法定主体及统一社会信用代码查询'],
      query: null,
      position: index + 1,
      logId: null,
    });
  });
  return { items, gaps: [] };
}
