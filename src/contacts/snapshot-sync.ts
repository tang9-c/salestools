import type { StoredContactSnapshot } from './contact-cache.js';
import type { GraphClient } from './graph-client.js';
import type { ContactSnapshotRepository } from '../db/contact-snapshot-repository.js';

interface SyncCursor {
  initialized: boolean;
  last_snapshot_id: number;
}

function graphSnapshot(snapshot: StoredContactSnapshot) {
  return {
    snapshot_id: snapshot.snapshotId,
    cache_key: snapshot.cacheKey,
    normalized_query: snapshot.normalizedQuery,
    normalized_region_hint: snapshot.normalizedRegionHint,
    collected_at: snapshot.payload.collected_at,
    stored_at: snapshot.storedAt,
    companies: snapshot.payload.companies,
  };
}

export class SnapshotSync {
  private running: Promise<void> | null = null;
  private requestedAgain = false;

  constructor(
    private readonly snapshots: Pick<ContactSnapshotRepository, 'findAfter'>,
    private readonly graph: GraphClient,
  ) {}

  async preview(limit: number): Promise<{ source_count: number; last_snapshot_id: number }> {
    const rows = this.snapshots.findAfter(0, limit);
    return {
      source_count: rows.length,
      last_snapshot_id: rows.at(-1)?.snapshotId ?? 0,
    };
  }

  cursor(): Promise<SyncCursor> {
    return this.graph.request<SyncCursor>('get_sync_cursor', {});
  }

  async initialize(): Promise<void> {
    await this.graph.request('sync_snapshots', {
      operation_id: 'snapshot-sync:initialize',
      actor: 'system',
      initialize: true,
      snapshots: [],
    });
  }

  async runBatch(limit: number): Promise<number> {
    const cursor = await this.cursor();
    if (!cursor.initialized) return 0;
    const rows = this.snapshots.findAfter(cursor.last_snapshot_id, limit);
    if (rows.length === 0) return 0;
    await this.graph.request('sync_snapshots', {
      operation_id: `snapshot-sync:${rows[0]!.snapshotId}-${rows.at(-1)!.snapshotId}`,
      actor: 'system',
      snapshots: rows.map(graphSnapshot),
    });
    return rows.length;
  }

  schedule(limit = 20): Promise<void> {
    if (this.running) {
      this.requestedAgain = true;
      return this.running;
    }
    const work = async () => {
      do {
        this.requestedAgain = false;
        while (await this.runBatch(limit) > 0) { /* drain current snapshots */ }
      } while (this.requestedAgain);
    };
    this.running = work().finally(() => { this.running = null; });
    return this.running;
  }
}
