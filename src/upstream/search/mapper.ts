import { z } from 'zod';
import { ResearchItemSchema, type ResearchItem } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import type { SearchQuery } from './search-plan.js';

const OptionalTextSchema = z.string().nullable().optional();
const WebResultSchema = z.object({
  Title: z.string().trim().min(1),
  SiteName: OptionalTextSchema,
  Url: z.url(),
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

  const alias = query.subjectAliases.find(name => pageText.includes(name));
  if (alias !== undefined) {
    return {
      mentionedName: alias,
      entityScope: 'legal_entity',
      entityMatch: 'probable',
      matchBasis: ['网页内容提及已验证简称，仍需其他身份要素确认'],
    };
  }

  return {
    mentionedName: query.searchedName,
    entityScope: 'unknown',
    entityMatch: 'unverified',
    matchBasis: ['仅搜索查询使用已确认名称，网页内容未确认主体'],
  };
}

export function mapDoubaoSearchResponse(
  payload: unknown,
  query: SearchQuery,
  collectedAt: Date,
): ResearchItem[] {
  const parsed = SuccessfulResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidResponse('Doubao search response has an unsupported shape', parsed.error);
  const logId = nullableText(parsed.data.LogId);

  return parsed.data.Result.WebResults.map(result => {
    const summary = nullableText(result.Summary);
    const content = nullableText(result.Content);
    const url = new URL(result.Url);
    return ResearchItemSchema.parse({
      evidenceId: `doubao-${logId ?? 'no-log-id'}-${result.SortId}`,
      source: 'doubao_search',
      sourceKind: 'web',
      title: result.Title,
      url: url.toString(),
      originalPublisher: nullableText(result.SiteName),
      originalDomain: url.hostname.toLowerCase(),
      summary,
      content,
      publishedAt: publishedTimestamp(result.PublishTime),
      collectedAt: collectedAt.toISOString(),
      ...attribution(query, result.Title, summary, content),
      query: query.Query,
      position: result.SortId,
      logId,
    });
  });
}
