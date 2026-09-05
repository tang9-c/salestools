import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ResearchItemSchema, type ResearchItem } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import type { SearchQuery } from './search-plan.js';

const OptionalTextSchema = z.string().nullable().optional();
const SafeWebUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0) {
      context.addIssue({ code: 'custom', message: 'expected an HTTP(S) URL with a hostname' });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({ code: 'custom', message: 'embedded URL credentials are forbidden' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'expected a valid URL' });
  }
});
const WebResultSchema = z.object({
  Title: z.string().trim().min(1),
  SiteName: OptionalTextSchema,
  Url: SafeWebUrlSchema,
  Summary: OptionalTextSchema,
  Content: OptionalTextSchema,
  PublishTime: z.union([z.string(), z.number()]).nullable().optional(),
  SortId: z.number().int().nonnegative(),
}).passthrough();

const SuccessfulResponseSchema = z.object({
  Code: z.literal(0),
  Message: z.string().optional(),
  LogId: z.string().nullable().optional(),
  Result: z.object({ WebResults: z.array(WebResultSchema) }).passthrough(),
}).passthrough();

export interface DoubaoWebResult {
  title: string;
  url: string;
  originalPublisher: string | null;
  originalDomain: string;
  summary: string | null;
  content: string | null;
  publishedAt: string | null;
  position: number;
  logId: string | null;
}

function invalidResponse(message: string, cause?: unknown): UpstreamError {
  return new UpstreamError(
    'doubao_search',
    'INVALID_RESPONSE',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function nullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function publishedTimestamp(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  let normalized: string | number = value;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
      normalized = `${value.replace(' ', 'T')}.000Z`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      normalized = `${value}T00:00:00.000Z`;
    }
  } else if (value < 10_000_000_000) {
    normalized = value * 1_000;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attribution(
  query: SearchQuery,
  url: URL,
  title: string,
  summary: string | null,
  content: string | null,
): Pick<ResearchItem, 'mentionedName' | 'entityScope' | 'entityMatch' | 'matchBasis'> {
  const pageText = [title, summary, content].filter((value): value is string => value !== null).join('\n');
  if (pageText.includes(query.subjectLegalName)) {
    return {
      mentionedName: query.subjectLegalName,
      entityScope: 'legal_entity',
      entityMatch: 'confirmed',
      matchBasis: ['网页内容提及已确认法定名称'],
    };
  }

  const normalizedResultDomain = normalizeDomain(url.hostname);
  const officialDomainMatch = query.subjectOfficialDomains.some(domain => normalizeDomain(domain) === normalizedResultDomain);
  if (officialDomainMatch) {
    return {
      mentionedName: query.searchedName,
      entityScope: 'legal_entity',
      entityMatch: 'confirmed',
      matchBasis: ['URL 域名匹配已确认官网域名'],
    };
  }

  const alias = query.subjectAliases.find(name => pageText.includes(name));
  if (alias !== undefined) {
    if (query.subjectRegisteredAddress !== null && pageText.includes(query.subjectRegisteredAddress)) {
      return {
        mentionedName: alias,
        entityScope: 'legal_entity',
        entityMatch: 'probable',
        matchBasis: ['网页提及已验证简称', '网页同时包含已确认注册地址'],
      };
    }
    return {
      mentionedName: alias,
      entityScope: 'unknown',
      entityMatch: 'unverified',
      matchBasis: ['网页仅提及已验证简称，缺少额外身份依据'],
    };
  }

  return {
    mentionedName: query.searchedName,
    entityScope: 'unknown',
    entityMatch: 'unverified',
    matchBasis: ['仅搜索查询使用已确认名称，网页内容未确认主体'],
  };
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let hostname = trimmed;
  try {
    hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return '';
  }
  return hostname.replace(/^www\./, '').replace(/\.$/, '');
}

function evidenceId(logId: string | null, query: SearchQuery, url: URL, position: number): string {
  if (logId !== null) return `doubao-${logId}-${position}`;
  const digest = createHash('sha256')
    .update(query.Query)
    .update('\0')
    .update(url.toString())
    .update('\0')
    .update(String(position))
    .digest('hex')
    .slice(0, 24);
  return `doubao-sha256-${digest}`;
}

export function mapDoubaoSearchResponse(
  payload: unknown,
  query: SearchQuery,
  collectedAt: Date,
): ResearchItem[] {
  return mapDoubaoWebResponse(payload).map(result => {
    const url = new URL(result.url);
    return ResearchItemSchema.parse({
      evidenceId: evidenceId(result.logId, query, url, result.position),
      source: 'doubao_search',
      sourceKind: 'web',
      ...result,
      ...attribution(query, url, result.title, result.summary, result.content),
      collectedAt: collectedAt.toISOString(),
      query: query.Query,
    });
  });
}

export function mapDoubaoWebResponse(payload: unknown): DoubaoWebResult[] {
  const parsed = SuccessfulResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidResponse('Doubao search response has an unsupported shape', parsed.error);
  const logId = nullableText(parsed.data.LogId);

  return parsed.data.Result.WebResults.map(result => {
    const summary = nullableText(result.Summary);
    const content = nullableText(result.Content);
    const url = new URL(result.Url);
    return {
      title: result.Title,
      url: url.toString(),
      originalPublisher: nullableText(result.SiteName),
      originalDomain: url.hostname.toLowerCase(),
      summary,
      content,
      publishedAt: publishedTimestamp(result.PublishTime),
      position: result.SortId,
      logId,
    };
  });
}
