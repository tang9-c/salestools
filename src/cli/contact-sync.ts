import { existsSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { config as loadDotEnv } from 'dotenv';
import { loadConfig } from '../config.js';
import { ContactSnapshotRepository } from '../db/contact-snapshot-repository.js';
import { ContactGraphClient, type GraphClient } from '../contacts/graph-client.js';
import { SnapshotSync } from '../contacts/snapshot-sync.js';

export interface ContactSyncOptions {
  database: DatabaseSync;
  sqlitePath: string;
  graph?: GraphClient;
}

export interface ContactSyncSummary {
  source_count: number;
  last_snapshot_id: number;
}

function sourceSummary(snapshots: ContactSnapshotRepository): ContactSyncSummary {
  let cursor = 0;
  let sourceCount = 0;
  while (true) {
    const rows = snapshots.findAfter(cursor, 100);
    sourceCount += rows.length;
    if (rows.length === 0) return { source_count: sourceCount, last_snapshot_id: cursor };
    cursor = rows.at(-1)!.snapshotId;
  }
}

async function createVerifiedBackup(database: DatabaseSync, destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new Error('Backup destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await backup(database, destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
      copy.prepare('SELECT snapshot_id FROM contact_query_snapshots LIMIT 1').all();
    } finally {
      copy.close();
    }
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function runContactSync(
  args: string[],
  options: ContactSyncOptions,
): Promise<ContactSyncSummary> {
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  const liveRun = args.length === 2 && args[0] === '--backup'
    && isAbsolute(args[1]!) && args[1]!.endsWith('.sqlite');
  if (!dryRun && !liveRun) throw new Error('Expected --dry-run or --backup /absolute/path.sqlite');
  const snapshots = new ContactSnapshotRepository(options.database);
  if (dryRun) return sourceSummary(snapshots);
  if (!options.graph) throw new Error('Contact graph is not configured');
  const destination = args[1]!;
  if (options.sqlitePath !== ':memory:' && resolve(destination) === resolve(options.sqlitePath)) {
    throw new Error('Backup destination must differ from the main database');
  }
  const sync = new SnapshotSync(snapshots, options.graph);
  const cursor = await sync.cursor();
  if (!cursor.initialized) {
    await createVerifiedBackup(options.database, destination);
    await sync.initialize();
  }
  let processed = 0;
  while (true) {
    const batch = await sync.runBatch(20);
    if (batch === 0) break;
    processed += batch;
  }
  const latest = await sync.cursor();
  return { source_count: processed, last_snapshot_id: latest.last_snapshot_id };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadDotEnv();
    const config = loadConfig(process.env);
    if (config.sqlitePath !== ':memory:' && !existsSync(config.sqlitePath)) {
      throw new Error('Main database does not exist');
    }
    const dryRun = process.argv.length === 3 && process.argv[2] === '--dry-run';
    const database = new DatabaseSync(config.sqlitePath, { readOnly: dryRun });
    const graph = config.contactGraphEnabled
      ? new ContactGraphClient({ command: config.contactGraphBin!, dbPath: config.contactGraphSqlitePath! })
      : undefined;
    try {
      const summary = await runContactSync(process.argv.slice(2), {
        database, sqlitePath: config.sqlitePath, graph,
      });
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      await graph?.close();
      database.close();
    }
  } catch {
    process.stderr.write('CONTACT_SYNC_ERROR\n');
    process.exitCode = 1;
  }
}
