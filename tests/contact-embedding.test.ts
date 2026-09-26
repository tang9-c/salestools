import { describe, expect, it, vi } from 'vitest';
import { EmbeddingClient, EmbeddingError } from '../src/contacts/embedding-client.js';

const endpoint = 'https://embedding.example.cn/api/v3/embeddings';

describe('EmbeddingClient', () => {
  it('posts only to its configured endpoint and returns the measured vector', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(_url).toBe(endpoint);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer embedding-secret',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'embed-v1', input: '确认的姓名与职业' });
      return Response.json({ model: 'embed-v1', data: [{ index: 0, embedding: [0.25, -0.5, 1] }] });
    });
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'embedding-secret',
      fetchFn: fetchFn as typeof fetch });

    expect(await client.embed('确认的姓名与职业')).toEqual({ model: 'embed-v1', vector: [0.25, -0.5, 1] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { body: { data: [{ embedding: [] }] }, name: 'empty vector' },
    { body: { data: [{ embedding: [0.1, '0.2'] }] }, name: 'non-number' },
    { body: { data: [{ embedding: [Number.POSITIVE_INFINITY] }] }, name: 'nonfinite number' },
    { body: { data: [] }, name: 'missing vector' },
    { body: { model: 'different-model', data: [{ embedding: [1] }] }, name: 'mismatched model' },
  ])('rejects $name without returning a mislabeled embedding', async ({ body }) => {
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'secret',
      fetchFn: (async () => Response.json(body)) as typeof fetch });
    await expect(client.embed('confirmed fact')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('classifies HTTP failures and does not retry within the client', async () => {
    const fetchFn = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'secret',
      fetchFn: fetchFn as typeof fetch });
    await expect(client.embed('confirmed fact')).rejects.toMatchObject({ code: 'REMOTE_HTTP_ERROR' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled request and propagates caller cancellation', async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'secret',
      requestTimeoutMs: 10, fetchFn: fetchFn as typeof fetch });
    await expect(client.embed('confirmed fact')).rejects.toMatchObject({ code: 'TIMEOUT' });
    const caller = new AbortController();
    caller.abort();
    await expect(client.embed('confirmed fact', caller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('also bounds a stalled response body', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true,
      json: () => new Promise<unknown>(() => undefined) }) as Response);
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'secret',
      requestTimeoutMs: 10, fetchFn: fetchFn as typeof fetch });
    await expect(client.embed('confirmed fact')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects empty input before any network request', async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [{ embedding: [1] }] }));
    const client = new EmbeddingClient({ url: endpoint, model: 'embed-v1', credential: 'secret',
      fetchFn: fetchFn as typeof fetch });
    await expect(client.embed('  ')).rejects.toBeInstanceOf(EmbeddingError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
