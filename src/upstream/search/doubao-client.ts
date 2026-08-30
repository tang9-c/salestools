import { z } from 'zod';
import type { ResearchItem } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import { mapDoubaoSearchResponse } from './mapper.js';
import { SearchQuerySchema, type SearchQuery } from './search-plan.js';

const BusinessEnvelopeSchema = z.object({
  Code: z.number(),
  Message: z.string().optional(),
}).passthrough();

export interface DoubaoSearchClientOptions {
  url: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
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

export class DoubaoSearchClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: DoubaoSearchClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async search(query: SearchQuery): Promise<ResearchItem[]> {
    const parsedQuery = SearchQuerySchema.parse(query);
    let response: Response;
    try {
      response = await this.fetchFn(this.options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          Query: parsedQuery.Query,
          SearchType: parsedQuery.SearchType,
          Count: parsedQuery.Count,
          Filter: parsedQuery.Filter,
        }),
      });
    } catch (error) {
      throw new UpstreamError('doubao_search', 'NETWORK_ERROR', 'Doubao search request failed', { cause: error });
    }

    if (!response.ok) throw httpError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new UpstreamError('doubao_search', 'INVALID_RESPONSE', 'Doubao search returned invalid JSON', { cause: error });
    }

    const envelope = BusinessEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new UpstreamError('doubao_search', 'INVALID_RESPONSE', 'Doubao search response has no business code');
    }
    if (envelope.data.Code !== 0) {
      throw businessError(envelope.data.Code, envelope.data.Message ?? '');
    }

    return mapDoubaoSearchResponse(payload, parsedQuery, this.now());
  }
}
