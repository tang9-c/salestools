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

function typedError(source: UpstreamSource, error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  const message = error instanceof Error ? error.message : 'Unknown upstream failure';
  return new UpstreamError(source, 'UPSTREAM_FAILED', message, { cause: error });
}

export async function retryOnce<T>(
  source: UpstreamSource,
  budget: CallBudget,
  attempt: () => Promise<T>,
): Promise<RetryResult<T>> {
  for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
    if (!budget.tryConsume(source)) {
      return {
        status: 'failed',
        error: new UpstreamError(source, 'BUDGET_EXHAUSTED', `${source} call budget exhausted`),
      };
    }

    try {
      return { status: 'completed', value: await attempt() };
    } catch (error) {
      if (attemptNumber === 2) return { status: 'failed', error: typedError(source, error) };
    }
  }

  throw new Error('unreachable');
}
