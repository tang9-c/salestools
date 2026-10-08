import { expect, it, vi } from 'vitest';
import { ContactRateLimit } from '../src/contacts/contact-rate-limit.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import type { UploadStore, UploadedFile } from '../src/contacts/upload-store.js';
import type { ImportJobs } from '../src/contacts/import-jobs.js';
import { createHttpApp } from '../src/mcp/http-app.js';
import type { McpServices } from '../src/mcp/tools.js';
import { UploadSessions } from '../src/contacts/upload-session.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';

it('limits each actor separately, expires after 60 seconds and returns a bounded wait', () => {
  let now = 0;
  const limit = new ContactRateLimit(() => now);
  for (let i = 0; i < 5; i++) limit.consume('alice');
  expect(() => limit.consume('alice')).toThrow('CONTACT_RATE_LIMITED');
  limit.consume('bob');
  now = 59_001;
  try { limit.consume('alice'); throw new Error('expected rate limit'); }
  catch (error) { expect(error).toMatchObject({ code: 'CONTACT_RATE_LIMITED', retryAfterSeconds: 1 }); }
  now = 60_000;
  expect(() => limit.consume('alice')).not.toThrow();
});

it('shares new-import limits across MCP tokens and page sessions while allowing durable replays', async () => {
  const starts = new Map<string, { import_id: string; version: number; replayed: boolean }>();
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      const input = payload as { operation_id: string };
      if (op === 'get_import_start') return (starts.get(input.operation_id) ?? null) as T;
      if (op !== 'put_import_job') throw new Error(`unexpected operation: ${op}`);
      const output = { import_id: `ci_${starts.size}`, version: 1, replayed: false };
      starts.set(input.operation_id, output);
      return output as T;
    }, close: async () => undefined,
  };
  const markSubmitted = vi.fn();
  const uploads = { get: (id: string) => ({ fileId: id, actor: id.startsWith('bob') ? 'bob' : 'alice' } as UploadedFile),
    markSubmitted } as unknown as UploadStore;
  // Scheduler is not exercised here; the real entrypoint and durable replay lookup are.
  const imports = new ContactImportService({ graph, uploads,
    jobs: { start: async () => undefined } as unknown as ImportJobs,
    parse: async () => [], extract: async () => ({ candidates: [], warnings: [], processedBlockIds: [], unprocessedBlockIds: [] }) });
  const sessions = new UploadSessions(() => true);
  const page = sessions.create('alice', 'source');
  sessions.claimUpload(page.sessionId);
  sessions.finishUpload(page.sessionId, 'page-file');
  const app = createHttpApp({ publicMcpHost: '127.0.0.1', allowedOriginUrls: new Set(), allowedOriginHostnames: new Set() },
    token => ['one', 'two'].includes(token) ? { userId: 'alice' } : null,
    () => ({ contactImport: imports } as McpServices), undefined, { sessions, imports, html: async () => '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  try {
    for (const token of ['one', 'two']) {
      const client = new Client({ name: 'rate-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      clients.push(client);
    }
    for (let n = 0; n < 5; n++) {
      expect((await clients[n % 2]!.callTool({ name: 'import_contacts',
        arguments: { file_id: `file-${n}`, operation_id: `start-${n}` } })).isError).not.toBe(true);
    }
    const denied = await clients[0]!.callTool({ name: 'import_contacts', arguments: { file_id: 'file-6', operation_id: 'start-6' } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ code: 'CONTACT_RATE_LIMITED', retry_after_seconds: expect.any(Number) });
    expect((await clients[1]!.callTool({ name: 'import_contacts', arguments: { file_id: 'file-0', operation_id: 'start-0' } })).structuredContent)
      .toMatchObject({ import_id: 'ci_0' });
    const pageResult = await fetch(`${base}/contact-upload/import`, { method: 'POST',
      headers: { Authorization: `Bearer ${page.sessionId}.${page.bearer}` } });
    expect(pageResult.status).toBe(429);
    expect(Number(pageResult.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await pageResult.json()).toMatchObject({ code: 'CONTACT_RATE_LIMITED' });
    expect(markSubmitted).toHaveBeenCalledTimes(5);
    expect(starts.size).toBe(5);
    await expect(imports.start({ file_id: 'bob-file', operation_id: 'bob-start' }, 'bob')).resolves.toMatchObject({ import_id: 'ci_5' });
    await expect(imports.start({ file_id: 'file-6', operation_id: 'stolen' }, 'bob')).rejects.toThrow('IMPORT_ACCESS_DENIED');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await app.closeMcpHandler();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
