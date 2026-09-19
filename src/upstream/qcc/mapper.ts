import { z } from 'zod';
import {
  BasicProfileSchema,
  IdentityProfileSchema,
  qccUnavailableLinkAuditGap,
  ResearchItemSchema,
  type BasicProfile,
  type IdentityProfile,
  type ResearchItem,
} from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import type { QccServer } from './tool-allowlist.js';

const RawRootSchema = z.object({ Data: z.unknown() }).passthrough();
const RawRecordSchema = z.record(z.string(), z.unknown());
const RequiredChineseStringSchema = z.string().trim().min(1);
const OptionalChineseStringSchema = RequiredChineseStringSchema.optional();
// Auxiliary profile values may change representation; identity fields stay strict.
const AuxiliaryProfileStringSchema = z.preprocess(
  value => typeof value === 'string' && value.trim() ? value.trim() : undefined,
  z.string().optional(),
);

function industryLabel(value: unknown): string | null {
  if (nonBlank(value)) return value.trim();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const labels = ['门类', '大类', '中类', '小类'].map(key => record[key]).filter(nonBlank);
  return labels.length === 0 ? null : [...new Set(labels.map(label => label.trim()))].join(' / ');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeQccLegalName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[A-Z]/g, character => character.toLowerCase());
}

const ChineseRegistrationSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: RequiredChineseStringSchema,
  登记状态: AuxiliaryProfileStringSchema,
  注册地址: AuxiliaryProfileStringSchema,
  所属地区: AuxiliaryProfileStringSchema,
  企业类型: AuxiliaryProfileStringSchema,
  成立日期: AuxiliaryProfileStringSchema,
  注册资本: AuxiliaryProfileStringSchema,
  法定代表人: AuxiliaryProfileStringSchema,
  国标行业: z.preprocess(value => industryLabel(value) ?? undefined, z.string().optional()),
  人员规模: AuxiliaryProfileStringSchema,
}).passthrough().refine(record => [
  record.登记状态,
  record.注册地址,
  record.所属地区,
  record.企业类型,
  record.成立日期,
  record.注册资本,
  record.法定代表人,
  record.国标行业,
  record.人员规模,
].some(nonBlank));

const ChineseProfileSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  企查查行业: AuxiliaryProfileStringSchema,
  简介: AuxiliaryProfileStringSchema,
  产业链概览: AuxiliaryProfileStringSchema,
  人员规模: AuxiliaryProfileStringSchema,
  网址: AuxiliaryProfileStringSchema,
}).passthrough().refine(record => [
  record.企查查行业,
  record.简介,
  record.产业链概览,
  record.人员规模,
  record.网址,
].some(nonBlank));

const ChinesePhoneSchema = z.object({ 电话号码: RequiredChineseStringSchema }).passthrough();
const ChineseWebsiteSchema = z.object({ 网址: RequiredChineseStringSchema }).passthrough();
const ChineseEmailSchema = z.object({ 邮箱: RequiredChineseStringSchema }).passthrough();

const ChineseContactSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  联系方式信息: z.object({
    电话: z.array(ChinesePhoneSchema).optional(),
    网址: z.array(ChineseWebsiteSchema).optional(),
    邮箱: z.array(ChineseEmailSchema).optional(),
  }).passthrough(),
}).passthrough().refine(record => [
  record.联系方式信息.电话,
  record.联系方式信息.网址,
  record.联系方式信息.邮箱,
].some(values => Array.isArray(values) && values.length > 0));

const NonNegativeIntegerNumberSchema = z.number().int().nonnegative();
const CanonicalNonNegativeIntegerSchema = z.union([
  NonNegativeIntegerNumberSchema,
  z.string().regex(/^(?:0|[1-9]\d*)$/u),
]);

const ChineseRiskFactorSchema = z.object({
  风险类型: OptionalChineseStringSchema,
  风险名称: OptionalChineseStringSchema,
  风险因子: OptionalChineseStringSchema,
  数量: CanonicalNonNegativeIntegerSchema.optional(),
  条目数: CanonicalNonNegativeIntegerSchema.optional(),
  风险等级: OptionalChineseStringSchema,
  描述: OptionalChineseStringSchema,
  明细工具: OptionalChineseStringSchema,
}).passthrough().refine(record => [
  record.风险类型,
  record.风险名称,
  record.风险因子,
  record.风险等级,
  record.描述,
].some(nonBlank)
  || record.数量 !== undefined
  || record.条目数 !== undefined);

const ChineseRiskSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  摘要: OptionalChineseStringSchema,
  有记录因子数: NonNegativeIntegerNumberSchema.optional(),
  无记录因子数: NonNegativeIntegerNumberSchema.optional(),
  风险因子扫描: z.array(ChineseRiskFactorSchema).optional(),
}).passthrough().refine(record => nonBlank(record.摘要)
  || typeof record.有记录因子数 === 'number'
  || typeof record.无记录因子数 === 'number'
  || (record.风险因子扫描?.length ?? 0) > 0);

const ChinesePatentRecordSchema = z.object({
  发明名称: OptionalChineseStringSchema,
  专利类型: OptionalChineseStringSchema,
  申请号: OptionalChineseStringSchema,
  申请日期: OptionalChineseStringSchema,
  法律状态: OptionalChineseStringSchema,
}).passthrough().refine(record => nonBlank(record.发明名称) || nonBlank(record.申请号));

const ChinesePatentSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  专利信息: z.array(ChinesePatentRecordSchema),
}).passthrough();

const ChineseRecruitmentRecordSchema = z.object({
  招聘职位: RequiredChineseStringSchema,
  发布日期: OptionalChineseStringSchema,
  月薪: OptionalChineseStringSchema,
  学历: OptionalChineseStringSchema,
  经验: OptionalChineseStringSchema,
  办公地点: OptionalChineseStringSchema,
}).passthrough();

const ChineseRecruitmentSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  招聘信息: z.array(ChineseRecruitmentRecordSchema),
}).passthrough();

const ChineseBiddingRecordSchema = z.object({
  项目名称: RequiredChineseStringSchema,
  发布日期: OptionalChineseStringSchema,
  中标金额: z.string().optional(),
  招采单位: z.array(z.string()).optional(),
  中标单位: z.array(z.string()).optional(),
}).passthrough();

const ChineseBiddingSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  招投标信息: z.array(ChineseBiddingRecordSchema),
}).passthrough();

const ChineseShareholderRecordSchema = z.object({
  股东名称: RequiredChineseStringSchema,
  持股比例: OptionalChineseStringSchema,
  认缴出资额: OptionalChineseStringSchema,
}).passthrough();

const ChineseShareholderSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: OptionalChineseStringSchema,
  股东信息: z.array(ChineseShareholderRecordSchema),
}).passthrough();

const ChineseCandidateSchema = z.object({
  企业名称: RequiredChineseStringSchema,
  统一社会信用代码: RequiredChineseStringSchema,
  登记状态: OptionalChineseStringSchema,
  注册地址: OptionalChineseStringSchema,
}).passthrough();

const ChineseCompanySearchSchema = z.object({
  企业信息: z.union([ChineseCandidateSchema, z.array(ChineseCandidateSchema)]),
  匹配结果: OptionalChineseStringSchema,
  摘要: OptionalChineseStringSchema,
  检索关键字: OptionalChineseStringSchema,
}).passthrough();

const OptionalStringSchema = z.string().nullable().optional();
const OptionalNumberSchema = z.number().nullable().optional();
const OptionalUrlSchema = OptionalStringSchema;
const OptionalDateSchema = OptionalStringSchema.refine(
  value => value == null || !nonBlank(value) || dateTimestamp(value) !== null,
);

const RegistrationRecordSchema = z.object({
  Name: z.string().trim().min(1),
  CreditCode: z.string().trim().min(1),
  Status: OptionalStringSchema,
  Address: OptionalStringSchema,
  Province: OptionalStringSchema,
  EconKind: OptionalStringSchema,
  StartDate: OptionalStringSchema,
  RegistCapi: OptionalStringSchema,
  OperName: OptionalStringSchema,
  Industry: OptionalStringSchema,
  EmployeeRange: OptionalStringSchema,
}).passthrough().refine(record => [
  record.Status,
  record.Address,
  record.Province,
  record.EconKind,
  record.StartDate,
  record.RegistCapi,
  record.OperName,
  record.Industry,
  record.EmployeeRange,
].some(nonBlank));

const ContactRecordSchema = z.object({
  Name: OptionalStringSchema,
  CreditCode: OptionalStringSchema,
  Website: OptionalStringSchema,
  Phone: OptionalStringSchema,
  Email: OptionalStringSchema,
}).passthrough().refine(record => [record.Website, record.Phone, record.Email].some(nonBlank));

const FormalProfileRecordSchema = z.object({
  Name: OptionalStringSchema,
  Industry: OptionalStringSchema,
  Introduction: OptionalStringSchema,
  EmployeeRange: OptionalStringSchema,
  Website: OptionalStringSchema,
  Url: OptionalUrlSchema,
}).passthrough().refine(record => [
  record.Industry, record.Introduction, record.EmployeeRange, record.Website,
].some(nonBlank));

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

const MaterialRecordSchema = z.object({
  Material: z.string().trim().min(1),
  Url: OptionalUrlSchema,
}).passthrough();

const RecruitmentMaterialRecordSchema = z.object({
  RecruitmentMaterial: z.string().trim().min(1),
  Url: OptionalUrlSchema,
}).passthrough();

const MATERIAL_MAX_BYTES = 8192;
const MATERIAL_TOOLS = new Set(['get_financing_records', 'get_annual_reports', 'get_qualifications']);
const RESEARCH_MATERIAL_TOOLS = new Set([
  'get_company_profile',
  'get_company_risk_scan',
  'get_patent_info',
  'get_recruitment_info',
  'get_bidding_info',
  'get_shareholder_info',
  'get_software_copyright_info',
  'get_financing_records',
  'get_annual_reports',
  'get_qualifications',
]);
const STRUCTURED_MATERIAL_FALLBACK_TOOLS = new Set([
  'get_company_profile',
  'get_patent_info',
  'get_recruitment_info',
  'get_bidding_info',
  'get_shareholder_info',
  'get_software_copyright_info',
  'get_financing_records',
  'get_annual_reports',
  'get_qualifications',
]);
const RECRUITMENT_MATERIAL_GAP = '招聘使用非结构化材料整理';
const RAW_MCP_TEXT = Symbol('raw-mcp-text');

interface RawMcpText {
  readonly [RAW_MCP_TEXT]: string;
}

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

function unmappableDataset(message: string): UpstreamError {
  return new UpstreamError('qcc', 'UNMAPPABLE_DATASET', message);
}

function isRawMcpText(value: unknown): value is RawMcpText {
  return typeof value === 'object' && value !== null && RAW_MCP_TEXT in value;
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
        const value = String((text as { text?: unknown }).text).trim();
        if (value.length === 0) throw invalidResponse('QCC text result is empty');
        try {
          return JSON.parse(value);
        } catch {
          return { [RAW_MCP_TEXT]: value };
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

interface ExpectedQccSubject {
  legalName: string;
  creditCode: string;
}

function assertExpectedSubject(record: Record<string, unknown>, expected: ExpectedQccSubject): void {
  const legalName = stringValueFrom(record, ['Name', '企业名称']);
  if (legalName !== null && normalizeQccLegalName(legalName) !== normalizeQccLegalName(expected.legalName)) {
    throw new UpstreamError('qcc', 'SUBJECT_MISMATCH', 'QCC legal name does not match the confirmed subject');
  }
  const creditCode = stringValueFrom(record, ['CreditCode', '统一社会信用代码']);
  if (creditCode !== null && creditCode.trim().toUpperCase() !== expected.creditCode.trim().toUpperCase()) {
    throw new UpstreamError('qcc', 'SUBJECT_MISMATCH', 'QCC credit code does not match the confirmed subject');
  }
}

function validateStandardProfileDetail(tool: string, record: Record<string, unknown>): void {
  const schema = tool === 'get_company_registration_info'
    ? RegistrationRecordSchema
    : tool === 'get_company_profile'
      ? FormalProfileRecordSchema
      : tool === 'get_contact_info'
        ? ContactRecordSchema
        : tool === 'get_company_risk_scan'
          ? RiskRecordSchema
          : null;
  if (schema === null || !schema.safeParse(record).success) {
    throw invalidResponse(`QCC ${tool} profile detail has an unsupported shape`);
  }
}

function validateChineseProfileDetail(tool: string, record: Record<string, unknown>): void {
  const schema = tool === 'get_company_registration_info'
    ? ChineseRegistrationSchema
    : tool === 'get_company_profile'
      ? ChineseProfileSchema
      : tool === 'get_contact_info'
        ? ChineseContactSchema
        : tool === 'get_company_risk_scan'
          ? ChineseRiskSchema
          : null;
  if (schema === null || !schema.safeParse(record).success) {
    throw invalidResponse(`QCC ${tool} Chinese profile detail has an unsupported shape`);
  }
}

export function validateQccPayload(
  tool: string,
  payload: unknown,
  expected: ExpectedQccSubject,
): unknown {
  const unwrapped = unwrapPayload(payload);
  if (RawRootSchema.safeParse(unwrapped).success) {
    const records = recordsOf(payload);
    if (records.length !== 1) throw invalidResponse(`QCC ${tool} must return one profile detail`);
    validateStandardProfileDetail(tool, records[0]);
    assertExpectedSubject(records[0], expected);
    return payload;
  }
  const chinese = RawRecordSchema.safeParse(unwrapped);
  if (!chinese.success) throw invalidResponse('QCC result has an unsupported shape');
  validateChineseProfileDetail(tool, chinese.data);
  assertExpectedSubject(chinese.data, expected);
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

function chineseRiskSummary(record: Record<string, unknown>): string | null {
  const direct = stringValueFrom(record, ['Summary', '摘要']);
  if (direct !== null) return direct;
  const parsed = ChineseRiskSchema.safeParse(record);
  if (!parsed.success) return null;
  const parts: string[] = [];
  if (typeof parsed.data.有记录因子数 === 'number') parts.push(`有记录因子数：${parsed.data.有记录因子数}`);
  if (typeof parsed.data.无记录因子数 === 'number') parts.push(`无记录因子数：${parsed.data.无记录因子数}`);
  for (const factor of parsed.data.风险因子扫描 ?? []) {
    const fields = [
      ['风险类型', factor.风险类型],
      ['风险名称', factor.风险名称],
      ['风险因子', factor.风险因子],
      ['数量', factor.数量],
      ['条目数', factor.条目数],
      ['风险等级', factor.风险等级],
      ['描述', factor.描述],
    ].filter((entry): entry is [string, string | number] => (
      typeof entry[1] === 'number' || nonBlank(entry[1])
    ));
    parts.push(fields.map(([label, value]) => `${label}：${String(value)}`).join('，'));
  }
  return parts.filter(nonBlank).join('；') || null;
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

function safeUrl(value: string | null): string | null {
  if (value !== null) {
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:')
        && url.hostname.length > 0
        && url.username.length === 0
        && url.password.length === 0) return url.toString();
    } catch {
      // Invalid or absent upstream links remain explicitly unavailable.
    }
  }
  return null;
}

export function mapCompanyCandidates(payload: unknown): MappedCandidate[] {
  const unwrapped = unwrapPayload(payload);
  const rawChinese = RawRecordSchema.safeParse(unwrapped);
  if (rawChinese.success && Object.hasOwn(rawChinese.data, '企业信息')) {
    const chinese = ChineseCompanySearchSchema.safeParse(unwrapped);
    if (!chinese.success) throw invalidResponse('QCC company search has an unsupported shape');
    const information = Array.isArray(chinese.data.企业信息)
      ? chinese.data.企业信息
      : [chinese.data.企业信息];
    const matchReason = chinese.data.匹配结果 ?? '企查查名称查询匹配';
    return information.map(record => {
      return {
        legalName: record.企业名称,
        creditCode: record.统一社会信用代码,
        status: record.登记状态 ?? null,
        registeredAddress: record.注册地址 ?? null,
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
  const details = [
    ['get_company_registration_info', registrationPayload],
    ['get_company_profile', profilePayload],
    ['get_contact_info', contactPayload],
    ['get_company_risk_scan', riskPayload],
  ] as const;
  for (const [tool, payload] of details) {
    if (payload === null) throw invalidResponse(`QCC ${tool} profile detail is unavailable`);
    validateQccPayload(tool, payload, candidate);
  }
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
      ?? industryLabel(registration.国标行业)
      ?? stringValueFrom(profile, ['Industry', '企查查行业']),
    region: stringValueFrom(registration, ['Province', '所属地区']),
    company_type: stringValueFrom(registration, ['EconKind', '企业类型']),
    founded_year: yearOf(stringValueFrom(registration, ['StartDate', '成立日期'])),
    registered_capital: stringValueFrom(registration, ['RegistCapi', '注册资本']),
    legal_representative: stringValueFrom(registration, ['OperName', '法定代表人']),
    website,
    employee_range: stringValueFrom(profile, ['EmployeeRange', '人员规模'])
      ?? stringValueFrom(registration, ['人员规模']),
    risk_summary: chineseRiskSummary(risk),
    collected_at: collectedAt.toISOString(),
  });
  return { identity, basicProfile };
}

const NON_EVIDENTIARY_MATERIAL_PATTERN =
  /(?:无权访问|无权限|请开通权限|未返回结构化|不可猜测|可能相关.{0,40}(?:主体|企业).{0,20}需.{0,10}确认)/u;
const LEGAL_ENTITY_NAME_PATTERN =
  /[\p{Script=Han}A-Za-z0-9（）()·]{2,80}(?:股份有限公司|有限责任公司|集团有限公司|有限公司)/gu;

function materialLabel(tool: string): string {
  const labels: Readonly<Record<string, string>> = {
    get_company_profile: '企业简介材料',
    get_company_risk_scan: '风险材料',
    get_patent_info: '专利材料',
    get_recruitment_info: '招聘材料',
    get_bidding_info: '招投标材料',
    get_shareholder_info: '股东材料',
    get_software_copyright_info: '软件著作权材料',
    get_financing_records: '融资材料',
    get_annual_reports: '年报材料',
    get_qualifications: '资质材料',
  };
  return labels[tool] ?? '企业研究材料';
}

function assertSubstantiveMaterial(text: string, tool: string): void {
  if (text.trim().length === 0 || NON_EVIDENTIARY_MATERIAL_PATTERN.test(text.normalize('NFKC'))) {
    throw unmappableDataset(`QCC ${tool} response contains no usable research material`);
  }
}

function hasStructuredMaterial(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ignoredKeys = new Set(['Name', 'CreditCode', '企业名称', '统一社会信用代码']);
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
    if (ignoredKeys.has(key) || entry === null || entry === undefined) return false;
    if (typeof entry === 'string') return entry.trim().length > 0;
    if (Array.isArray(entry)) return entry.length > 0;
    return typeof entry === 'object' && Object.keys(entry as Record<string, unknown>).length > 0;
  });
}

function assertPlainTextSubject(text: string, expected: ExpectedQccSubject): void {
  const normalized = text.normalize('NFKC');
  const expectedNames = new Set([
    normalizeQccLegalName(expected.legalName),
  ]);
  const mentionedLegalNames = normalized.match(LEGAL_ENTITY_NAME_PATTERN) ?? [];
  if (mentionedLegalNames.length > 0
    && !mentionedLegalNames.some(name => expectedNames.has(normalizeQccLegalName(name)))) {
    throw new UpstreamError('qcc', 'SUBJECT_MISMATCH', 'QCC plain text identifies another legal entity');
  }
  const mentionedCreditCodes = normalized.match(/(?<![0-9A-Z])[0-9A-Z]{18}(?![0-9A-Z])/gu) ?? [];
  if (mentionedCreditCodes.length > 0
    && !mentionedCreditCodes.some(code => code === expected.creditCode.trim().toUpperCase())) {
    throw new UpstreamError('qcc', 'SUBJECT_MISMATCH', 'QCC plain text identifies another credit code');
  }
}

function genericMaterialRecord(
  tool: string,
  value: unknown,
  expected: ExpectedQccSubject,
  plainText = false,
): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assertSubstantiveMaterial(text, tool);
  if (plainText) assertPlainTextSubject(text, expected);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    assertExpectedSubject(value as Record<string, unknown>, expected);
  }
  const records = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? [value as Record<string, unknown>]
    : [];
  return {
    Material: truncateUtf8(text, MATERIAL_MAX_BYTES),
    Url: materialSourceUrl(records),
  };
}

function safeMappedRecord(tool: string, record: Record<string, unknown>): {
  titleDetail: string;
  summary: string | null;
  content: Record<string, unknown>;
  publishedAt: string | null;
  url: string | null;
} {
  const genericMaterial = MaterialRecordSchema.safeParse(record);
  if (genericMaterial.success && RESEARCH_MATERIAL_TOOLS.has(tool)) {
    const label = materialLabel(tool);
    return {
      titleDetail: label,
      summary: `${label}（企查查材料，待模型整理）`,
      content: { material: genericMaterial.data.Material },
      publishedAt: null,
      url: safeUrl(stringValue(genericMaterial.data, 'Url')),
    };
  }
  if (MATERIAL_TOOLS.has(tool)) {
    const parsed = MaterialRecordSchema.safeParse(record);
    if (!parsed.success) throw invalidResponse(`QCC ${tool} material has an unsupported shape`);
    const label = tool === 'get_financing_records'
      ? '融资概况'
      : tool === 'get_annual_reports' ? '年报概况' : '资质概况';
    return {
      titleDetail: label,
      summary: `${label}（企查查材料，待模型整理）`,
      content: { material: parsed.data.Material },
      publishedAt: null,
      url: safeUrl(stringValue(parsed.data, 'Url')),
    };
  }

  if (tool === 'get_recruitment_info') {
    const material = RecruitmentMaterialRecordSchema.safeParse(record);
    if (material.success) {
      return {
        titleDetail: '招聘材料',
        summary: '招聘信息（企查查材料，待模型整理）',
        content: { material: material.data.RecruitmentMaterial },
        publishedAt: null,
        url: safeUrl(stringValue(material.data, 'Url')),
      };
    }
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
      url: safeUrl(stringValue(parsed.data, 'Url')),
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

  throw invalidResponse(`QCC tool has no v0.1 mapper: ${tool}`);
}

const EXPLICIT_EMPTY_FINANCING_RESULTS = new Set([
  '未查询到融资记录',
  '未查询到相关融资记录',
  '未查询到融资信息',
  '未查询到相关融资信息',
  '未查到融资记录',
  '未找到融资记录',
  '暂无融资记录',
  '暂无相关融资记录',
  '没有融资记录',
  '无融资记录',
]);

function normalizedStatusText(value: string): string {
  return value.replace(/[\s。！!，,；;：:]/gu, '');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  const contentLimit = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let output = '';
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (used + bytes > contentLimit) break;
    output += codePoint;
    used += bytes;
  }
  return `${output}${suffix}`;
}

function materialArray(value: unknown, tool: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw unmappableDataset(`QCC ${tool} material container is not an array`);
  const parsed = z.array(RawRecordSchema).safeParse(value);
  if (!parsed.success) throw unmappableDataset(`QCC ${tool} material records are not objects`);
  return parsed.data;
}

function materialSourceUrl(records: readonly Record<string, unknown>[]): string | null {
  for (const record of records) {
    const candidate = stringValueFrom(record, ['Url', '来源链接', '链接', '来源']);
    const url = safeUrl(candidate);
    if (url !== null) return url;
  }
  return null;
}

function hasRecruitmentMaterial(value: unknown): boolean {
  const text = JSON.stringify(value).normalize('NFKC');
  return /(?:招聘结果|招聘信息|招聘记录|招聘职位|岗位详情|岗位职责|任职要求|职位描述|职位要求)/u.test(text)
    && /(?:岗位|职位|职责|要求|工程师|管理员|顾问)/u.test(text);
}

function recruitmentMaterialRecord(
  root: Record<string, unknown>,
  expected: ExpectedQccSubject,
): Record<string, unknown> {
  assertExpectedSubject(root, expected);
  if (!hasRecruitmentMaterial(root)) {
    throw invalidResponse('QCC recruitment response does not contain recruitment material');
  }
  return {
    RecruitmentMaterial: truncateUtf8(JSON.stringify(root), MATERIAL_MAX_BYTES),
    Url: materialSourceUrl([root]),
  };
}

function knownMaterialRecords(
  tool: string,
  payload: unknown,
  expected: ExpectedQccSubject,
): Record<string, unknown>[] {
  const unwrapped = unwrapPayload(payload);
  const standard = RawRootSchema.safeParse(unwrapped);
  let records: Record<string, unknown>[];
  let note: string | null = null;
  if (standard.success) {
    records = recordsOf(payload);
    for (const record of records) assertExpectedSubject(record, expected);
  } else {
    const parsed = RawRecordSchema.safeParse(unwrapped);
    if (!parsed.success) throw invalidResponse(`QCC ${tool} result has an unsupported shape`);
    const root = parsed.data;
    assertExpectedSubject(root, expected);
    if (tool === 'get_financing_records') {
      const equity = RawRecordSchema.safeParse(root['股权融资']);
      const container = equity.success ? equity.data['创投融资'] : root['融资信息'];
      note = stringValue(root, '搜索结果');
      if (container === undefined) {
        if (note !== null && EXPLICIT_EMPTY_FINANCING_RESULTS.has(normalizedStatusText(note))) return [];
        throw unmappableDataset('QCC financing material container is unavailable');
      }
      records = materialArray(container, tool);
    } else if (tool === 'get_annual_reports') {
      if (root['企业年报信息'] === undefined) throw unmappableDataset('QCC annual-report material container is unavailable');
      records = materialArray(root['企业年报信息'], tool);
    } else if (tool === 'get_qualifications') {
      if (root['资质证书信息'] === undefined) throw unmappableDataset('QCC qualification material container is unavailable');
      records = materialArray(root['资质证书信息'], tool);
    } else {
      throw invalidResponse(`QCC ${tool} has no material adapter`);
    }
  }
  if (records.length === 0) return [];
  return [{
    Material: truncateUtf8(JSON.stringify({ records, ...(note === null ? {} : { note }) }), MATERIAL_MAX_BYTES),
    Url: materialSourceUrl(records),
  }];
}

function parseChineseFormalRoot<T extends z.ZodType>(
  schema: T,
  root: Record<string, unknown>,
  tool: string,
): z.output<T> {
  const parsed = schema.safeParse(root);
  if (!parsed.success) throw invalidResponse(`QCC ${tool} Chinese result has an unsupported shape`);
  return parsed.data;
}

function strictFormalRecords(
  tool: string,
  payload: unknown,
  expected: ExpectedQccSubject,
): Record<string, unknown>[] {
  if (MATERIAL_TOOLS.has(tool)) return knownMaterialRecords(tool, payload, expected);
  const unwrapped = unwrapPayload(payload);
  if (RawRootSchema.safeParse(unwrapped).success) {
    const records = recordsOf(payload);
    for (const record of records) assertExpectedSubject(record, expected);
    if (tool === 'get_recruitment_info'
      && records.length > 0
      && !records.every(record => RecruitmentRecordSchema.safeParse(record).success)
      && !records.every(record => RecruitmentMaterialRecordSchema.safeParse(record).success)) {
      return [recruitmentMaterialRecord({
        企业名称: expected.legalName,
        统一社会信用代码: expected.creditCode,
        招聘结果: records,
      }, expected)];
    }
    return records;
  }
  const chinese = RawRecordSchema.safeParse(unwrapped);
  if (!chinese.success) throw invalidResponse(`QCC ${tool} result has an unsupported shape`);
  const root = chinese.data;
  assertExpectedSubject(root, expected);

  if (tool === 'get_company_profile') {
    const parsed = parseChineseFormalRoot(ChineseProfileSchema, root, tool);
    return [{
      Name: parsed.企业名称,
      Industry: parsed.企查查行业 ?? null,
      Introduction: parsed.简介 ?? parsed.产业链概览 ?? null,
      EmployeeRange: parsed.人员规模 ?? null,
      Website: parsed.网址 ?? null,
    }];
  }
  if (tool === 'get_company_risk_scan') {
    const parsed = parseChineseFormalRoot(ChineseRiskSchema, root, tool);
    return [{
      RiskCount: parsed.有记录因子数 ?? null,
      Summary: chineseRiskSummary(parsed),
    }];
  }
  if (tool === 'get_patent_info') {
    const parsed = parseChineseFormalRoot(ChinesePatentSchema, root, tool);
    return parsed.专利信息.map(record => ({
      PatentName: record.发明名称 ?? null,
      PatentType: record.专利类型 ?? null,
      ApplicationNumber: record.申请号 ?? null,
      ApplicationDate: record.申请日期 ?? null,
      Status: record.法律状态 ?? null,
    }));
  }
  if (tool === 'get_recruitment_info') {
    const parsed = ChineseRecruitmentSchema.safeParse(root);
    if (!parsed.success) return [recruitmentMaterialRecord(root, expected)];
    return parsed.data.招聘信息.map(record => ({
      PublishDate: record.发布日期 ?? null,
      JobName: record.招聘职位,
      Salary: record.月薪 ?? null,
      Education: record.学历 ?? null,
      Experience: record.经验 ?? null,
      Location: record.办公地点 ?? null,
    }));
  }
  if (tool === 'get_bidding_info') {
    const parsed = parseChineseFormalRoot(ChineseBiddingSchema, root, tool);
    return parsed.招投标信息.map(record => ({
      Title: record.项目名称,
      PublishDate: record.发布日期 ?? null,
      Amount: record.中标金额 ?? null,
      Purchaser: record.招采单位?.filter(nonBlank).join('、') || null,
    }));
  }
  if (tool === 'get_shareholder_info') {
    const parsed = parseChineseFormalRoot(ChineseShareholderSchema, root, tool);
    return parsed.股东信息.map(record => ({
      ShareholderName: record.股东名称,
      ShareholdingRatio: record.持股比例 ?? null,
      SubscribedCapital: record.认缴出资额 ?? null,
      ShareholderType: null,
    }));
  }
  throw invalidResponse(`QCC ${tool} has no Chinese response contract`);
}

function formalRecords(
  tool: string,
  payload: unknown,
  expected: ExpectedQccSubject,
): Record<string, unknown>[] {
  const unwrapped = unwrapPayload(payload);
  if (isRawMcpText(unwrapped)) {
    if (!RESEARCH_MATERIAL_TOOLS.has(tool)) {
      throw invalidResponse(`QCC ${tool} does not accept plain text material`);
    }
    return [genericMaterialRecord(tool, unwrapped[RAW_MCP_TEXT], expected, true)];
  }

  try {
    return strictFormalRecords(tool, unwrapped, expected);
  } catch (error) {
    if (!STRUCTURED_MATERIAL_FALLBACK_TOOLS.has(tool)
      || !(error instanceof UpstreamError)
      || (error.code !== 'INVALID_RESPONSE' && error.code !== 'UNMAPPABLE_DATASET')
      || !hasStructuredMaterial(unwrapped)) {
      throw error;
    }
    try {
      return [genericMaterialRecord(tool, unwrapped, expected)];
    } catch (fallbackError) {
      if (fallbackError instanceof UpstreamError && fallbackError.code === 'UNMAPPABLE_DATASET') {
        throw error;
      }
      throw fallbackError;
    }
  }
}

export function mapQccToolResult(
  server: QccServer,
  tool: string,
  payload: unknown,
  identity: IdentityProfile,
  collectedAt: Date,
): MappedQccResult {
  const records = formalRecords(tool, payload, identity);
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
  const usedRecruitmentMaterial = tool === 'get_recruitment_info'
    && records.some(record => RecruitmentMaterialRecordSchema.safeParse(record).success);
  const usedGenericMaterial = records.some(record => MaterialRecordSchema.safeParse(record).success);
  return {
    items,
    gaps: [...new Set([
      ...(usedRecruitmentMaterial ? [RECRUITMENT_MATERIAL_GAP] : []),
      ...(usedGenericMaterial ? [`${materialLabel(tool)}使用非结构化材料，待模型整理`] : []),
      ...items
        .filter(item => item.url === null)
        .map(item => qccUnavailableLinkAuditGap(item.evidenceId)),
    ])],
  };
}
