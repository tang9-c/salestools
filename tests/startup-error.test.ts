import { describe, expect, it } from 'vitest';
import { formatStartupFailure } from '../src/startup-error.js';

describe('startup failure logging', () => {
  it('includes the error type and message without a stack trace', () => {
    const error = new Error('Invalid configuration: CONTACT_GRAPH_BIN');

    expect(formatStartupFailure(error)).toBe(
      'Application startup failed: Error: Invalid configuration: CONTACT_GRAPH_BIN\n',
    );
  });

  it('does not serialize unknown values that may contain sensitive data', () => {
    expect(formatStartupFailure({ message: 'secret-token' })).toBe(
      'Application startup failed: Unknown error\n',
    );
  });
});
