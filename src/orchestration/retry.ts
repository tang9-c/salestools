import type { CallBudget, UpstreamSource } from './call-budget.js';

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly source: UpstreamSource,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type RetryResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: UpstreamError };

export type RetryAttemptEvent = Readonly<{
  source: UpstreamSource;
  durationMs: number;
  success: boolean;
  attempt: number;
  error: { code: string; message: string } | null;
}>;

export interface RetryOptions {
  onAttempt?: (event: RetryAttemptEvent) => void;
  nowMs?: () => number;
}

function typedError(source: UpstreamSource, error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  const message = error instanceof Error ? error.message : 'Unknown upstream failure';
  return new UpstreamError(source, 'UPSTREAM_FAILED', message, { cause: error });
}

const SAFE_SOURCE_LABEL: Readonly<Record<UpstreamSource, string>> = {
  qcc: 'QCC',
  doubao_search: 'Doubao search',
  ark: 'Ark',
};

const SAFE_ERROR_MESSAGES: Readonly<Partial<Record<UpstreamSource, Readonly<Record<string, string>>>>> = {
  qcc: {
    TRANSPORT: 'QCC transport unavailable',
    REMOTE_PROTOCOL_ERROR: 'QCC protocol request failed',
    AUTHENTICATION_ERROR: 'QCC authentication failed',
    REMOTE_HTTP_ERROR: 'QCC HTTP request failed',
    REMOTE_TOOL_ERROR: 'QCC tool request failed',
    INVALID_RESPONSE: 'QCC returned an invalid response',
    SUBJECT_MISMATCH: 'QCC response subject did not match the confirmed company',
    UNMAPPABLE_DATASET: 'QCC dataset could not be structurally verified',
    TOOL_NOT_ALLOWED: 'QCC tool request rejected locally',
    ABORTED: 'QCC request cancelled during shutdown',
  },
  doubao_search: {
    NETWORK_ERROR: 'Doubao search network request failed',
    AUTHENTICATION_ERROR: 'Doubao search authentication failed',
    RATE_LIMITED: 'Doubao search rate limit reached',
    QUOTA_EXCEEDED: 'Doubao search quota exhausted',
    REMOTE_SERVER_ERROR: 'Doubao search server request failed',
    REMOTE_HTTP_ERROR: 'Doubao search HTTP request failed',
    REMOTE_BUSINESS_ERROR: 'Doubao search business request failed',
    INVALID_RESPONSE: 'Doubao search returned an invalid response',
    ABORTED: 'Doubao search request cancelled during shutdown',
  },
  ark: {
    NETWORK_ERROR: 'Ark network request failed',
    REMOTE_HTTP_ERROR: 'Ark HTTP request failed',
    INVALID_RESPONSE: 'Ark returned an invalid response',
    EMPTY_RESPONSE: 'Ark returned empty content',
    INVALID_JSON: 'Ark returned invalid JSON',
    INVALID_EVIDENCE: 'Ark returned invalid evidence',
    INPUT_TOO_LARGE: 'Ark request exceeds the configured input capacity',
    ABORTED: 'Ark request cancelled during shutdown',
  },
};

export function safeUpstreamErrorMessage(source: UpstreamSource, code: string): string {
  return code === 'BUDGET_EXHAUSTED'
    ? `${SAFE_SOURCE_LABEL[source]} call budget exhausted`
    : SAFE_ERROR_MESSAGES[source]?.[code] ?? `${SAFE_SOURCE_LABEL[source]} upstream request failed`;
}

function safeAttemptError(error: UpstreamError): RetryAttemptEvent['error'] {
  return { code: error.code, message: safeUpstreamErrorMessage(error.source, error.code) };
}

const NON_RETRYABLE_CODES = new Set([
  'ABORTED',
  'AUTHENTICATION_ERROR',
  'EMPTY_RESPONSE',
  'INVALID_EVIDENCE',
  'INVALID_JSON',
  'INVALID_RESPONSE',
  'INPUT_TOO_LARGE',
  'QUOTA_EXCEEDED',
  'REMOTE_BUSINESS_ERROR',
  'REMOTE_PROTOCOL_ERROR',
  'REMOTE_TOOL_ERROR',
  'SUBJECT_MISMATCH',
  'TOOL_NOT_ALLOWED',
  'UNMAPPABLE_DATASET',
]);

function isRetryable(error: UpstreamError): boolean {
  return !NON_RETRYABLE_CODES.has(error.code);
}

export async function retryOnce<T>(
  source: UpstreamSource,
  budget: CallBudget,
  attempt: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
    if (!budget.tryConsume(source)) {
      return {
        status: 'failed',
        error: new UpstreamError(source, 'BUDGET_EXHAUSTED', `${source} call budget exhausted`),
      };
    }

    const startedAt = (options.nowMs ?? Date.now)();
    try {
      const value = await attempt();
      notifyAttempt(options, {
        source,
        durationMs: elapsedMs(startedAt, options.nowMs),
        success: true,
        attempt: attemptNumber,
        error: null,
      });
      return { status: 'completed', value };
    } catch (error) {
      const upstreamError = typedError(source, error);
      notifyAttempt(options, {
        source,
        durationMs: elapsedMs(startedAt, options.nowMs),
        success: false,
        attempt: attemptNumber,
        error: safeAttemptError(upstreamError),
      });
      if (attemptNumber === 2 || !isRetryable(upstreamError)) {
        return { status: 'failed', error: upstreamError };
      }
    }
  }

  throw new Error('unreachable');
}

function elapsedMs(startedAt: number, nowMs: RetryOptions['nowMs']): number {
  return Math.max(0, Math.round((nowMs ?? Date.now)() - startedAt));
}

function notifyAttempt(options: RetryOptions, event: RetryAttemptEvent): void {
  try {
    options.onAttempt?.(event);
  } catch {
    // Ordinary logging must never change the upstream result or create another attempt.
  }
}
