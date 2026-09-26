import { z } from 'zod';

const Envelope = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }).passthrough() }).passthrough()).min(1),
}).passthrough();

export class ArkTransportError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArkTransportError';
  }
}

export interface ArkJsonRequestOptions {
  url: string; credential: string; body: string; fetchFn: typeof fetch;
  signal?: AbortSignal; timeoutMs?: number; context?: string;
}

/** Shared chat transport; callers own request serialization, byte budget and semantic validation. */
export async function requestArkJsonContent(options: ArkJsonRequestOptions): Promise<string> {
  const context = options.context ?? 'Ark';
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await options.fetchFn(options.url, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${options.credential}`, 'Content-Type': 'application/json' },
      body: options.body,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ArkTransportError('ABORTED', `${context} request aborted`, undefined, { cause: error });
    if (timeout.aborted) throw new ArkTransportError('TIMEOUT', `${context} request timed out`, undefined, { cause: error });
    throw new ArkTransportError('NETWORK_ERROR', `${context} request failed`, undefined, { cause: error });
  }
  if (!response.ok) throw new ArkTransportError('REMOTE_HTTP_ERROR', `${context} HTTP ${response.status}`, response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (options.signal?.aborted) throw new ArkTransportError('ABORTED', `${context} request aborted`, undefined, { cause: error });
    if (timeout.aborted) throw new ArkTransportError('TIMEOUT', `${context} request timed out`, undefined, { cause: error });
    throw new ArkTransportError('INVALID_RESPONSE', `${context} returned an invalid API response`, undefined, { cause: error });
  }
  const parsed = Envelope.safeParse(payload);
  if (!parsed.success) {
    throw new ArkTransportError('INVALID_RESPONSE', `${context} response has no model content`, undefined, { cause: parsed.error });
  }
  return parsed.data.choices[0].message.content;
}
