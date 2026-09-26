import { randomUUID } from 'node:crypto';
import type { GraphClient } from './graph-client.js';
import type { EmbeddingClient, EmbeddingResult } from './embedding-client.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function textItems(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => text(item) ?? []) : [];
}

/** Select only formal descriptive fields; contact values never enter the embedding request. */
export function buildEmbeddingText(snapshot: unknown): string {
  const root = record(snapshot);
  const entity = record(root.entity);
  const properties = record(entity.properties);
  const privateValues = [
    ...textItems(properties.email), ...textItems(properties.telephone),
    ...textItems(properties.faxNumber),
  ];
  const address = text(properties.address);
  if (address) privateValues.push(address);
  for (const point of Array.isArray(properties.contactPoint) ? properties.contactPoint : []) {
    const contact = record(point);
    privateValues.push(...textItems(contact.email), ...textItems(contact.telephone));
    const url = text(contact.url);
    if (url) privateValues.push(url);
  }
  for (const account of Array.isArray(record(entity.extensions).instantMessaging)
    ? record(entity.extensions).instantMessaging as unknown[] : []) {
    const accountId = text(record(account).accountId);
    if (accountId) privateValues.push(accountId);
  }
  const scrub = (value: string): string => {
    let result = value;
    for (const secret of privateValues) result = result.replaceAll(secret, '');
    return result.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '')
      .replace(/(?<!\d)\+?\d[\d\s()-]{6,}\d(?!\d)/gu, '').trim();
  };
  const selected: string[] = [];
  const add = (value: unknown) => {
    const candidate = text(value);
    if (candidate) {
      const clean = scrub(candidate);
      if (clean) selected.push(clean);
    }
  };
  add(properties.name);
  add(properties.description);
  add(properties.jobTitle);
  for (const skill of textItems(properties.skills)) add(skill);
  for (const occupation of Array.isArray(properties.hasOccupation) ? properties.hasOccupation : []) {
    add(record(occupation).name);
    add(record(occupation).description);
  }
  for (const credential of Array.isArray(properties.hasCredential) ? properties.hasCredential : []) {
    add(record(credential).name);
    add(record(credential).credentialCategory);
  }
  for (const relation of Array.isArray(root.relations) ? root.relations : []) {
    const fact = record(relation);
    if (fact.relation_type === 'worksFor' && fact.source_id === entity.entity_id) {
      add(record(record(fact.properties).role).roleName);
    }
  }
  return [...new Set(selected)].join('\n');
}

interface ContactSnapshot {
  entity?: { metadata?: { version?: number } };
  version?: number;
}

interface VectorPayload {
  operation_id: string;
  actor: 'system';
  entity_id: string;
  content_version: number;
  model: string;
  dimension: number;
  vector: number[];
}

interface Work { entityId: string; contentVersion: number; key: string }

export interface VectorIndexerOptions {
  graph: GraphClient;
  embedding: Pick<EmbeddingClient, 'embed'>;
  model: string;
  concurrency?: number;
  maxPending?: number;
}

export class VectorIndexer {
  private readonly queue: Work[] = [];
  private readonly scheduled = new Set<string>();
  private readonly reschedule = new Set<string>();
  private readonly retained = new Map<string, VectorPayload>();
  private readonly retryPayloads = new Map<string, { entityId: string; version: number }>();
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;
  private background = 0;

  constructor(private readonly options: VectorIndexerOptions) {
    if (!options.model.trim() || !Number.isInteger(options.concurrency ?? 1)
        || (options.concurrency ?? 1) < 1 || !Number.isInteger(options.maxPending ?? 32)
        || (options.maxPending ?? 32) < 1) throw new Error('INVALID_VECTOR_INDEXER_CONFIG');
  }

  /** Queue after the primary graph transaction commits; this method never waits for the model. */
  index(entityId: string, contentVersion: number): boolean {
    if (!entityId.trim() || !Number.isInteger(contentVersion) || contentVersion < 1) return false;
    const key = `${entityId}\0${contentVersion}\0${this.options.model}`;
    if (this.scheduled.has(key)) return true;
    if (this.queue.length + this.active >= (this.options.maxPending ?? 32)) {
      this.background += 1;
      void this.markFailed(entityId, contentVersion).finally(() => {
        this.background -= 1;
        this.resolveIdle();
      });
      return false;
    }
    this.scheduled.add(key);
    this.queue.push({ entityId, contentVersion, key });
    queueMicrotask(() => this.pump());
    return true;
  }

  async retryFailed(entityId: string, operationId: string, actor: string): Promise<{
    entity_id: string; content_version: number; index_status: 'pending'; replayed: boolean;
  }> {
    if (!entityId.trim() || !operationId.trim() || !actor.trim()) throw new Error('INVALID_RETRY_REQUEST');
    const retryKey = `${actor}\0${operationId}`;
    const prior = this.retryPayloads.get(retryKey);
    if (prior && prior.entityId !== entityId) throw new Error('OPERATION_CONFLICT');
    if (!prior && this.queue.length + this.active >= (this.options.maxPending ?? 32)) {
      throw new Error('INDEX_QUEUE_FULL');
    }
    const snapshot = prior ? null
      : await this.options.graph.request<ContactSnapshot | null>('get_contact', { entity_id: entityId });
    const version = prior?.version ?? snapshot?.version ?? snapshot?.entity?.metadata?.version;
    if (!Number.isInteger(version) || !version || version < 1) throw new Error('CONTACT_NOT_FOUND');
    const result = await this.options.graph.request<{
      entity_id: string; content_version: number; index_status: 'pending'; replayed: boolean;
    }>('set_vector_state', { action: 'set', operation_id: operationId, actor,
      entity_id: entityId, content_version: version, state: 'pending' });
    if (result.entity_id !== entityId || result.content_version !== version
        || result.index_status !== 'pending' || typeof result.replayed !== 'boolean') {
      throw new Error('INVALID_GRAPH_RESPONSE');
    }
    this.retryPayloads.set(retryKey, { entityId, version });
    if (!result.replayed) {
      const key = `${entityId}\0${version}\0${this.options.model}`;
      if (this.scheduled.has(key)) this.reschedule.add(key);
      else this.index(entityId, version);
    }
    return result;
  }

  whenIdle(): Promise<void> {
    if (!this.queue.length && !this.active && !this.background) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  private resolveIdle(): void {
    if (this.queue.length || this.active || this.background) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private pump(): void {
    while (this.active < (this.options.concurrency ?? 1) && this.queue.length) {
      const work = this.queue.shift()!;
      this.active += 1;
      void this.run(work).finally(() => {
        this.active -= 1;
        this.scheduled.delete(work.key);
        if (this.reschedule.delete(work.key)) this.index(work.entityId, work.contentVersion);
        this.pump();
        this.resolveIdle();
      });
    }
  }

  private async current(entityId: string, contentVersion: number): Promise<unknown | null> {
    const snapshot = await this.options.graph.request<ContactSnapshot | null>('get_contact', { entity_id: entityId });
    const version = snapshot?.version ?? snapshot?.entity?.metadata?.version;
    return version === contentVersion ? snapshot : null;
  }

  private async run(work: Work): Promise<void> {
    try {
      const snapshot = await this.current(work.entityId, work.contentVersion);
      if (!snapshot) { this.retained.delete(work.key); return; }
      let payload = this.retained.get(work.key);
      if (!payload) {
        const input = buildEmbeddingText(snapshot);
        if (!input) throw new Error('EMPTY_EMBEDDING_INPUT');
        const result: EmbeddingResult = await this.options.embedding.embed(input);
        if (result.model !== this.options.model || !Array.isArray(result.vector) || !result.vector.length
            || !result.vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
          throw new Error('INVALID_EMBEDDING');
        }
        payload = { operation_id: `vector:${work.entityId}:${work.contentVersion}:${result.model}`,
          actor: 'system', entity_id: work.entityId, content_version: work.contentVersion,
          model: result.model, dimension: result.vector.length, vector: [...result.vector] };
        this.retained.set(work.key, payload);
      }
      if (!await this.current(work.entityId, work.contentVersion)) {
        this.retained.delete(work.key);
        return;
      }
      await this.options.graph.request('put_vector', payload);
      this.retained.delete(work.key);
    } catch {
      await this.markFailed(work.entityId, work.contentVersion);
    }
  }

  private async markFailed(entityId: string, contentVersion: number): Promise<void> {
    try {
      await this.options.graph.request('set_vector_state', {
        action: 'set', operation_id: `vector-failed:${entityId}:${contentVersion}:${randomUUID()}`,
        actor: 'system', entity_id: entityId, content_version: contentVersion, state: 'failed',
      });
    } catch { /* A graph outage is recovered by the startup recover_interrupted operation. */ }
  }
}
