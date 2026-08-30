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
        error: { code: upstreamError.code, message: upstreamError.message },
      });
      if (attemptNumber === 2) return { status: 'failed', error: upstreamError };
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
