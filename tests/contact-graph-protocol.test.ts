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
