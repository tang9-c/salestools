import type { EvidenceBundle, ResearchBundle } from '../../contracts/index.js';
import { UpstreamError } from '../../orchestration/retry.js';
import { ArkEvidenceValidationError, validateArkEvidence } from './evidence-validator.js';
import {
  ARK_REQUEST_MAX_BYTES,
  compactResearchBundleForArk,
  type ArkPayloadSelection,
} from './payload-budget.js';
import { buildArkMessages } from './prompt.js';
import { planArkBatches, type ArkBatchPlan } from './batch-plan.js';
import { ArkTransportError, requestArkJsonContent } from './json-request.js';

export interface ArkEvidenceServiceOptions {
  url: string;
  model: string;
  credential: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  requestMaxBytes?: number;
  requestTimeoutMs?: number;
}

export interface ArkEvidenceExtraction {
  readonly evidence: EvidenceBundle;
  readonly selection: ArkPayloadSelection;
  readonly requestBytes: number;
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

function serializeArkRequest(model: string, bundle: ResearchBundle): string {
  return JSON.stringify({
    model,
    messages: buildArkMessages(bundle),
    response_format: { type: 'json_object' },
    temperature: 0,
  });
}

export class ArkEvidenceService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ArkEvidenceServiceOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  planBatches(bundle: ResearchBundle): ArkBatchPlan {
    const requestMaxBytes = this.options.requestMaxBytes ?? ARK_REQUEST_MAX_BYTES;
    return planArkBatches(
      bundle,
      requestMaxBytes,
      candidate => Buffer.byteLength(serializeArkRequest(this.options.model, candidate), 'utf8'),
    );
  }

  async extract(bundle: ResearchBundle): Promise<EvidenceBundle> {
    return (await this.extractWithAudit(bundle)).evidence;
  }

  async extractWithAudit(bundle: ResearchBundle): Promise<ArkEvidenceExtraction> {
    const requestMaxBytes = this.options.requestMaxBytes ?? ARK_REQUEST_MAX_BYTES;
    let selection: ArkPayloadSelection;
    let requestBody: string;
    let requestBytes: number;
    try {
      selection = compactResearchBundleForArk(
        bundle,
        requestMaxBytes,
        compactBundle => Buffer.byteLength(serializeArkRequest(this.options.model, compactBundle), 'utf8'),
      );
      requestBody = serializeArkRequest(this.options.model, selection.bundle);
      requestBytes = Buffer.byteLength(requestBody, 'utf8');
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ArkInvalidOutputError(
          'INPUT_TOO_LARGE',
          'Ark request exceeds the UTF-8 byte budget',
          { cause: error },
        );
      }
      throw error;
    }
    if (requestBytes > requestMaxBytes) {
      throw new ArkInvalidOutputError('INPUT_TOO_LARGE', 'Ark request exceeds the UTF-8 byte budget');
    }
    const compactBundle = selection.bundle;
    let content: string;
    try {
      content = await requestArkJsonContent({ url: this.options.url, credential: this.options.credential,
        body: requestBody, fetchFn: this.fetchFn, signal: this.options.signal,
        timeoutMs: this.options.requestTimeoutMs });
    } catch (error) {
      if (error instanceof ArkTransportError) throw new ArkUnavailableError(error.code, error.message, { cause: error });
      throw error;
    }
    const candidate = jsonContent(content);
    try {
      const validated = validateArkEvidence(compactBundle, candidate);
      return {
        evidence: {
          ...validated,
          gaps: [...new Set([...validated.gaps, ...bundle.gaps, ...compactBundle.gaps])],
        },
        selection,
        requestBytes,
      };
    } catch (error) {
      if (error instanceof ArkEvidenceValidationError) {
        throw new ArkInvalidOutputError('INVALID_EVIDENCE', error.message, { cause: error });
      }
      throw error;
    }
  }
}
