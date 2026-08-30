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
  const parsed = RawRootSchema.safeParse(unwrapPayload(payload));
  if (!parsed.success) throw invalidResponse('QCC result does not contain Data');
  return parsed.data.Data;
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
  recordsOf(payload);
  return payload;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
}

function dateTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  try {
    return new Date(normalized).toISOString();
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
  const website = stringValue(contact, 'Website') ?? stringValue(profile, 'Website');
  const officialDomains: string[] = [];
  if (website !== null) {
    try {
      officialDomains.push(new URL(website).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      // Invalid optional websites remain absent rather than being repaired.
    }
  }

  const identity = IdentityProfileSchema.parse({
    legalName: stringValue(registration, 'Name') ?? candidate.legalName,
    creditCode: stringValue(registration, 'CreditCode') ?? candidate.creditCode,
    formerNames: stringArray(registration, 'FormerNames'),
    aliases: stringArray(profile, 'ShortNames'),
    englishNames: stringArray(registration, 'EnglishNames'),
    brands: stringArray(profile, 'Brands'),
    officialDomains,
    registeredAddress: stringValue(registration, 'Address') ?? candidate.registeredAddress,
    parentLegalName: stringValue(registration, 'ParentLegalName'),
    subsidiaryLegalNames: stringArray(registration, 'SubsidiaryLegalNames'),
  });
  const basicProfile = BasicProfileSchema.parse({
    industry: stringValue(registration, 'Industry') ?? stringValue(profile, 'Industry'),
    region: stringValue(registration, 'Province'),
    company_type: stringValue(registration, 'EconKind'),
    founded_year: yearOf(stringValue(registration, 'StartDate')),
    registered_capital: stringValue(registration, 'RegistCapi'),
    legal_representative: stringValue(registration, 'OperName'),
    website,
    employee_range: stringValue(profile, 'EmployeeRange'),
    risk_summary: stringValue(risk, 'Summary'),
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
    const occurredAt = dateTimestamp(record.Date);
    const typeOrRound = stringValue(record, 'Round') ?? stringValue(record, 'Type');
    const disclosedAmount = stringValue(record, 'Amount');
    const investors = stringArray(record, 'Investors');
    return {
      titleDetail: typeOrRound ?? '融资记录',
      summary: [typeOrRound, disclosedAmount].filter(Boolean).join('，') || null,
      content: { occurredAt, typeOrRound, disclosedAmount, investors },
      publishedAt: occurredAt,
      url: safeUrl(stringValue(record, 'Url')),
    };
  }

  if (tool === 'get_recruitment_info') {
    const publishedAt = dateTimestamp(record.PublishDate);
    const jobName = stringValue(record, 'JobName');
    const content = {
      publishedAt,
      jobName,
      salary: stringValue(record, 'Salary'),
      education: stringValue(record, 'Education'),
      experience: stringValue(record, 'Experience'),
      location: stringValue(record, 'Location'),
    };
    return {
      titleDetail: jobName ?? '招聘记录',
      summary: [jobName, content.location].filter(Boolean).join('，') || null,
      content,
      publishedAt,
      url: safeUrl(stringValue(record, 'Url')),
    };
  }

  const title = stringValue(record, 'Title') ?? stringValue(record, 'Name') ?? tool;
  const summary = stringValue(record, 'Summary') ?? stringValue(record, 'Introduction');
  return {
    titleDetail: title,
    summary,
    content: { title, summary },
    publishedAt: dateTimestamp(record.PublishDate ?? record.Date),
    url: safeUrl(stringValue(record, 'Url')),
  };
}

export function mapQccToolResult(
  server: QccServer,
  tool: string,
  payload: unknown,
  identity: IdentityProfile,
  collectedAt: Date,
): MappedQccResult {
  const records = recordsOf(payload);
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
