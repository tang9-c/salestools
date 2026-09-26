import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SnapshotSync } from '../src/contacts/snapshot-sync.js';
import { runContactSync } from '../src/cli/contact-sync.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import { ContactSnapshotRepository } from '../src/db/contact-snapshot-repository.js';
import { initializeDatabase } from '../src/db/database.js';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

function fixture() {
  const database = initializeDatabase(new DatabaseSync(':memory:'));
  databases.push(database);
  const snapshots = new ContactSnapshotRepository(database);
  const cacheKey = 'a'.repeat(64);
  for (const [index, title] of ['总监', '总监', '经理'].entries()) {
    snapshots.append({
      cacheKey,
      normalizedQuery: '甲公司',
      normalizedRegionHint: null,
      payload: {
        companies: [{
          company_name: '甲公司',
          contacts: [{
            name: '张明', title, source_url: `https://example.com/${index}`, published_at: null,
          }],
        }],
        warnings: [],
        collected_at: `2026-09-2${index + 1}T00:00:00.000Z`,
      },
      storedAt: `2026-09-2${index + 1}T00:00:00.000Z`,
    });
  }
  return snapshots;
}

it('previews without sending any graph request', async () => {
  const snapshots = fixture();
  const graph: GraphClient = {
    request: async () => { throw new Error('preview must not touch graph'); },
    close: async () => {},
  };
  const sync = new SnapshotSync(snapshots, graph);
  await expect(sync.preview(2)).resolves.toEqual({ source_count: 2, last_snapshot_id: 2 });
});

it('reads the Rust cursor for every batch and uses stable batch operation IDs', async () => {
  const snapshots = fixture();
  let lastSnapshotId = 0;
  const calls: Array<{ op: GraphOp; payload: unknown }> = [];
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      calls.push({ op, payload });
      if (op === 'get_sync_cursor') return { initialized: true, last_snapshot_id: lastSnapshotId } as T;
      const batch = payload as { snapshots: Array<{ snapshot_id: number }> };
      lastSnapshotId = batch.snapshots.at(-1)!.snapshot_id;
      return { last_snapshot_id: lastSnapshotId } as T;
    },
    close: async () => {},
  };
  const sync = new SnapshotSync(snapshots, graph);
  await expect(sync.runBatch(2)).resolves.toBe(2);
  await expect(sync.runBatch(2)).resolves.toBe(1);
  expect(calls.map(call => call.op)).toEqual([
    'get_sync_cursor', 'sync_snapshots', 'get_sync_cursor', 'sync_snapshots',
  ]);
  expect(calls[1]!.payload).toMatchObject({
    operation_id: 'snapshot-sync:1-2', actor: 'system',
    snapshots: [{ snapshot_id: 1 }, { snapshot_id: 2 }],
  });
  expect(calls[3]!.payload).toMatchObject({ operation_id: 'snapshot-sync:3-3', actor: 'system' });
});

it('does not replay before the backup marker is recorded', async () => {
  const snapshots = fixture();
  const calls: GraphOp[] = [];
  const graph: GraphClient = {
    request: async <T>(op: GraphOp): Promise<T> => {
      calls.push(op);
      return { initialized: false, last_snapshot_id: 0 } as T;
    },
    close: async () => {},
  };
  const sync = new SnapshotSync(snapshots, graph);
  await expect(sync.runBatch(2)).resolves.toBe(0);
  expect(calls).toEqual(['get_sync_cursor']);
});

it('creates a readable backup before setting the marker and replaying', async () => {
  const snapshots = fixture();
  const directory = await mkdtemp(resolve(tmpdir(), 'contact-sync-'));
  try {
    const backupPath = resolve(directory, 'legacy.sqlite');
    const database = databases.at(-1)!;
    let initialized = false;
    let cursor = 0;
    const calls: GraphOp[] = [];
    const graph: GraphClient = {
      request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
        calls.push(op);
        if (op === 'get_sync_cursor') {
          return { initialized, last_snapshot_id: cursor } as T;
        }
        const input = payload as { initialize?: boolean; snapshots: Array<{ snapshot_id: number }> };
        if (input.initialize) {
          const copy = new DatabaseSync(backupPath, { readOnly: true });
          expect(copy.prepare('SELECT COUNT(*) AS n FROM contact_query_snapshots').get()).toEqual({ n: 3 });
          copy.close();
          initialized = true;
        } else {
          cursor = input.snapshots.at(-1)!.snapshot_id;
        }
        return { initialized, last_snapshot_id: cursor } as T;
      },
      close: async () => {},
    };
    await expect(runContactSync(['--backup', backupPath], {
      database, sqlitePath: ':memory:', graph,
    })).resolves.toMatchObject({ source_count: 3, last_snapshot_id: 3 });
    expect(calls).toContain('sync_snapshots');
    expect(snapshots.findAfter(0, 10)).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('dry-run reads legacy rows without contacting or changing the graph', async () => {
  fixture();
  const graph: GraphClient = {
    request: async () => { throw new Error('graph must remain untouched'); },
    close: async () => {},
  };
  await expect(runContactSync(['--dry-run'], {
    database: databases.at(-1)!, sqlitePath: ':memory:', graph,
  })).resolves.toEqual({ source_count: 3, last_snapshot_id: 3 });
});

it('refuses to initialize sync when the requested backup cannot be created', async () => {
  fixture();
  const calls: GraphOp[] = [];
  const graph: GraphClient = {
    request: async <T>(op: GraphOp): Promise<T> => {
      calls.push(op);
      return { initialized: false, last_snapshot_id: 0 } as T;
    },
    close: async () => {},
  };
  const directory = await mkdtemp(resolve(tmpdir(), 'contact-sync-missing-'));
  try {
    const destination = resolve(directory, 'nonexistent', 'backup.sqlite');
    await expect(runContactSync(['--backup', destination], {
      database: databases.at(-1)!, sqlitePath: ':memory:', graph,
    })).rejects.toThrow();
    expect(calls).toEqual(['get_sync_cursor']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
