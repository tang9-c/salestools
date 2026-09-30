import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DocumentExtractor } from '../src/contacts/document-extractor.js';
import { ImportCandidateSchema } from '../src/contracts/index.js';
import { createApplication, type RunningApplication } from '../src/index.js';

const document = readFileSync(new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url));
const sha = createHash('sha256').update(document).digest('hex');
const binary = fileURLToPath(new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url));
const python = fileURLToPath(new URL('../python/.venv/bin/python', import.meta.url));
const collectedAt = '2026-09-26T00:00:00.000Z';
const phone = '+15550001111';
const clients: Client[] = [];
let runtime: RunningApplication | undefined;
let directory: string | undefined;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await runtime?.close();
  runtime = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

async function connect(endpoint: string, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, `${name}: ${JSON.stringify(response.content)}`).not.toBe(true);
  return response.structuredContent as Record<string, unknown>;
}

async function ready(client: Client, importId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const preview = await call(client, 'get_contact_import', { import_id: importId });
    if (preview.status === 'ready_for_review') return preview;
    if (preview.status === 'failed') throw new Error(`Import failed: ${JSON.stringify(preview.warnings)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Import preview did not become ready');
}

it('travels through authenticated HTTP upload, MCP and the real graph without exposing private data through legacy contacts',
  async () => {
    directory = mkdtempSync(join(tmpdir(), 'contact-http-mcp-'));
    vi.spyOn(DocumentExtractor.prototype, 'extract').mockImplementation(async blocks => {
      expect(blocks).toEqual(expect.arrayContaining([expect.objectContaining({
        text: expect.stringContaining('Lin Xiang'), page: 1,
      })]));
      return {
      candidates: [ImportCandidateSchema.parse({
        candidate_id: 'lin-candidate', label: 'Person', properties: { name: 'Lin Xiang' },
        extensions: { hobbies: [], instantMessaging: [] },
        evidence: [{ evidence_id: 'ev_lin_name', subject_kind: 'entity',
          subject_id: 'lin-candidate', field_path: 'properties.name', value: 'Lin Xiang',
          source_type: 'file', file_name: 'synthetic-resume.pdf', file_sha256: sha,
          quote: 'Fictional Person: Lin Xiang', page: 1, locator_status: 'located',
          collected_at: collectedAt }],
        relation_suggestions: [], warnings: [], can_commit: true,
      })],
      warnings: [], processedBlockIds: ['stub-extraction'], unprocessedBlockIds: [],
      };
    });
    const config = loadConfig({
      PORT: '3000', PUBLIC_MCP_HOST: '127.0.0.1', ALLOWED_ORIGINS: 'https://codex.example.cn',
      SQLITE_PATH: ':memory:',
      QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
      QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
      QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
      QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream', QCC_API_KEY: 'fake-qcc',
      DOUBAO_SEARCH_API_URL: 'https://search.example.cn/search', DOUBAO_SEARCH_API_KEY: 'fake-search',
      ARK_API_URL: 'https://ark.example.cn/chat', ARK_MODEL: 'fake-model', ARK_CREDENTIAL: 'fake-ark',
      CONTACT_GRAPH_ENABLED: 'true', CONTACT_GRAPH_BIN: binary,
      CONTACT_GRAPH_SQLITE_PATH: join(directory, 'graph.sqlite'), CONTACT_PYTHON_BIN: python,
    });
    runtime = createApplication(config, {
      searchClient: { search: async () => [], searchWeb: async () => [{
        title: 'Alpha Studio public staff', url: 'https://alpha.example/team',
        originalPublisher: 'Alpha Studio', originalDomain: 'alpha.example',
        summary: `Alpha Studio 的 Lin Xiang 担任研发总监。Private contact: ${phone} lin.private@example.com`,
        content: null, publishedAt: '2026-09-01T00:00:00.000Z', position: 1, logId: null,
      }] },
      contactExtractor: { extract: async () => ({ contacts: [{
        companyName: 'Alpha Studio', name: 'Lin Xiang', title: '研发总监',
        roleCategory: 'research_and_development', sourceType: 'official_website',
        sourceUrl: 'https://alpha.example/team',
      }], selection: { totalPages: 1, includedPages: 1, textTruncated: false } }) },
      logSink: { write: () => undefined },
    });
    const tokenA = runtime.tokenService.create('owner-a');
    const tokenB = runtime.tokenService.create('owner-b');
    const server = await runtime.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const badUpload = await fetch(`${base}/contact-files`, { method: 'POST',
      headers: { Authorization: 'Bearer invalid-token' } });
    expect(badUpload.status).toBe(401);
    const badMcp = await fetch(`${base}/mcp`, { method: 'POST',
      headers: { Authorization: 'Bearer invalid-token', 'Content-Type': 'application/json' },
      body: '{}' });
    expect(badMcp.status).toBe(401);

    const first = await connect(`${base}/mcp`, tokenA, 'owner-a');
    const second = await connect(`${base}/mcp`, tokenB, 'owner-b');
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(document)], { type: 'application/pdf' }),
      'synthetic-resume.pdf');
    const upload = await fetch(`${base}/contact-files`, { method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }, body });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { file_id: string; sha256: string };
    expect(uploaded.sha256).toBe(sha);
    const started = await call(first, 'import_contacts', {
      file_id: uploaded.file_id, operation_id: 'http-start-lin',
    });
    const importId = String(started.import_id);
    const denied = await second.callTool({ name: 'get_contact_import',
      arguments: { import_id: importId } });
    expect(denied.isError).toBe(true);
    const preview = await ready(first, importId);
    expect(preview).toMatchObject({ total_candidates: 1,
      candidates: [{ candidate_id: 'lin-candidate', evidence: [{
        evidence_id: 'ev_lin_name', page: 1, file_sha256: sha,
      }] }], processed_block_ids: ['stub-extraction'] });
    expect(await call(second, 'search_contacts', { name: 'Lin Xiang' }))
      .toMatchObject({ total: 0 });
    const committed = await call(first, 'commit_contact_import', {
      import_id: importId, preview_version: preview.version,
      operation_id: `contact-import:${importId}`,
      choices: [{ candidate_id: 'lin-candidate', action: 'create',
        set_properties: { telephone: [phone] }, evidence: [{ field_path: 'properties.telephone',
          value: phone, source_type: 'manual', locator_status: 'not_applicable',
          collected_at: collectedAt }] }],
    });
    expect(committed.status).toBe('committed');
    const importedId = String((committed.results as Array<{ entity_id: string }>)[0]?.entity_id);
    expect(importedId).toBeTruthy();
    const found = await call(second, 'search_contacts', { name: 'Lin Xiang' });
    expect(found.items).toEqual(expect.arrayContaining([expect.objectContaining({ entity_id: importedId })]));
    const answer = await call(second, 'ask_contacts', {
      question: 'Lin Xiang的名字是什么？', entity_id: importedId,
    });
    expect(answer).toMatchObject({ status: 'answered', citations: [{
      evidence_id: 'ev_lin_name', page: 1, file_name: 'synthetic-resume.pdf',
    }] });
    const detail = await call(second, 'get_contact', { entity_id: importedId });
    expect(detail).toMatchObject({ entity: { properties: { telephone: [phone] } } });
    const oldContacts = await call(second, 'get_contacts', { query: 'Alpha Studio' });
    expect(oldContacts.companies).toEqual(expect.arrayContaining([expect.objectContaining({
      contacts: [expect.objectContaining({ name: 'Lin Xiang' })],
    })]));
    expect(JSON.stringify(oldContacts)).not.toMatch(/\+15550001111|lin\.private@example\.com|telephone|email/iu);

    const edited = await call(second, 'save_contact', { operation_id: 'http-edit-lin',
      label: 'Person', entity_id: importedId, expected_version: detail.version,
      set_properties: { jobTitle: 'Engineer' }, evidence: [{ field_path: 'properties.jobTitle',
        value: 'Engineer', source_type: 'manual', locator_status: 'not_applicable',
        collected_at: collectedAt }] });
    expect(edited.version).toBe(2);
    const duplicate = await call(first, 'save_contact', { operation_id: 'http-duplicate-lin',
      label: 'Person', set_properties: { name: 'Lin Duplicate' },
      evidence: [{ field_path: 'properties.name', value: 'Lin Duplicate',
        source_type: 'manual', locator_status: 'not_applicable', collected_at: collectedAt }] });
    const merged = await call(second, 'merge_contacts', { operation_id: 'http-merge-lin',
      source_id: duplicate.entity_id, target_id: importedId,
      expected_source_version: duplicate.version, expected_target_version: edited.version });
    expect(merged.target_id).toBe(importedId);
    expect(await call(first, 'get_contact', { entity_id: String(duplicate.entity_id) }))
      .toEqual({ found: false });
    const beforeArchive = await call(first, 'get_contact', { entity_id: importedId });
    const archived = await call(first, 'delete_contact', { operation_id: 'http-archive-lin',
      entity_id: importedId, expected_version: beforeArchive.version });
    expect(archived.entity_id).toBe(importedId);
    expect(await call(second, 'get_contact', { entity_id: importedId })).toEqual({ found: false });
    const restored = await call(second, 'save_contact', { operation_id: 'http-restore-lin',
      action: 'restore', entity_id: importedId, expected_version: archived.version });
    expect(restored.entity_id).toBe(importedId);
    expect(await call(first, 'get_contact', { entity_id: importedId }))
      .toMatchObject({ entity: { properties: { name: 'Lin Xiang', telephone: [phone],
        jobTitle: 'Engineer' } } });
  }, 90_000);
