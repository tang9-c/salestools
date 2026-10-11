import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContactImportService } from '../src/contacts/import-service.js';
import { UploadStore } from '../src/contacts/upload-store.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import { registerContactImportTools } from '../src/mcp/contact-import-tools.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const text = '林知远，云杉测试科技有限公司研发经理，邮箱 lin@example.com。';
const fact = (field_path: string, value: string, quote = value) => ({ field_path, value,
  evidence: [{ block_id: 'text:1', quote }], uncertain: false });

async function setup(options: { fail?: boolean; timeoutMs?: number; stalled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'contact-text-test-'));
  const uploads = new UploadStore({ directory, maxPendingFiles: 2, maxFileBytes: 100_000, maxTempBytes: 100_000 });
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: options.timeoutMs ?? 1000,
    submit: id => { uploads.markSubmitted(id); }, release: id => uploads.release(id) });
  cleanups.push(async () => { await jobs.recover(); await uploads.close(); await rm(directory, { recursive: true }); });
  let job: Record<string, any> | null = null;
  let commit: Record<string, any> | undefined;
  let calls = 0;
  const events: unknown[] = [];
  const graph: GraphClient = { close: async () => {}, request: async <T>(op: GraphOp, raw: unknown) => {
    const input = raw as Record<string, any>;
    if (op === 'get_import_start') {
      if (!job || job.operation_id !== input.operation_id) return null as T;
      if (job.actor !== input.actor || job.file_id !== input.file_id) throw new Error('OPERATION_CONFLICT');
      return { import_id: job.import_id, replayed: true } as T;
    }
    if (op === 'put_import_job') {
      if (!input.import_id) job = { ...input, import_id: 'ci_text', version: 1 };
      else {
        if (input.expected_version !== job?.version) throw new Error('VERSION_CONFLICT');
        job = { ...job, ...input, actor: job!.actor, operation_id: job!.operation_id, version: job!.version + 1 };
      }
      return { import_id: 'ci_text', version: job!.version, replayed: false } as T;
    }
    if (op === 'get_import_job') return job as T;
    if (op === 'commit_import') { commit = input; job!.status = 'committed'; return { entity_ids: ['p_text', 'o_text'] } as T; }
    if (op === 'find_identity_candidates') return { entity_ids: [], truncated: false } as T;
    throw new Error(`Unexpected ${op}`);
  } };
  const service = new ContactImportService({ graph, uploads, jobs, onEvent: event => events.push(event),
    parse: async () => { throw new Error('Text must not invoke Docling'); },
    extract: async (blocks, source, signal) => {
      calls++;
      if (options.stalled) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (options.fail) throw new Error('private model response and token');
      return new DocumentExtractor({ url: 'https://ark.example/chat', model: 'test', credential: 'test',
        fileName: source.fileName, fileSha256: source.sha256, sourceType: 'text',
        skillSupplement: false, projectSupplement: false,
        fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          subject_status: 'single', person: [fact('properties.name', '林知远'), fact('properties.email', 'lin@example.com')],
          education: [], projects: [], organization_clues: [], employment: [{ local_id: 'o1',
            organization: [fact('properties.name', '云杉测试科技有限公司')],
            employment: { evidence: [{ block_id: 'text:1', quote: text }], uncertain: false },
            role: [fact('properties.role.roleName', '研发经理')] }],
        }) } }] })) }).extract(blocks, signal);
    } });
  return { service, uploads, directory, events, get job() { return job; }, get commit() { return commit; }, get calls() { return calls; } };
}
async function wait(h: Awaited<ReturnType<typeof setup>>, status: string) {
  for (let n = 0; n < 100 && h.job?.status !== status; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(h.job?.status).toBe(status);
}

it('imports text without upload or Docling, preserves original source and reuses review/commit', async () => {
  const h = await setup();
  const started = await h.service.startText({ text, operation_id: 'text-op' }, 'reviewer');
  await wait(h, 'ready_for_review');
  expect(await readdir(h.directory)).toEqual([]);
  expect(h.uploads.pendingCount).toBe(0);
  expect(h.job?.data.source).toMatchObject({ source_type: 'text', original_text: text });
  const preview = await h.service.get(started.import_id, 'reviewer');
  expect(preview?.total_candidates).toBe(2);
  expect(preview?.source).not.toHaveProperty('original_text');
  expect(JSON.stringify(h.events)).not.toContain(text);
  expect(await h.service.startText({ text, operation_id: 'text-op' }, 'reviewer')).toEqual(started);
  expect(h.calls).toBe(1);
  await expect(h.service.startText({ text: text + ' changed', operation_id: 'text-op' }, 'reviewer')).rejects.toThrow('OPERATION_CONFLICT');
  await expect(h.service.get(started.import_id, 'other')).rejects.toThrow('IMPORT_ACCESS_DENIED');
  await h.service.commit({ import_id: started.import_id, preview_version: preview!.version as number,
    operation_id: `contact-import:${started.import_id}`, auto_create: true }, 'reviewer');
  expect(h.commit?.relation_choices).toEqual([expect.objectContaining({ relation_type: 'worksFor',
    properties: { role: { '@type': 'OrganizationRole', roleName: '研发经理' } } })]);
});

it.each(['', '   ', 'x'.repeat(20_001)])('rejects empty or overlong text before creating a task', async value => {
  const h = await setup();
  await expect(h.service.startText({ text: value, operation_id: 'invalid' }, 'reviewer')).rejects.toThrow();
  expect(h.job).toBeNull();
  expect(h.uploads.pendingCount).toBe(0);
});

it.each([{ fail: true, code: 'IMPORT_FAILED' }, { stalled: true, timeoutMs: 10, code: 'IMPORT_TIMEOUT' }])(
  'persists a failed text task and releases capacity ($code)', async options => {
    const h = await setup(options);
    await h.service.startText({ text, operation_id: 'failure' }, 'reviewer');
    await wait(h, 'failed');
    expect(h.job?.data.source.original_text).toBe(text);
    expect(h.uploads.pendingCount).toBe(0);
    const preview = await h.service.get('ci_text', 'reviewer');
    expect(preview?.failure).toMatchObject({ stage: 'extract', code: options.code });
    expect(JSON.stringify(preview)).not.toContain('private model');
  });

it('shares capacity with uploads and rejects unauthenticated text before persistence', async () => {
  const h = await setup();
  await expect(h.service.startText({ text, operation_id: 'no-auth' }, '')).rejects.toThrow('Authenticated');
  await h.uploads.reserve('reviewer');
  await h.uploads.reserve('reviewer');
  await expect(h.service.startText({ text, operation_id: 'full' }, 'reviewer')).rejects.toThrow('CAPACITY_FULL');
  expect(h.job).toBeNull();
  expect(h.uploads.pendingCount).toBe(2);
});

it('cancels a text import without creating a contact and releases the shared queue slot', async () => {
  const h = await setup({ stalled: true });
  const started = await h.service.startText({ text, operation_id: 'cancel' }, 'reviewer');
  await wait(h, 'processing');
  await h.service.cancel({ import_id: started.import_id, operation_id: 'cancel-op' }, 'reviewer');
  expect(h.job?.status).toBe('cancelled');
  expect(h.job?.data.source.original_text).toBe(text);
  expect(h.uploads.pendingCount).toBe(0);
  expect(h.commit).toBeUndefined();
});

it('exposes a bounded authenticated MCP text entry that creates only a review task', async () => {
  const h = await setup();
  const tools = new Map<string, { schema: z.ZodType; handler: (input: any, context: any) => Promise<any> }>();
  registerContactImportTools({ registerTool(name: string, config: { inputSchema: z.ZodType }, handler: any) {
    tools.set(name, { schema: config.inputSchema, handler });
  } } as unknown as McpServer, h.service);
  const tool = tools.get('import_contacts_text')!;
  expect(tool.schema.safeParse({ text: ' ', operation_id: 'bad' }).success).toBe(false);
  expect(tool.schema.safeParse({ text: 'x'.repeat(20_001), operation_id: 'bad' }).success).toBe(false);
  await expect(tool.handler({ text, operation_id: 'mcp-text' }, {})).rejects.toThrow('Authenticated');
  const result = await tool.handler(tool.schema.parse({ text, operation_id: 'mcp-text' }),
    { http: { authInfo: { clientId: 'reviewer' } } });
  expect(result.structuredContent).toEqual({ import_id: 'ci_text' });
  await wait(h, 'ready_for_review');
  expect(h.commit).toBeUndefined();
});
