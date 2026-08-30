import type { RetryAttemptEvent } from '../orchestration/retry.js';

export interface LogSink {
  write(line: string): void;
}

export type UpstreamAttemptLog = RetryAttemptEvent & Readonly<{
  assessmentId: string;
  userId: string;
}>;

const BEARER_PATTERN = /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/giu;

function safeMessage(message: string): string {
  return message.replace(BEARER_PATTERN, '$1[REDACTED]');
}

export class JsonlLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  logUpstreamAttempt(event: UpstreamAttemptLog): void {
    const line = {
      event: 'upstream_attempt',
      timestamp: this.now().toISOString(),
      assessment_id: event.assessmentId,
      user_id: event.userId,
      source: event.source,
      duration_ms: event.durationMs,
      success: event.success,
      attempt: event.attempt,
      error: event.error === null ? null : {
        code: event.error.code,
        message: safeMessage(event.error.message),
      },
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }
}
