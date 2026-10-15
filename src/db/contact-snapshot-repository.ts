import type { DatabaseSync } from 'node:sqlite';
import {
  ContactSnapshotPayloadSchema,
  UtcTimestampSchema,
  type ContactSnapshotPayload,
} from '../contracts/index.js';
import type { StoredContactSnapshot } from '../contacts/contact-cache.js';

const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;

interface ContactSnapshotRow {
  snapshot_id: number;
  cache_key: string;
  normalized_query: string;
  normalized_region_hint: string | null;
  result_json: string;
  collected_at: string;
  stored_at: string;
}

export interface AppendContactSnapshotInput {
  cacheKey: string;
  normalizedQuery: string;
  normalizedRegionHint: string | null;
  payload: ContactSnapshotPayload;
  storedAt: string;
}

export interface ContactSnapshotStore {
  append(input: AppendContactSnapshotInput): void;
  findFresh(cacheKey: string, now: Date, ttlDays: number): StoredContactSnapshot | null;
  findLatest(cacheKey: string): StoredContactSnapshot | null;
  findAll(cacheKey: string): StoredContactSnapshot[];
  findThroughSnapshot(cacheKey: string, snapshotId: number): StoredContactSnapshot[] | null;
}

export class ContactSnapshotDataError extends Error {
  override readonly name = 'ContactSnapshotDataError';

  constructor(snapshotId: number, options?: ErrorOptions) {
    super(`Invalid stored contact snapshot ${snapshotId}`, options);
  }
}

function validateCacheKey(cacheKey: string): string {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) throw new Error('Invalid contact cache key');
  return cacheKey;
}

function ttlCutoff(now: Date, ttlDays: number): string {
  return new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
}

function toStoredSnapshot(row: ContactSnapshotRow): StoredContactSnapshot {
  try {
    const payload = ContactSnapshotPayloadSchema.parse(JSON.parse(row.result_json));
    const storedAt = UtcTimestampSchema.parse(row.stored_at);
    if (!CACHE_KEY_PATTERN.test(row.cache_key)
      || row.normalized_query.length === 0
      || payload.collected_at !== UtcTimestampSchema.parse(row.collected_at)) {
      throw new Error('Stored contact snapshot metadata mismatch');
    }
    return {
      snapshotId: row.snapshot_id,
      cacheKey: row.cache_key,
      normalizedQuery: row.normalized_query,
      normalizedRegionHint: row.normalized_region_hint,
      payload,
      storedAt,
    };
  } catch (error) {
    throw new ContactSnapshotDataError(row.snapshot_id, { cause: error });
  }
}

export class ContactSnapshotRepository implements ContactSnapshotStore {
  constructor(private readonly database: DatabaseSync) {}

  findThroughSnapshot(cacheKey: string, snapshotId: number): StoredContactSnapshot[] | null {
    if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) throw new Error('Invalid contact snapshot ID');
    const rows = this.database.prepare(`SELECT snapshot_id, cache_key, normalized_query, normalized_region_hint,
      result_json, collected_at, stored_at FROM contact_query_snapshots
      WHERE cache_key = ? AND snapshot_id <= ? ORDER BY stored_at ASC, snapshot_id ASC`)
      .all(validateCacheKey(cacheKey), snapshotId) as unknown as ContactSnapshotRow[];
    return rows.some(row => row.snapshot_id === snapshotId) ? rows.map(toStoredSnapshot) : null;
  }

  append(input: AppendContactSnapshotInput): void {
    const cacheKey = validateCacheKey(input.cacheKey);
    if (input.normalizedQuery.length === 0) throw new Error('Normalized contact query is required');
    const payload = ContactSnapshotPayloadSchema.parse(input.payload);
    const storedAt = UtcTimestampSchema.parse(input.storedAt);
    this.database.prepare(`
      INSERT INTO contact_query_snapshots (
        cache_key, normalized_query, normalized_region_hint,
        result_json, collected_at, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      cacheKey,
      input.normalizedQuery,
      input.normalizedRegionHint,
      JSON.stringify(payload),
      payload.collected_at,
      storedAt,
    );
  }

  findFresh(cacheKey: string, now: Date, ttlDays: number): StoredContactSnapshot | null {
    const row = this.database.prepare(`
      SELECT snapshot_id, cache_key, normalized_query, normalized_region_hint,
             result_json, collected_at, stored_at
      FROM contact_query_snapshots
      WHERE cache_key = ? AND stored_at >= ?
      ORDER BY stored_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(validateCacheKey(cacheKey), ttlCutoff(now, ttlDays)) as unknown as ContactSnapshotRow | undefined;
    return row === undefined ? null : toStoredSnapshot(row);
  }

  findLatest(cacheKey: string): StoredContactSnapshot | null {
    const row = this.database.prepare(`
      SELECT snapshot_id, cache_key, normalized_query, normalized_region_hint,
             result_json, collected_at, stored_at
      FROM contact_query_snapshots
      WHERE cache_key = ?
      ORDER BY stored_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(validateCacheKey(cacheKey)) as unknown as ContactSnapshotRow | undefined;
    return row === undefined ? null : toStoredSnapshot(row);
  }

  findAll(cacheKey: string): StoredContactSnapshot[] {
    const rows = this.database.prepare(`
      SELECT snapshot_id, cache_key, normalized_query, normalized_region_hint,
             result_json, collected_at, stored_at
      FROM contact_query_snapshots
      WHERE cache_key = ?
      ORDER BY stored_at ASC, snapshot_id ASC
    `).all(validateCacheKey(cacheKey)) as unknown as ContactSnapshotRow[];
    return rows.map(toStoredSnapshot);
  }

  findAfter(snapshotId: number, limit: number): StoredContactSnapshot[] {
    if (!Number.isSafeInteger(snapshotId) || snapshotId < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid snapshot cursor or batch size');
    }
    const rows = this.database.prepare(`
      SELECT snapshot_id, cache_key, normalized_query, normalized_region_hint,
             result_json, collected_at, stored_at
      FROM contact_query_snapshots
      WHERE snapshot_id > ?
      ORDER BY snapshot_id ASC
      LIMIT ?
    `).all(snapshotId, limit) as unknown as ContactSnapshotRow[];
    return rows.map(toStoredSnapshot);
  }
}
