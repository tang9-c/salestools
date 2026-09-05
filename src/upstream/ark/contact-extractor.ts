import { z } from 'zod';
import {
  ContactExtractionCandidateSchema,
  type ContactExtractionResult,
} from '../../contracts/index.js';
import type { RankedWebResult } from '../../contacts/contact-service.js';
import { ARK_REQUEST_MAX_BYTES } from './payload-budget.js';
import { ArkInvalidOutputError, ArkUnavailableError } from './client.js';

const ArkResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

const ContactResponseSchema = z.object({
  contacts: z.array(ContactExtractionCandidateSchema).max(100),
}).strict();

export interface ContactExtractorOptions {
  url: string;
  model: string;
  credential: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  requestMaxBytes?: number;
}

const SYSTEM_PROMPT = `你是公开职业身份抽取器。只输出 JSON 对象 {"contacts": [...]}。
每个联系人只能包含 companyName、name、title、roleCategory、sourceType、sourceUrl。
roleCategory 只允许 executive、research_and_development、digital_and_it、procurement、quality。
sourceType 只允许 official_website、official_news、official_wechat、tender、patent、conference。
只抽取企业负责人、研发/技术、数字化/IT、采购或质量负责人。
companyName、name、title 和 sourceUrl 必须逐字来自同一条输入材料，不得推测或补全。
不得输出邮箱、电话或其他直接联系方式。
专利发明人或招投标联系人没有明确职位时不得输出；普通员工和无法确认岗位者不得输出。`;

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new ArkInvalidOutputError('EMPTY_RESPONSE', 'Ark returned empty contacts');
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu);
  try {
    return JSON.parse((fence?.[1] ?? trimmed).trim());
  } catch (error) {
    throw new ArkInvalidOutputError('INVALID_JSON', 'Ark returned malformed contacts JSON', { cause: error });
  }
}

function pageText(item: RankedWebResult): string {
  return [item.summary, item.content].filter((value): value is string => value !== null).join('\n');
}

function compactItem(item: RankedWebResult, textLimit: number) {
  return {
    queryIndex: item.queryIndex,
    position: item.position,
    title: item.title.slice(0, 240),
    url: item.url,
    originalPublisher: item.originalPublisher?.slice(0, 120) ?? null,
    text: pageText(item).slice(0, textLimit),
    publishedAt: item.publishedAt,
  };
}

function serialize(model: string, items: readonly unknown[]): string {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ pages: items }) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });
}

function boundedRequest(
  model: string,
  items: readonly RankedWebResult[],
  maxBytes: number,
): { body: string; selection: ContactExtractionResult['selection'] } {
  const metadataOnly: RankedWebResult[] = [];
  let request = serialize(model, []);
  if (Buffer.byteLength(request, 'utf8') > maxBytes) {
    throw new ArkInvalidOutputError('INPUT_TOO_LARGE', 'Ark contacts request exceeds byte budget');
  }
  for (const item of items) {
    const candidate = [...metadataOnly, item];
    const serialized = serialize(model, candidate.map(page => compactItem(page, 0)));
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) break;
    metadataOnly.push(item);
    request = serialized;
  }
  if (items.length > 0 && metadataOnly.length === 0) {
    throw new ArkInvalidOutputError('INPUT_TOO_LARGE', 'Ark contacts request cannot fit page metadata');
  }

  let lower = 0;
  let upper = 1_500;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const serialized = serialize(model, metadataOnly.map(page => compactItem(page, middle)));
    if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
      lower = middle;
      request = serialized;
    } else {
      upper = middle - 1;
    }
  }
  const textTruncated = metadataOnly.length < items.length
    || metadataOnly.some(item => pageText(item).length > lower);
  return {
    body: request,
    selection: {
      totalPages: items.length,
      includedPages: metadataOnly.length,
      textTruncated,
    },
  };
}

export class ContactExtractor {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ContactExtractorOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async extract(items: readonly RankedWebResult[]): Promise<ContactExtractionResult> {
    const request = boundedRequest(
      this.options.model,
      items,
      this.options.requestMaxBytes ?? ARK_REQUEST_MAX_BYTES,
    );
    let response: Response;
    try {
      response = await this.fetchFn(this.options.url, {
        method: 'POST',
        signal: this.options.signal,
        headers: {
          Authorization: `Bearer ${this.options.credential}`,
          'Content-Type': 'application/json',
        },
        body: request.body,
      });
    } catch (error) {
      if (this.options.signal?.aborted === true) {
        throw new ArkUnavailableError('ABORTED', 'Ark contacts request aborted', { cause: error });
      }
      throw new ArkUnavailableError('NETWORK_ERROR', 'Ark contacts request failed', { cause: error });
    }
    if (!response.ok) {
      throw new ArkUnavailableError('REMOTE_HTTP_ERROR', `Ark contacts HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ArkUnavailableError('INVALID_RESPONSE', 'Ark returned invalid contacts response', { cause: error });
    }
    const envelope = ArkResponseSchema.safeParse(payload);
    if (!envelope.success) {
      throw new ArkUnavailableError('INVALID_RESPONSE', 'Ark contacts response has no model content', {
        cause: envelope.error,
      });
    }
    const parsed = ContactResponseSchema.safeParse(parseJsonContent(envelope.data.choices[0].message.content));
    if (!parsed.success) {
      throw new ArkInvalidOutputError('INVALID_CONTACTS', 'Ark returned invalid contacts', {
        cause: parsed.error,
      });
    }
    return { contacts: parsed.data.contacts, selection: request.selection };
  }
}
