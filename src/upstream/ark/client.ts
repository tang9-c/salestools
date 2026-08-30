import { z } from 'zod';
import type { EvidenceBundle, ResearchBundle } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import { ArkEvidenceValidationError, validateArkEvidence } from './evidence-validator.js';
import { buildArkMessages } from './prompt.js';

const ArkResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string(),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

export interface ArkEvidenceServiceOptions {
  url: string;
  model: string;
  credential: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export class ArkUnavailableError extends UpstreamError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super('ark', code, message, options);
    Object.defineProperty(this, 'name', { value: 'ArkUnavailableError' });
  }
}

export class ArkInvalidOutputError extends UpstreamError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super('ark', code, message, options);
    Object.defineProperty(this, 'name', { value: 'ArkInvalidOutputError' });
  }
}

function jsonContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new ArkInvalidOutputError('EMPTY_RESPONSE', 'Ark returned empty model content');
  }

  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new ArkInvalidOutputError('INVALID_JSON', 'Ark returned malformed model JSON', { cause: error });
  }
}

export class ArkEvidenceService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ArkEvidenceServiceOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async extract(bundle: ResearchBundle): Promise<EvidenceBundle> {
    let response: Response;
    try {
      response = await this.fetchFn(this.options.url, {
        method: 'POST',
        signal: this.options.signal,
        headers: {
          Authorization: `Bearer ${this.options.credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: buildArkMessages(bundle),
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
      });
    } catch (error) {
      if (this.options.signal?.aborted === true) {
        throw new ArkUnavailableError('ABORTED', 'Ark request aborted', { cause: error });
      }
      throw new ArkUnavailableError('NETWORK_ERROR', 'Ark request failed', { cause: error });
    }

    if (!response.ok) {
      throw new ArkUnavailableError('REMOTE_HTTP_ERROR', `Ark HTTP ${response.status}`);
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new ArkUnavailableError('INVALID_RESPONSE', 'Ark returned an invalid API response', { cause: error });
    }

    const parsed = ArkResponseSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new ArkUnavailableError('INVALID_RESPONSE', 'Ark response has no model content', { cause: parsed.error });
    }

    const candidate = jsonContent(parsed.data.choices[0].message.content);
    try {
      return validateArkEvidence(bundle, candidate);
    } catch (error) {
      if (error instanceof ArkEvidenceValidationError) {
        throw new ArkInvalidOutputError('INVALID_EVIDENCE', error.message, { cause: error });
      }
      throw error;
    }
  }
}
