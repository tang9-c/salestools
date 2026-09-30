import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const worker = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function exchange(lines: string[]): Promise<{ frames: Array<Record<string, unknown>>; code: number | null }> {
  const directory = await mkdtemp(join(tmpdir(), 'contact-graph-protocol-'));
  temporaryDirectories.push(directory);
  const child = spawn(worker, [], {
    env: { ...process.env, CONTACT_GRAPH_SQLITE_PATH: join(directory, 'graph.sqlite') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stdin.end(`${lines.join('\n')}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { frames: output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>), code };
}

it('rejects oversized and malformed frames while preserving the next request', async () => {
  const { frames, code } = await exchange([
    'x'.repeat(256 * 1024 + 1),
    '{bad',
    JSON.stringify({ version: 1, request_id: 'healthy', op: 'health', payload: { nonce: 'alive' } }),
  ]);
  expect(code).toBe(0);
  expect(frames).toHaveLength(3);
  expect((frames[0].error as { code: string }).code).toBe('FRAME_TOO_LARGE');
  expect((frames[1].error as { code: string }).code).toBe('BAD_REQUEST');
  expect(frames[2]).toMatchObject({ request_id: 'healthy', ok: true, result: { nonce: 'alive' } });
});

it('looks up persisted start operations read-only with actor and file binding', async () => {
  const request = (id: string, op: string, payload: Record<string, unknown>) =>
    JSON.stringify({ version: 1, request_id: id, op, payload });
  const { frames, code } = await exchange([
    request('start', 'put_import_job', { operation_id: 'start-a', actor: 'alice', file_id: 'file-a',
      status: 'queued', data: { candidates: [] } }),
    request('replay', 'get_import_start', { operation_id: 'start-a', actor: 'alice', file_id: 'file-a' }),
    request('wrong-actor', 'get_import_start', { operation_id: 'start-a', actor: 'bob', file_id: 'file-a' }),
    request('wrong-file', 'get_import_start', { operation_id: 'start-a', actor: 'alice', file_id: 'file-b' }),
    request('used-file', 'get_import_start', { operation_id: 'another-start', actor: 'alice', file_id: 'file-a' }),
    request('unknown', 'get_import_start', { operation_id: 'start-new', actor: 'alice', file_id: 'file-new' }),
  ]);
  expect(code).toBe(0);
  expect(frames[1]).toMatchObject({ ok: true, result: {
    ...(frames[0].result as object), replayed: true,
  } });
  expect(frames[2]).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } });
  expect(frames[3]).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } });
  expect(frames[4]).toMatchObject({ ok: false, error: { code: 'FILE_ALREADY_USED' } });
  expect(frames[5]).toMatchObject({ ok: true, result: null });
});
