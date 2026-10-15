import type { StoredContactSnapshot } from './contact-cache.js';
import type { GraphClient } from './graph-client.js';
import type { ContactSnapshotRepository } from '../db/contact-snapshot-repository.js';

interface SyncCursor {
  initialized: boolean;
  last_snapshot_id: number;
}

const maxSafeFrameBytes = 256 * 1024 - 128;

export class SnapshotSyncFrameError extends Error {
  readonly code = 'SNAPSHOT_FRAME_TOO_LARGE';

  constructor(readonly snapshotId: number) {
    super(`Snapshot ${snapshotId} exceeds the graph request frame limit`);
    this.name = 'SnapshotSyncFrameError';
  }
}

interface SnapshotSyncRejection {
  code: 'SNAPSHOT_SYNC_REJECTED';
  firstSnapshotId: number;
  lastSnapshotId: number;
}
type SnapshotSyncFailure = SnapshotSyncFrameError | SnapshotSyncRejection;

function graphSnapshot(snapshot: StoredContactSnapshot) {
  return {
    snapshot_id: snapshot.snapshotId,
    cache_key: snapshot.cacheKey,
    normalized_query: snapshot.normalizedQuery,
    normalized_region_hint: snapshot.normalizedRegionHint,
    collected_at: snapshot.payload.collected_at,
    stored_at: snapshot.storedAt,
    // Preserve the full quote: Rust uses it as part of the stable observation identity.
    companies: snapshot.payload.companies,
  };
}

export class SnapshotSync {
  private running: Promise<void> | null = null;
  private requestedAgain = false;
  private failure: SnapshotSyncFailure | null = null;

  constructor(
    private readonly snapshots: Pick<ContactSnapshotRepository, 'findAfter'>,
    private readonly graph: GraphClient,
    private readonly reportFailure: (failure: SnapshotSyncFailure) => void =
      failure => { process.stderr.write(failure instanceof SnapshotSyncFrameError
        ? `${failure.code} snapshot_id=${failure.snapshotId}\n`
        : `${failure.code} snapshot_ids=${failure.firstSnapshotId}-${failure.lastSnapshotId}\n`); },
  ) {}

  get lastFailure(): SnapshotSyncFailure | null {
    return this.failure;
  }

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
    const selected: ReturnType<typeof graphSnapshot>[] = [];
    for (const row of rows) {
      const snapshot = graphSnapshot(row);
      const candidate = {
        operation_id: `snapshot-sync:${rows[0]!.snapshotId}-${row.snapshotId}`,
        actor: 'system' as const,
        snapshots: [...selected, snapshot],
      };
      const frame = `${JSON.stringify({
        version: 1, request_id: 'g_99999999999999999999', op: 'sync_snapshots', payload: candidate,
      })}\n`;
      if (Buffer.byteLength(frame, 'utf8') > maxSafeFrameBytes) {
        if (selected.length === 0) {
          this.failure = new SnapshotSyncFrameError(row.snapshotId);
          throw this.failure;
        }
        break;
      }
      selected.push(snapshot);
    }
    const payload = {
      operation_id: `snapshot-sync:${rows[0]!.snapshotId}-${selected.at(-1)!.snapshot_id}`,
      actor: 'system' as const,
      snapshots: selected,
    };
    try {
      await this.graph.request('sync_snapshots', payload);
    } catch (error) {
      this.failure = { code: 'SNAPSHOT_SYNC_REJECTED', firstSnapshotId: selected[0]!.snapshot_id,
        lastSnapshotId: selected.at(-1)!.snapshot_id };
      try { this.reportFailure(this.failure); } catch { /* Keep the original sync failure. */ }
      throw error;
    }
    this.failure = null;
    return selected.length;
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
    this.running = work().catch(error => {
      if (error instanceof SnapshotSyncFrameError) {
        try { this.reportFailure(error); } catch { /* Keep the original sync failure. */ }
      }
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }
}
