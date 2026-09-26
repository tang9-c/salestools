import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const binary = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));

async function callWorker(path: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = spawn(binary, [], {
    env: { ...process.env, CONTACT_GRAPH_SQLITE_PATH: path }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
  child.stdin.end(`${JSON.stringify({ version: 1, request_id: 'req', ...request })}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code, errorOutput).toBe(0);
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

it('returns the original entity after a worker restart and repeated save operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contact-graph-integration-'));
  try {
    const path = join(directory, 'graph.sqlite');
    const payload = {
      operation_id: 'save-after-response-loss', actor: 'user-a', label: 'Person',
      set_properties: { name: '陈晓', telephone: ['+86 13800000000'] },
      evidence: [
        { field_path: 'properties.name', value: '陈晓', source_type: 'manual',
          collected_at: '2026-09-26T00:00:00.000Z', locator_status: 'not_applicable' },
        { field_path: 'properties.telephone', value: '+86 13800000000', source_type: 'manual',
          collected_at: '2026-09-26T00:00:00.000Z', locator_status: 'not_applicable' },
      ],
    };
    const first = await callWorker(path, { op: 'save_contact', payload });
    expect(first.ok).toBe(true);
    const replay = await callWorker(path, { op: 'save_contact', payload });
    expect(replay.ok).toBe(true);
    expect(replay.result).toMatchObject({
      entity_id: (first.result as { entity_id: string }).entity_id,
      version: 1, replayed: true,
    });
    const loaded = await callWorker(path, {
      op: 'get_contact', payload: { entity_id: (first.result as { entity_id: string }).entity_id },
    });
    expect(loaded.result).toMatchObject({
      entity: { properties: { name: '陈晓', telephone: ['+86 13800000000'] } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
