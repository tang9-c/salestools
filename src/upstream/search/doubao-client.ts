import { z } from 'zod';
import type { ResearchItem } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import { mapDoubaoSearchResponse, mapDoubaoWebResponse, type DoubaoWebResult } from './mapper.js';
import {
  DoubaoWebSearchRequestSchema,
  SearchQuerySchema,
  type DoubaoWebSearchRequest,
  type SearchQuery,
} from './search-plan.js';

const BusinessEnvelopeSchema = z.object({
  Code: z.number(),
  Message: z.string().optional(),
}).passthrough();

const ResponseMetadataPresenceSchema = z.object({
  ResponseMetadata: z.object({ Error: z.unknown().optional() }).passthrough(),
}).passthrough();

const OfficialEnvelopeSchema = z.object({
  ResponseMetadata: z.object({ Error: z.unknown().optional() }).passthrough(),
  Result: z.record(z.string(), z.unknown()),
}).passthrough();

export interface DoubaoSearchClientOptions {
  url: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}

function httpError(status: number): UpstreamError {
  if (status === 401 || status === 403) {
    return new UpstreamError('doubao_search', 'AUTHENTICATION_ERROR', 'Doubao search authentication failed');
  }
  if (status === 429) {
    return new UpstreamError('doubao_search', 'RATE_LIMITED', 'Doubao search rate limit exceeded');
  }
  if (status >= 500) {
    return new UpstreamError('doubao_search', 'REMOTE_SERVER_ERROR', `Doubao search HTTP ${status}`);
  }
  return new UpstreamError('doubao_search', 'REMOTE_HTTP_ERROR', `Doubao search HTTP ${status}`);
}

function businessError(code: number, message: string): UpstreamError {
  const lower = message.toLowerCase();
  if (/qps|rate|频率|限流/.test(lower)) {
    return new UpstreamError('doubao_search', 'RATE_LIMITED', `Doubao search business error ${code}`);
  }
  if (/quota|额度|配额/.test(lower)) {
    return new UpstreamError('doubao_search', 'QUOTA_EXCEEDED', `Doubao search business error ${code}`);
  }
  if (/auth|api.?key|鉴权|认证|权限/.test(lower)) {
    return new UpstreamError('doubao_search', 'AUTHENTICATION_ERROR', `Doubao search business error ${code}`);
  }
  return new UpstreamError('doubao_search', 'REMOTE_BUSINESS_ERROR', `Doubao search business error ${code}`);
}

function normalizeSuccessfulPayload(payload: unknown): unknown {
  const metadata = ResponseMetadataPresenceSchema.safeParse(payload);
  if (metadata.success
    && metadata.data.ResponseMetadata.Error !== undefined
    && metadata.data.ResponseMetadata.Error !== null) {
    throw new UpstreamError('doubao_search', 'REMOTE_BUSINESS_ERROR', 'Doubao search metadata contains an error');
  }

  const legacy = BusinessEnvelopeSchema.safeParse(payload);
  if (legacy.success && legacy.data.Code !== 0) {
    throw businessError(legacy.data.Code, legacy.data.Message ?? '');
  }

  const official = OfficialEnvelopeSchema.safeParse(payload);
  if (official.success) {
    return {
      Code: 0,
      LogId: official.data.Result.LogId,
      Result: official.data.Result,
    };
  }

  if (legacy.success) {
    return payload;
  }

  throw new UpstreamError('doubao_search', 'INVALID_RESPONSE', 'Doubao search response has no supported envelope');
}

export class DoubaoSearchClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: DoubaoSearchClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async search(query: SearchQuery): Promise<ResearchItem[]> {
    const parsedQuery = SearchQuerySchema.parse(query);
    const payload = await this.request(parsedQuery);
    return mapDoubaoSearchResponse(payload, parsedQuery, this.now());
  }

  async searchWeb(query: DoubaoWebSearchRequest): Promise<DoubaoWebResult[]> {
    const parsedQuery = DoubaoWebSearchRequestSchema.parse(query);
    const payload = await this.request(parsedQuery);
    return mapDoubaoWebResponse(payload);
  }

  private async request(query: DoubaoWebSearchRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(this.options.url, {
        method: 'POST',
        signal: this.options.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          Query: query.Query,
          SearchType: query.SearchType,
          Count: query.Count,
          Filter: query.Filter,
        }),
      });
    } catch (error) {
      if (this.options.signal?.aborted === true) {
        throw new UpstreamError('doubao_search', 'ABORTED', 'Doubao search request aborted', { cause: error });
      }
      throw new UpstreamError('doubao_search', 'NETWORK_ERROR', 'Doubao search request failed', { cause: error });
    }

    if (!response.ok) throw httpError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new UpstreamError('doubao_search', 'INVALID_RESPONSE', 'Doubao search returned invalid JSON', { cause: error });
    }

    return normalizeSuccessfulPayload(payload);
  }
}
