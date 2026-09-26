export interface EmbeddingClientOptions {
  url: string;
  model: string;
  credential: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface EmbeddingResult {
  model: string;
  vector: number[];
}

export function embeddingModelCompatible(configured: string, actual: string): boolean {
  return configured === actual || configured === 'embedding-vision'
    && /^doubao-embedding-vision-\d{6}$/u.test(actual);
}

export class EmbeddingError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'ABORTED' | 'TIMEOUT' | 'NETWORK_ERROR'
    | 'REMOTE_HTTP_ERROR' | 'INVALID_RESPONSE', options?: ErrorOptions) {
    super(code, options);
    this.name = 'EmbeddingError';
  }
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class EmbeddingClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: EmbeddingClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!text.trim()) throw new EmbeddingError('INVALID_INPUT');
    if (signal?.aborted) throw new EmbeddingError('ABORTED');
    const multimodal = /(?:^|[-/])embedding-vision(?:-|$)/iu.test(this.options.model);

    const timeoutSignal = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await bounded(this.fetchFn(this.options.url, {
        method: 'POST',
        signal: requestSignal,
        headers: {
          Authorization: `Bearer ${this.options.credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.options.model,
          input: multimodal ? [{ type: 'text', text }] : text }),
      }), requestSignal);
    } catch (error) {
      throw new EmbeddingError(signal?.aborted ? 'ABORTED' : timeoutSignal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        { cause: error });
    }
    if (!response.ok) throw new EmbeddingError('REMOTE_HTTP_ERROR');

    let payload: unknown;
    try { payload = await bounded(response.json(), requestSignal); }
    catch (error) {
      throw new EmbeddingError(signal?.aborted ? 'ABORTED' : timeoutSignal.aborted ? 'TIMEOUT' : 'INVALID_RESPONSE',
        { cause: error });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new EmbeddingError('INVALID_RESPONSE');
    }
    const envelope = payload as Record<string, unknown>;
    if (this.options.model === 'embedding-vision' && typeof envelope.model !== 'string') {
      throw new EmbeddingError('INVALID_RESPONSE');
    }
    const actualModel = typeof envelope.model === 'string' ? envelope.model : this.options.model;
    if (!embeddingModelCompatible(this.options.model, actualModel)) {
      throw new EmbeddingError('INVALID_RESPONSE');
    }
    const data = envelope.data;
    const item = Array.isArray(data) ? data[0]
      : multimodal && data && typeof data === 'object' ? data : undefined;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EmbeddingError('INVALID_RESPONSE');
    }
    const vector: unknown = (item as Record<string, unknown>).embedding;
    if (!Array.isArray(vector) || vector.length === 0
        || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new EmbeddingError('INVALID_RESPONSE');
    }
    return { model: actualModel, vector: [...vector] as number[] };
  }
}
