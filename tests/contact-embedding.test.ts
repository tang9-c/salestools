import { describe, expect, it, vi } from 'vitest';
import { EmbeddingClient, EmbeddingError } from '../src/contacts/embedding-client.js';
import { VectorIndexer, buildEmbeddingText } from '../src/contacts/vector-indexer.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';

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

  it('uses the vision multimodal payload and reads its object-shaped embedding', async () => {
    const url = 'https://aigw.feigenbaum.com.cn/v1/embeddings';
    const model = 'doubao-embedding-vision-251215';
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(_url).toBe(url);
      expect(JSON.parse(String(init?.body))).toEqual({ model,
        input: [{ type: 'text', text: '联系人语义查询' }] });
      return Response.json({ model, data: { object: 'embedding', embedding: [0.25, -0.5, 1] } });
    });
    const client = new EmbeddingClient({ url, model, credential: 'secret', fetchFn: fetchFn as typeof fetch });
    expect(await client.embed('联系人语义查询')).toEqual({ model, vector: [0.25, -0.5, 1] });
  });

  it('accepts the gateway alias and reports the resolved model version', async () => {
    const client = new EmbeddingClient({ url: endpoint, model: 'embedding-vision', credential: 'secret',
      fetchFn: (async () => Response.json({ model: 'doubao-embedding-vision-251215',
        data: { object: 'embedding', embedding: [0.25, -0.5] } })) as typeof fetch });
    expect(await client.embed('联系人语义查询')).toEqual({
      model: 'doubao-embedding-vision-251215', vector: [0.25, -0.5],
    });
  });

  it('does not index an alias response without its resolved model version', async () => {
    const client = new EmbeddingClient({ url: endpoint, model: 'embedding-vision', credential: 'secret',
      fetchFn: (async () => Response.json({ data: { embedding: [0.25] } })) as typeof fetch });
    await expect(client.embed('联系人语义查询')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
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

class MemoryVectorGraph implements GraphClient {
  version = 1;
  indexContentVersion?: number;
  archived = false;
  state = 'unindexed';
  failNextPut = false;
  failedHold?: Promise<void>;
  readonly puts: Record<string, unknown>[] = [];
  readonly pendingWrites: Record<string, unknown>[] = [];
  readonly retryResults = new Map<string, Record<string, unknown>>();

  async request<T>(op: GraphOp, payload: unknown): Promise<T> {
    const input = payload as Record<string, unknown>;
    if (op === 'get_contact') {
      return (this.archived ? null : {
        entity: { entity_id: 'person-1', label: 'Person', properties: {
          name: '陈晓', description: '负责工业软件', email: ['private@example.cn'],
          hasOccupation: [{ name: '销售经理' }], hasCredential: [{ name: '工程师证书' }], skills: ['CAD'],
        }, metadata: { version: this.version } },
        relations: [{ relation_type: 'worksFor', source_id: 'person-1', target_id: 'org-1',
          properties: { role: { roleName: '销售总监' } } }], version: this.version,
        index_content_version: this.indexContentVersion,
        index_status: this.state,
      }) as T;
    }
    if (op === 'put_vector') {
      this.puts.push({ ...input });
      if (this.failNextPut) { this.failNextPut = false; throw new Error('response lost'); }
      if (input.content_version !== (this.indexContentVersion ?? this.version) || this.archived) {
        throw new Error('STALE_VERSION');
      }
      this.state = 'ready';
      return { entity_id: input.entity_id, index_status: 'ready' } as T;
    }
    if (op === 'set_vector_state') {
      if (input.action === 'recover_interrupted') {
        const recovered = this.state === 'pending' ? 1 : 0;
        if (recovered) this.state = 'failed';
        return { recovered, replayed: false } as T;
      }
      if (input.state === 'pending') {
        this.pendingWrites.push({ ...input });
        const prior = this.retryResults.get(String(input.operation_id));
        if (prior) return { ...prior, replayed: true } as T;
        if (input.actor === 'system') {
          if (!['unindexed', 'failed'].includes(this.state)
              || input.content_version !== (this.indexContentVersion ?? this.version)) {
            throw new Error('INVALID_INITIAL_INDEX');
          }
        } else if (this.state !== 'failed' || input.content_version !== (this.indexContentVersion ?? this.version)) {
          throw new Error('INVALID_RETRY');
        }
        this.state = 'pending';
        const result = { entity_id: input.entity_id, content_version: this.indexContentVersion ?? this.version,
          index_status: 'pending', replayed: false };
        this.retryResults.set(String(input.operation_id), result);
        return result as T;
      }
      if (input.content_version === (this.indexContentVersion ?? this.version)
          && !this.archived && this.state !== 'ready') this.state = 'failed';
      await this.failedHold;
      return { index_status: this.state } as T;
    }
    throw new Error(`unexpected ${op}`);
  }

  async close(): Promise<void> {}
}

describe('VectorIndexer', () => {
  it('stores the resolved version when the configured model is the gateway alias', async () => {
    const graph = new MemoryVectorGraph();
    const embedding = { embed: vi.fn(async () => ({ model: 'doubao-embedding-vision-251215',
      vector: [0.25, -0.5] })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embedding-vision' });
    expect(indexer.index('person-1', 1)).toBe(true);
    await indexer.whenIdle();
    expect(graph.puts[0]).toMatchObject({ model: 'doubao-embedding-vision-251215', dimension: 2 });
  });
  it('indexes asynchronously after a successful write with actual model and dimension', async () => {
    const graph = new MemoryVectorGraph();
    let finish!: (value: { model: string; vector: number[] }) => void;
    const embedding = { embed: vi.fn(() => new Promise<{ model: string; vector: number[] }>(resolve => { finish = resolve; })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    expect(indexer.index('person-1', 1)).toBe(true);
    await vi.waitFor(() => expect(embedding.embed).toHaveBeenCalledOnce());
    expect(graph.state).toBe('pending');
    expect(graph.pendingWrites).toEqual([{ action: 'set', operation_id: 'vector-pending:person-1:1:embed-v1',
      actor: 'system', entity_id: 'person-1', content_version: 1, state: 'pending' }]);
    expect(graph.puts).toEqual([]);
    finish({ model: 'embed-v1', vector: [0.25, -0.5] });
    await indexer.whenIdle();
    expect(graph.puts).toEqual([{ operation_id: 'vector:person-1:1:embed-v1', actor: 'system',
      entity_id: 'person-1', content_version: 1, model: 'embed-v1', dimension: 2, vector: [0.25, -0.5] }]);
    expect(graph.pendingWrites).toEqual([{ action: 'set', operation_id: 'vector-pending:person-1:1:embed-v1',
      actor: 'system', entity_id: 'person-1', content_version: 1, state: 'pending' }]);
    expect(graph.state).toBe('ready');
  });

  it('marks a failed attempt and retries only after an explicit actor operation', async () => {
    const graph = new MemoryVectorGraph();
    const embedding = { embed: vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ model: 'embed-v1', vector: [1] }) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    indexer.index('person-1', 1);
    await indexer.whenIdle();
    expect(graph.state).toBe('failed');
    expect(graph.puts).toEqual([]);
    expect(await indexer.retryFailed('person-1', 'retry-1', 'sales-a')).toEqual({
      entity_id: 'person-1', content_version: 1, index_status: 'pending', replayed: false,
    });
    await indexer.whenIdle();
    expect(graph.state).toBe('ready');
    expect(await indexer.retryFailed('person-1', 'retry-1', 'sales-a')).toMatchObject({ replayed: true });
    expect(embedding.embed).toHaveBeenCalledTimes(2);
  });

  it('replays the same acceptance after the contact is archived in this process', async () => {
    const graph = new MemoryVectorGraph();
    graph.state = 'failed';
    const embedding = { embed: vi.fn(async () => ({ model: 'embed-v1', vector: [1] })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    const first = await indexer.retryFailed('person-1', 'retry-archived', 'sales-a');
    graph.archived = true;
    const replay = await indexer.retryFailed('person-1', 'retry-archived', 'sales-a');
    expect(replay).toEqual({ ...first, replayed: true });
    await indexer.whenIdle();
    expect(graph.puts).toEqual([]);
  });

  it('resumes an interrupted retry after restart when the same operation ID is replayed', async () => {
    const graph = new MemoryVectorGraph();
    graph.state = 'failed';
    const oldEmbedding = { embed: vi.fn(() => new Promise<{ model: string; vector: number[] }>(() => undefined)) };
    const beforeRestart = new VectorIndexer({ graph, embedding: oldEmbedding, model: 'embed-v1' });
    const accepted = await beforeRestart.retryFailed('person-1', 'retry-after-crash', 'sales-a');
    await vi.waitFor(() => expect(oldEmbedding.embed).toHaveBeenCalledOnce());
    expect(graph.state).toBe('pending');

    // The old process is gone; startup recovery marks its pending graph row failed.
    expect(await graph.request('set_vector_state', { action: 'recover_interrupted', actor: 'system',
      operation_id: 'recover-after-crash' })).toEqual({ recovered: 1, replayed: false });
    expect(graph.state).toBe('failed');
    const resumedEmbedding = { embed: vi.fn(async () => ({ model: 'embed-v1', vector: [0.75, 0.25] })) };
    const afterRestart = new VectorIndexer({ graph, embedding: resumedEmbedding, model: 'embed-v1' });
    const replay = await afterRestart.retryFailed('person-1', 'retry-after-crash', 'sales-a');
    expect(replay).toEqual({ ...accepted, replayed: true });
    await afterRestart.whenIdle();
    expect(graph.state).toBe('ready');
    expect(graph.puts).toHaveLength(1);
    expect(graph.puts[0]?.vector).toEqual([0.75, 0.25]);
    expect(resumedEmbedding.embed).toHaveBeenCalledOnce();
    expect(graph.pendingWrites.map(write => write.operation_id)).toEqual([
      'retry-after-crash', 'retry-after-crash', expect.stringMatching(/^vector-resume:person-1:1:/u),
    ]);
  });

  it('queues a retry accepted while the failed attempt is still unwinding', async () => {
    const graph = new MemoryVectorGraph();
    let releaseFailure!: () => void;
    graph.failedHold = new Promise<void>(resolve => { releaseFailure = resolve; });
    const embedding = { embed: vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ model: 'embed-v1', vector: [1] }) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    indexer.index('person-1', 1);
    await vi.waitFor(() => expect(graph.state).toBe('failed'));
    await indexer.retryFailed('person-1', 'retry-race', 'sales-a');
    releaseFailure();
    await indexer.whenIdle();
    expect(graph.state).toBe('ready');
    expect(embedding.embed).toHaveBeenCalledTimes(2);
  });

  it('drops a stale result after an edit and never writes it to the graph', async () => {
    const graph = new MemoryVectorGraph();
    let finish!: (value: { model: string; vector: number[] }) => void;
    const embedding = { embed: () => new Promise<{ model: string; vector: number[] }>(resolve => { finish = resolve; }) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    indexer.index('person-1', 1);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    graph.version = 2;
    finish({ model: 'embed-v1', vector: [1] });
    await indexer.whenIdle();
    expect(graph.puts).toEqual([]);
  });

  it('uses independent index content version when a role changes without an entity edit', async () => {
    const graph = new MemoryVectorGraph();
    graph.indexContentVersion = 2;
    const embedding = { embed: vi.fn(async () => ({ model: 'embed-v1', vector: [1] })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    indexer.index('person-1', 2);
    await indexer.whenIdle();
    expect(graph.state).toBe('ready');
    expect(graph.puts[0]?.content_version).toBe(2);
    expect(graph.pendingWrites[0]?.content_version).toBe(2);
  });

  it('retries the current role version even when entity metadata version is older', async () => {
    const graph = new MemoryVectorGraph();
    graph.indexContentVersion = 2;
    graph.state = 'failed';
    const embedding = { embed: vi.fn(async () => ({ model: 'embed-v1', vector: [1] })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    const result = await indexer.retryFailed('person-1', 'retry-role-2', 'sales-a');
    expect(result.content_version).toBe(2);
    await indexer.whenIdle();
    expect(graph.state).toBe('ready');
    expect(graph.pendingWrites).toHaveLength(1);
    expect(graph.pendingWrites[0]?.actor).toBe('sales-a');
  });

  it('reuses the identical vector payload after a lost write response', async () => {
    const graph = new MemoryVectorGraph();
    graph.failNextPut = true;
    const embedding = { embed: vi.fn(async () => ({ model: 'embed-v1', vector: [1, 2, 3] })) };
    const indexer = new VectorIndexer({ graph, embedding, model: 'embed-v1' });
    indexer.index('person-1', 1);
    await indexer.whenIdle();
    expect(graph.state).toBe('failed');
    await indexer.retryFailed('person-1', 'retry-lost-1', 'sales-a');
    await indexer.whenIdle();
    expect(graph.puts).toHaveLength(2);
    expect(graph.puts[1]).toEqual(graph.puts[0]);
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(graph.state).toBe('ready');
  });

  it('embeds only approved descriptive fields and role facts', () => {
    const text = buildEmbeddingText({ entity: { entity_id: 'person-1', label: 'Person',
      properties: { name: '陈晓', description: '联系 private@example.cn 或 wx-private，负责 CAD',
        email: ['private@example.cn'], telephone: ['13800138000'],
        contactPoint: [{ telephone: ['12345678'] }], skills: ['CAD'],
        hasOccupation: [{ name: '工程师' }], hasCredential: [{ name: '工程师证书' }],
      }, extensions: { instantMessaging: [{ platform: 'wechat', accountId: 'wx-private' }] } },
    relations: [{ relation_type: 'worksFor', source_id: 'person-1',
        properties: { role: { roleName: '主管' } } }] });
    expect(text).toContain('陈晓');
    expect(text).toContain('CAD');
    expect(text).toContain('工程师证书');
    expect(text).toContain('主管');
    expect(text).not.toMatch(/private@example\.cn|13800138000|12345678|wx-private/u);
  });
});
