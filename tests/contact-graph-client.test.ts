import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContactGraphClient, readCompleteContact, type GraphClient } from '../src/contacts/graph-client.js';

it.each(['failure', 'version'])('returns only verified accumulated pages when partial reading is requested: %s', async mode => {
  let incomplete = false;
  const graph: GraphClient = { close: async () => undefined,
    request: async <T>(_op: unknown, payload: unknown): Promise<T> => {
      const offset = (payload as { relation_offset?: number }).relation_offset ?? 0;
      if (offset === 2 && mode === 'failure') throw new Error('private failure');
      return { version: offset === 2 ? 2 : 1, index_content_version: 1, entity: { entity_id: 'p1' }, evidence: [],
        relations: [{ relation_id: `r${offset}` }], pagination: { evidence: { total: 0, next_offset: null },
          relations: { total: 3, next_offset: offset === 2 ? null : offset + 1 } } } as T;
    } };
  const result = await readCompleteContact(graph, 'p1', { onIncomplete: () => { incomplete = true; } } as Parameters<typeof readCompleteContact>[2]);
  expect(incomplete).toBe(true);
  expect(result?.relations).toEqual([{ relation_id: 'r0' }, { relation_id: 'r1' }]);
  expect(result?.version).toBe(1);
  await expect(readCompleteContact(graph, 'p1')).rejects.toThrow(mode === 'failure' ? 'private failure' : 'GRAPH_CONTACT_CHANGED_DURING_READ');
});

const directories: string[] = [];
const clients: ContactGraphClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close(50)));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fakeGraphBinary(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'graph-bridge-'));
  directories.push(directory);
  const command = resolve(directory, 'graph-worker');
  await writeFile(command, `#!/usr/bin/env node
const readline = require('node:readline');
let pending = 0;
readline.createInterface({ input: process.stdin }).on('line', input => {
  const request = JSON.parse(input);
  pending += 1;
  const concurrent = pending;
  if (request.payload.mode === 'die') process.exit(7);
  if (request.payload.mode === 'hang') return;
  if (request.payload.mode === 'malformed') { process.stdout.write('{broken\\n'); return; }
  if (request.payload.mode === 'oversize') { process.stdout.write('x'.repeat(256 * 1024 + 1)); return; }
  if (request.payload.mode === 'wrong_id') { process.stdout.write(JSON.stringify({ version: 1, request_id: 'other', ok: true, result: {} }) + '\\n'); return; }
  if (request.payload.mode === 'remote_too_large') { process.stdout.write(JSON.stringify({ version: 1, request_id: request.request_id, ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: 'single item' } }) + '\\n'); return; }
  const send = () => {
    process.stdout.write(JSON.stringify({ version: 1, request_id: request.request_id, ok: true,
      result: { nonce: request.payload.nonce, concurrent, dbPath: process.env.CONTACT_GRAPH_SQLITE_PATH } }) + '\\n');
    pending -= 1;
  };
  setTimeout(send, request.payload.delay ?? 0);
});
`);
  await chmod(command, 0o755);
  const syntax = spawnSync(process.execPath, ['--check', command], { encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(syntax.stderr);
  return command;
}

async function client(): Promise<ContactGraphClient> {
  const instance = new ContactGraphClient({ command: await fakeGraphBinary(), dbPath: '/tmp/server-selected-graph.sqlite' });
  clients.push(instance);
  return instance;
}

it('keeps concurrent calls paired by request ID and sends one request at a time', async () => {
  const graph = await client();
  const [a, b] = await Promise.all([
    graph.request<{ nonce: string; concurrent: number; dbPath: string }>('health', { nonce: 'a', delay: 20 }),
    graph.request<{ nonce: string; concurrent: number; dbPath: string }>('health', { nonce: 'b' }),
  ]);
  expect(a).toEqual({ nonce: 'a', concurrent: 1, dbPath: '/tmp/server-selected-graph.sqlite' });
  expect(b).toEqual({ nonce: 'b', concurrent: 1, dbPath: '/tmp/server-selected-graph.sqlite' });
});

it('rejects a killed child and its in-flight work', async () => {
  const graph = await client();
  await expect(graph.request('health', { mode: 'die' })).rejects.toThrow(/GRAPH_/);
  await expect(graph.request('health', {})).rejects.toThrow(/GRAPH_/);
});

it.each(['malformed', 'oversize', 'wrong_id'])('rejects an unsafe %s response frame', async mode => {
  const graph = await client();
  await expect(graph.request('health', { mode })).rejects.toThrow(/GRAPH_/);
});

it('closes boundedly when a child ignores an in-flight request', async () => {
  const graph = await client();
  const pending = graph.request('health', { mode: 'hang' });
  const outcome = expect(pending).rejects.toThrow(/GRAPH_/);
  const start = Date.now();
  await graph.close(50);
  expect(Date.now() - start).toBeLessThan(1_000);
  await outcome;
});

it('rejects new work as soon as shutdown begins', async () => {
  const graph = await client();
  const pending = graph.request('health', { mode: 'hang' });
  const outcome = expect(pending).rejects.toThrow(/GRAPH_/);
  const closing = graph.close(300);
  const admission = await Promise.race([
    graph.request('health', {}).then(() => 'accepted', error => (error as Error).message),
    new Promise<string>(resolveTimeout => setTimeout(() => resolveTimeout('still waiting'), 50)),
  ]);
  expect(admission).toBe('GRAPH_CLOSED');
  await closing;
  await outcome;
});

it('rejects user payload paths and unknown operations without sending them to the worker', async () => {
  const graph = await client();
  await expect(graph.request('health', { nested: { path: '/tmp/attacker.sqlite' } })).rejects.toThrow(/GRAPH_/);
  await expect(graph.request('health', { dbPath: '/tmp/attacker.sqlite' })).rejects.toThrow(/GRAPH_/);
  await expect(graph.request('health', { toJSON: () => ({ filePath: '/tmp/attacker.sqlite' }) })).rejects.toThrow(/GRAPH_/);
  await expect(graph.request('arbitrary_sql' as 'health', {})).rejects.toThrow(/GRAPH_/);
  await expect(graph.request<{ nonce: string }>('health', { nonce: 'safe' })).resolves.toMatchObject({ nonce: 'safe' });
});

it('allows ontology field_path evidence in a graph write payload', async () => {
  const graph = await client();
  await expect(graph.request('save_contact', {
    operation_id: 'op-1', actor: 'user-a', label: 'Person',
    set_properties: { name: '陈晓' },
    evidence: [{ field_path: 'properties.name', value: '陈晓', source_type: 'manual' }],
  })).resolves.toMatchObject({ concurrent: 1 });
});

it('admits all company reads and surfaces an oversized single record as unavailable', async () => {
  const graph = await client();
  for (const op of ['company_organizations', 'company_relations', 'company_recent_records'] as const) {
    await expect(graph.request<{ nonce: string }>(op, { nonce: op }))
      .resolves.toMatchObject({ nonce: op });
    await expect(graph.request(op, { mode: 'remote_too_large' }))
      .rejects.toThrow('RESPONSE_TOO_LARGE');
  }
});

it('honors an aborted queued request without disrupting the active request', async () => {
  const graph = await client();
  const first = graph.request('health', { nonce: 'first', delay: 30 });
  const controller = new AbortController();
  const queued = graph.request('health', { nonce: 'second' }, controller.signal);
  const outcome = expect(queued).rejects.toThrow(/GRAPH_/);
  controller.abort();
  await outcome;
  await expect(first).resolves.toMatchObject({ nonce: 'first' });
});

it('recovers the worker after cancelling an active request', async () => {
  const graph = await client();
  const controller = new AbortController();
  const active = graph.request('health', { mode: 'hang' }, controller.signal);
  const aborted = expect(active).rejects.toThrow(/GRAPH_ABORTED/);
  const next = graph.request<{ nonce: string }>('health', { nonce: 'next' });
  controller.abort();
  await aborted;
  await expect(next).resolves.toMatchObject({ nonce: 'next' });
  await expect(graph.request<{ nonce: string }>('health', { nonce: 'after' }))
    .resolves.toMatchObject({ nonce: 'after' });
});

it('rejects a bounded queue while the worker is stuck', async () => {
  const graph = await client();
  const active = graph.request('health', { mode: 'hang' }).catch(() => undefined);
  const queued = Array.from({ length: 32 }, (_, index) =>
    graph.request('health', { nonce: String(index) }).catch(() => undefined));
  await expect(graph.request('health', { nonce: 'overflow' })).rejects.toThrow(/GRAPH_QUEUE_FULL/);
  await graph.close(50);
  await Promise.all([active, ...queued]);
});
