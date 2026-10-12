import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import { UploadSessions } from '../src/contacts/upload-session.js';
import { UploadStore } from '../src/contacts/upload-store.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { GraphClientError, type GraphClient, type GraphOp } from '../src/contacts/graph-client.js';
import { ImportCandidateSchema } from '../src/contracts/index.js';

const pdf = readFileSync(new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });

function previewPage(offset = 0, total = 1, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { import_id: 'import_1', status: 'ready_for_review', version: 3, total_candidates: total,
    candidates: Array.from({ length: Math.min(50, Math.max(0, total - offset)) }, (_, n) => ({ ...realReviewService({}).person, candidate_id: `c_${offset + n + 1}`, ...(offset + n > 0 ? { warnings: ['非主体人物线索'], can_commit: false } : {}) })),
    warnings: [], match_suggestions: [], match_suggestions_truncated: false,
    processed_block_ids: ['b_1'], unprocessed_block_ids: [], coverage_available: true, offset, limit: 50, ...patch };
}

async function setup(options: { now?: () => number; sourceEnabled?: () => boolean;
  commitService?: ContactImportService; reviewService?: ContactImportService } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'upload-session-http-'));
  const store = new UploadStore({ directory, maxPendingFiles: 10,
    maxFileBytes: 20 * 1024 * 1024, maxTempBytes: 100 * 1024 * 1024 });
  const sessions = new UploadSessions(options.sourceEnabled ?? (() => true), options.now);
  const review = realReviewService({ processed_block_ids: ['b_1'], unprocessed_block_ids: [] });
  const service = options.reviewService ?? review.service;
  const originalGet = service.get.bind(service);
  const originalCommit = service.commit.bind(service);
  const start = vi.fn(async () => ({ import_id: 'import_1' }));
  const get = vi.fn(async (importId: string, actor: string, offset = 0, limit = 20): Promise<Record<string, unknown> | null> =>
    options.reviewService ? originalGet(importId, actor, offset, limit) : previewPage(offset));
  const commit = vi.fn(async (...args: [Parameters<ContactImportService['commit']>[0], string, (() => void)?]) =>
    options.commitService ? options.commitService.commit(...args) : originalCommit(...args));
  const imports = Object.assign(service, { start, get, commit });
  const app = createHttpApp({ publicMcpHost: '127.0.0.1', allowedOriginUrls: new Set(),
    allowedOriginHostnames: new Set() }, token => token === 'personal' ? { userId: 'alice' } : null,
  () => ({} as never), store, { sessions, imports, html: async () => '<html>upload</html>' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await app.closeMcpHandler(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = sessions.create('alice', 'source');
  const headers = { Authorization: `Bearer ${session.sessionId}.${session.bearer}` };
  const upload = async (auth = headers) => {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(pdf)]), 'resume.pdf');
    return fetch(`${base}/contact-files`, { method: 'POST', headers: auth, body });
  };
  return { base, store, sessions, session, headers, upload, start, get, commit, formalWrites: review.formalWrites };
}

it('binds one file and one import to a page session, preserving personal Bearer upload', async () => {
  const h = await setup();
  const response = await h.upload();
  expect(response.status).toBe(201);
  const file = await response.json() as { file_id: string };
  expect(h.store.get(file.file_id)?.actor).toBe('alice');
  expect((await h.upload()).status).toBe(409);
  const started = await fetch(`${h.base}/contact-upload/import`, { method: 'POST', headers: h.headers });
  expect(started.status).toBe(200);
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ file_id: file.file_id }), 'alice');
  const preview = await fetch(`${h.base}/contact-upload/import`, { headers: h.headers });
  expect(preview.status).toBe(200);
  const saved = await fetch(`${h.base}/contact-upload/commit`, { method: 'POST', headers: {
    ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_version: 3 }) });
  expect(saved.status).toBe(200);
  expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ import_id: 'import_1',
    auto_create: true, preview_version: 3 }), 'alice', expect.any(Function));
  const personal = await h.upload({ Authorization: 'Bearer personal' });
  expect(personal.status).toBe(201);
});

async function ready(h: Awaited<ReturnType<typeof setup>>) {
  expect((await h.upload()).status).toBe(201);
  expect((await fetch(`${h.base}/contact-upload/import`, { method: 'POST', headers: h.headers })).status).toBe(200);
}

it('binds two external pages to distinct HttpOnly cookies and exits only the selected page', async () => {
  const h = await setup();
  const exchange = async (actor: string) => {
    const response = await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
      headers: { Origin: h.base, 'Content-Type': 'application/json' },
      body: JSON.stringify(h.sessions.createHandoff(actor, 'source')) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const body = await response.json() as { session_id: string };
    expect(body.session_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(body).sort()).toEqual(['ok', 'session_id']);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(cookie.split('=')[0]).toBe(`contact-upload-dev-${body.session_id}`);
    return { id: body.session_id, cookie };
  };
  const a = await exchange('alice');
  const b = await exchange('bob');
  const cookies = `${a.cookie}; ${b.cookie}`;
  const request = (id: string, path = '/contact-upload/import', method = 'POST', cookie = cookies) =>
    fetch(h.base + path, { method, headers: { Cookie: cookie, Origin: h.base, 'X-Upload-Session': id } });
  // Both pages send the same browser cookie jar; the selector must bind each request.
  for (const entry of [a, b]) {
    expect((await request(entry.id)).status).toBe(409);
    const session = h.sessions.authorize(entry.id, decodeURIComponent(entry.cookie.split('=')[1]).split('.')[1])!;
    expect(session.actor).toBe(entry === a ? 'alice' : 'bob');
    h.sessions.claimUpload(entry.id);
    h.sessions.finishUpload(entry.id, entry === a ? 'file_a' : 'file_b');
    h.sessions.bindImport(entry.id, entry === a ? 'import_a' : 'import_b');
  }
  expect(await (await request(a.id)).json()).toEqual({ import_id: 'import_a' });
  expect(await (await request(b.id)).json()).toEqual({ import_id: 'import_b' });
  expect((await request('', '/contact-upload/import')).status).toBe(401);
  expect((await request(a.id, '/contact-upload/import', 'POST', b.cookie)).status).toBe(401);
  expect((await request(a.id, '/contact-upload/import', 'POST', `contact-upload-dev-${a.id}=${decodeURIComponent(b.cookie.split('=')[1])}`)).status).toBe(401);
  const exit = await request(a.id, '/contact-upload/exit');
  expect(exit.status).toBe(200);
  expect(exit.headers.get('set-cookie')).toContain(`contact-upload-dev-${a.id}=`);
  expect(exit.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await request(a.id)).status).toBe(401);
  expect(await (await request(b.id)).json()).toEqual({ import_id: 'import_b' });
});

it('returns explicit capacity error without consuming the handoff or exposing credentials', async () => {
  const h = await setup();
  for (let n = 1; n < 1000; n++) h.sessions.create(`actor_${n}`, 'source');
  const handoff = h.sessions.createHandoff('alice', 'source');
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const exchange = () => fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
      headers: { Origin: h.base, 'Content-Type': 'application/json' }, body: JSON.stringify(handoff) });
    const blocked = await exchange();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ code: 'UPLOAD_SESSION_CAPACITY' });
    expect(blocked.headers.get('set-cookie')).toBeNull();
    const logs = log.mock.calls.map(c => String(c[0])).join('');
    expect(logs).toContain('UPLOAD_SESSION_CAPACITY');
    expect(logs).not.toContain(handoff.code);
    expect(logs).not.toContain(h.session.bearer);
    h.sessions.exit(h.session.sessionId, h.session.bearer);
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(401);
  } finally { log.mockRestore(); }
});

function confirm(h: Awaited<ReturnType<typeof setup>>, preview_version = 3, headers = h.headers) {
  return fetch(`${h.base}/contact-upload/commit`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_version }) });
}

it('revokes preview and upload after commit but returns the same minimal receipt on retry', async () => {
  const h = await setup();
  await ready(h);
  const first = await confirm(h);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ import_id: 'import_1', status: 'committed', version: 4 });
  expect((await fetch(`${h.base}/contact-upload/import`, { headers: h.headers })).status).toBe(401);
  expect((await h.upload()).status).toBe(401);
  const retry = await confirm(h);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ import_id: 'import_1', status: 'committed', version: 4 });
  expect((await confirm(h, 4)).status).toBe(401);
  expect((await fetch(`${h.base}/contact-upload/commit`, { method: 'POST', headers: {
    ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_version: 3,
      import_id: 'import_2', operation_id: 'different-operation' }) })).status).toBe(400);
  expect(h.commit).toHaveBeenCalledTimes(1);
});

it('does not retain a successful receipt after a failed confirmation', async () => {
  const h = await setup();
  await ready(h);
  h.commit.mockRejectedValueOnce(new Error('COMMIT_FAILED'));
  expect((await confirm(h)).status).toBe(409);
  expect((await fetch(`${h.base}/contact-upload/import`, { headers: h.headers })).status).toBe(200);
  expect((await confirm(h)).status).toBe(200);
  expect(h.commit).toHaveBeenCalledTimes(2);
});

it('serializes concurrent confirmations and keeps lost-response cookie retries origin bound', async () => {
  const h = await setup();
  await ready(h);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.commit.mockImplementationOnce(async () => { await gate;
    return { status: 'committed', version: 4, candidates: [], results: [] }; });
  const cookie = `contact-upload-dev-${h.session.sessionId}=${h.session.sessionId}.${h.session.bearer}`;
  const headers = { Cookie: cookie, Origin: h.base, 'X-Upload-Session': h.session.sessionId } as unknown as typeof h.headers;
  const first = confirm(h, 3, headers);
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
  const second = confirm(h, 3, headers);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(results[0].headers.get('set-cookie')).toBeNull();
  expect((await confirm(h, 3, { ...headers, Origin: 'https://evil.example' } as unknown as typeof h.headers)).status).toBe(403);
  expect((await confirm(h, 3, headers)).status).toBe(200);
  const exit = await fetch(`${h.base}/contact-upload/exit`, { method: 'POST', headers });
  expect(exit.status).toBe(200);
  expect(exit.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await confirm(h, 3, headers)).status).toBe(401);
});

it('exits a Cookie session only from the exact origin', async () => {
  const h = await setup();
  const cookie = `contact-upload-dev-${h.session.sessionId}=${h.session.sessionId}.${h.session.bearer}`;
  expect((await fetch(`${h.base}/contact-upload/exit`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-Upload-Session': h.session.sessionId } })).status).toBe(403);
  expect(h.sessions.authorize(h.session.sessionId, h.session.bearer)).not.toBeNull();
  expect((await fetch(`${h.base}/contact-upload/exit`, { method: 'POST',
    headers: { Cookie: cookie, Origin: h.base, 'X-Upload-Session': h.session.sessionId } })).status).toBe(200);
  expect((await h.upload()).status).toBe(401);
});

it.each(['active', 'receipt'] as const)('permits an embedded App Bearer to exit a cross-origin %s session', async state => {
  const h = await setup();
  if (state === 'receipt') { await ready(h); expect((await confirm(h)).status).toBe(200); }
  const origin = 'https://web-sandbox.oaiusercontent.com';
  const preflight = await fetch(`${h.base}/contact-upload/exit`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  const exit = await fetch(`${h.base}/contact-upload/exit`, { method: 'POST', headers: { ...h.headers, Origin: origin } });
  expect(exit.status).toBe(200);
  expect(exit.headers.get('access-control-allow-origin')).toBe('*');
  expect(exit.headers.get('access-control-allow-credentials')).toBeNull();
  expect(await exit.json()).toEqual({ ok: true });
  expect((await h.upload()).status).toBe(401);
  expect((await confirm(h)).status).toBe(401);
});

it.each(['exit', 'disabled', 'expired'] as const)('does not write when %s occurs during commit service reads', async reason => {
  let enabled = true;
  let now = 0;
  let reading = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const formalWrites: unknown[] = [];
  const person = ImportCandidateSchema.parse({ candidate_id: 'c_1', label: 'Person',
    properties: { name: '陈晓' }, extensions: { hobbies: [], instantMessaging: [] },
    evidence: [{ evidence_id: 'e_1', subject_kind: 'entity', subject_id: 'c_1',
      field_path: 'properties.name', value: '陈晓', source_type: 'file',
      file_name: 'resume.pdf', file_sha256: 'a'.repeat(64), quote: '陈晓', page: 1,
      locator_status: 'located', collected_at: '2026-09-29T00:00:00.000Z' }],
    relation_suggestions: [], warnings: [], can_commit: true });
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, input: unknown): Promise<T> => {
      if (op === 'get_import_job') {
        reading = true;
        await gate;
        return { import_id: 'import_1', actor: 'alice', file_id: 'file_1', status: 'ready_for_review',
          version: 3, data: { candidates: [person], processed_block_ids: [], unprocessed_block_ids: [] } } as T;
      }
      if (op === 'commit_import') {
        formalWrites.push(input);
        return { status: 'committed', version: 4 } as T;
      }
      throw new Error(`Unexpected graph op ${op}`);
    }, close: async () => undefined,
  };
  const commitService = new ContactImportService({ graph, uploads: {} as never, jobs: {} as never,
    parse: async () => [], extract: async () => ({ candidates: [], warnings: [],
      processedBlockIds: [], unprocessedBlockIds: [] }) });
  const h = await setup({ now: () => now, sourceEnabled: () => enabled, commitService });
  await ready(h);
  const pending = confirm(h);
  await vi.waitFor(() => expect(reading).toBe(true));
  if (reason === 'exit') expect((await fetch(`${h.base}/contact-upload/exit`, {
    method: 'POST', headers: { ...h.headers, Origin: h.base } })).status).toBe(200);
  if (reason === 'disabled') enabled = false;
  if (reason === 'expired') now = 2 * 60 * 60_000;
  release();
  expect((await pending).status).toBe(401);
  expect(formalWrites).toEqual([]);
});

it.each(['disabled', 'expired'] as const)('denies HTTP receipt retry after source %s', async reason => {
  let enabled = true;
  let now = 0;
  const h = await setup({ now: () => now, sourceEnabled: () => enabled });
  await ready(h);
  expect((await confirm(h)).status).toBe(200);
  if (reason === 'disabled') enabled = false;
  else now = 2 * 60 * 60_000;
  expect((await confirm(h)).status).toBe(401);
});

it('admits only one concurrent upload and permits retry after a failed multipart upload', async () => {
  const h = await setup();
  const malformed = await fetch(`${h.base}/contact-files`, { method: 'POST', headers: h.headers, body: 'bad' });
  expect(malformed.status).toBe(415);
  const responses = await Promise.all([h.upload(), h.upload()]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
});

it('rejects cross-session reads and commits, stale versions, and duplicate suggestions', async () => {
  const h = await setup();
  await h.upload();
  await fetch(`${h.base}/contact-upload/import`, { method: 'POST', headers: h.headers });
  const other = h.sessions.create('alice', 'source');
  const otherHeaders = { Authorization: `Bearer ${other.sessionId}.${other.bearer}` };
  expect((await fetch(`${h.base}/contact-upload/import`, { headers: otherHeaders })).status).toBe(409);
  expect((await fetch(`${h.base}/contact-upload/commit`, { method: 'POST', headers: otherHeaders })).status).toBe(409);
  const stale = await fetch(`${h.base}/contact-upload/commit`, { method: 'POST', headers: {
    ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_version: 2 }) });
  expect(stale.status).toBe(409);
  h.get.mockResolvedValueOnce(previewPage(0, 1, { match_suggestions: [{ kind: 'duplicate' }] }));
  const duplicate = await fetch(`${h.base}/contact-upload/commit`, { method: 'POST', headers: {
    ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_version: 3 }) });
  expect(duplicate.status).toBe(409);
  expect(h.formalWrites).toEqual([]);
});

it.each([
  ['missing candidates', { candidates: undefined }],
  ['wrong candidate count', { candidates: [] }],
  ['missing candidate ID', { candidates: [{}] }],
  ['duplicate candidate IDs', { total_candidates: 2, candidates: [{ candidate_id: 'c_1' }, { candidate_id: 'c_1' }] }],
  ['wrong import', { import_id: 'import_other' }],
  ['nonnumeric total', { total_candidates: '1' }],
  ['invalid total', { total_candidates: -1 }],
  ['wrong first offset', { offset: 1 }],
  ['missing processed coverage', { processed_block_ids: undefined }],
  ['missing unprocessed coverage', { unprocessed_block_ids: undefined }],
  ['invalid processed coverage', { processed_block_ids: ['b_1', null] }],
  ['unprocessed original blocks', { unprocessed_block_ids: ['b_2'] }],
  ['unknown original coverage', { coverage_available: false }],
] as const)('fails closed for %s at HTTP confirmation', async (_name, patch) => {
  const h = await setup();
  await ready(h);
  h.get.mockResolvedValueOnce(previewPage(0, 1, patch));
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'MANUAL_REVIEW_REQUIRED', import_id: 'import_1' });
  expect(h.formalWrites).toEqual([]);
});

it.each([
  ['missing page', null],
  ['wrong import', { import_id: 'import_other' }],
  ['wrong status', { status: 'failed' }],
  ['wrong version', { version: 4 }],
  ['wrong total', { total_candidates: 50 }],
  ['wrong offset', { offset: 0 }],
  ['short page', { candidates: [] }],
  ['duplicate from earlier page', { candidates: [{ candidate_id: 'c_1' }] }],
  ['different processed coverage', { processed_block_ids: ['b_2'] }],
  ['different unprocessed coverage', { unprocessed_block_ids: ['b_2'] }],
  ['unavailable original coverage', { coverage_available: false }],
] as const)('fails closed for a subsequent %s during confirmation reread', async (_name, patch) => {
  const h = await setup();
  await ready(h);
  h.get.mockResolvedValueOnce(previewPage(0, 51));
  h.get.mockResolvedValueOnce(patch === null ? null : previewPage(50, 51, patch));
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'MANUAL_REVIEW_REQUIRED', import_id: 'import_1' });
  expect(h.formalWrites).toEqual([]);
});

function realReviewService(data: Record<string, unknown>, laterData?: Record<string, unknown>, laterVersion = 3,
  matching?: 'duplicate' | 'truncated' | 'failure') {
  const formalWrites: unknown[] = [];
  let reads = 0;
  const person = ImportCandidateSchema.parse({ candidate_id: 'c_1', label: 'Person',
    properties: { name: '陈晓' }, extensions: { hobbies: [], instantMessaging: [] },
    evidence: [{ evidence_id: 'e_1', subject_kind: 'entity', subject_id: 'c_1', field_path: 'properties.name',
      value: '陈晓', source_type: 'file', file_name: 'resume.pdf', file_sha256: 'a'.repeat(64), quote: '陈晓',
      page: 1, locator_status: 'located', collected_at: '2026-09-29T00:00:00.000Z' }],
    relation_suggestions: [], warnings: [], can_commit: true });
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, input: unknown): Promise<T> => {
      if (op === 'get_import_job') {
        reads++;
        return { import_id: 'import_1', actor: 'alice', file_id: 'file_1', status: 'ready_for_review', version: reads > 1 ? laterVersion : 3,
          data: { candidates: [person], ...(reads > 1 && laterData ? laterData : data) } } as T;
      }
      if (op === 'search_keyword') {
        if (matching === 'failure') throw new Error('private matching dependency unavailable');
        const items = matching === 'duplicate'
          ? [{ entity_id: 'existing_1', label: 'Person', name: '陈晓' }] : [];
        return { items, total: matching === 'truncated' ? 51 : items.length } as T;
      }
      if (op === 'find_identity_candidates') {
        if (matching === 'failure') throw new Error('private matching dependency unavailable');
        return { entity_ids: matching === 'duplicate' ? ['existing_1'] : [], truncated: matching === 'truncated' } as T;
      }
      if (op === 'get_contact') return { entity: { entity_id: 'existing_1', label: 'Person',
        properties: { name: '陈晓', telephone: ['13800138000'] },
        metadata: { version: 1, created_at: '2026-09-29T00:00:00.000Z', updated_at: '2026-09-29T00:00:00.000Z' } }, evidence: [] } as T;
      if (op === 'commit_import') {
        formalWrites.push(input);
        return { import_id: 'import_1', status: 'committed', version: 4 } as T;
      }
      throw new Error(`Unexpected graph op ${op}`);
    }, close: async () => undefined,
  };
  const service = new ContactImportService({ graph, uploads: {} as never, jobs: {} as never,
    parse: async () => [], extract: async () => ({ candidates: [], warnings: [], processedBlockIds: [], unprocessedBlockIds: [] }) });
  return { service, formalWrites, person };
}

it.each([
  ['both original fields missing', {}],
  ['original processed missing', { unprocessed_block_ids: [] }],
  ['original unprocessed missing', { processed_block_ids: ['b_1'] }],
  ['original processed null', { processed_block_ids: null, unprocessed_block_ids: [] }],
  ['original unprocessed null', { processed_block_ids: ['b_1'], unprocessed_block_ids: null }],
  ['invalid original processed IDs', { processed_block_ids: [null], unprocessed_block_ids: [] }],
  ['invalid original unprocessed IDs', { processed_block_ids: ['b_1'], unprocessed_block_ids: [null] }],
] as const)('rejects %s through real get() and never sends a formal graph write', async (_name, data) => {
  const review = realReviewService(data);
  const h = await setup({ reviewService: review.service });
  await ready(h);
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'MANUAL_REVIEW_REQUIRED', import_id: 'import_1' });
  expect(review.formalWrites).toEqual([]);
});

it('marks missing original coverage unavailable while preserving legacy fallback arrays and commit choices', async () => {
  const review = realReviewService({});
  expect(await review.service.get('import_1', 'alice')).toMatchObject({
    coverage_available: false, processed_block_ids: [], unprocessed_block_ids: [] });
  expect(await review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', choices: [{ candidate_id: 'c_1', action: 'create' }] }, 'alice'))
    .toMatchObject({ status: 'committed' });
  expect(review.formalWrites).toHaveLength(1);
});

it.each([{ processed: [] }, { processed: ['b_1'] }])('accepts valid original coverage through actual get and commit: $processed', async ({ processed }) => {
  const review = realReviewService({ processed_block_ids: processed, unprocessed_block_ids: [] });
  const h = await setup({ reviewService: review.service });
  await ready(h);
  expect((await confirm(h)).status).toBe(200);
  expect(review.formalWrites).toHaveLength(1);
  expect(await review.service.get('import_1', 'alice')).toMatchObject({ coverage_available: true });
});

it('rejects original coverage missing on a later page through the actual get boundary', async () => {
  const { person } = realReviewService({});
  const candidates = Array.from({ length: 51 }, (_, n) => ({ ...person, candidate_id: `c_${n + 1}`,
    ...(n > 0 ? { can_commit: false, warnings: ['非主体人物线索'] } : {}) }));
  const review = realReviewService({ candidates, processed_block_ids: [], unprocessed_block_ids: [] },
    { candidates, processed_block_ids: [] });
  const h = await setup({ reviewService: review.service });
  await ready(h);
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'MANUAL_REVIEW_REQUIRED', import_id: 'import_1' });
  expect(review.formalWrites).toEqual([]);
});

it('confirms after rereading complete pages and identical full extraction coverage', async () => {
  const h = await setup();
  await ready(h);
  h.get.mockResolvedValueOnce(previewPage(0, 51));
  h.get.mockResolvedValueOnce(previewPage(50, 51));
  expect((await confirm(h)).status).toBe(200);
  expect(h.get).toHaveBeenCalledWith('import_1', 'alice', 0, 50);
  expect(h.get).toHaveBeenCalledWith('import_1', 'alice', 50, 50);
  expect(h.commit).toHaveBeenCalledTimes(1);
});

it.each(['expired', 'disabled', 'revoked', 'wrong-secret', 'invalid'] as const)(
  'exposes safe no-Cookie CORS errors for %s App credentials on every page API', async reason => {
    let now = 0;
    let enabled = true;
    const h = await setup({ now: () => now, sourceEnabled: () => enabled });
    let credential = `${h.session.sessionId}.${h.session.bearer}`;
    if (reason === 'expired') now = 2 * 60 * 60_000;
    if (reason === 'disabled') enabled = false;
    if (reason === 'revoked') h.sessions.revoke(h.session.sessionId);
    if (reason === 'wrong-secret') credential = `${h.session.sessionId}.wrong`;
    if (reason === 'invalid') credential = 'invalid-session';
    const headers = { Authorization: `Bearer ${credential}`, Origin: 'https://web-sandbox.oaiusercontent.com' };
    for (const [path, method] of [['/contact-files', 'POST'], ['/contact-upload/import', 'POST'],
      ['/contact-upload/import', 'GET'], ['/contact-upload/commit', 'POST'], ['/contact-upload/exit', 'POST']]) {
      const response = await fetch(`${h.base}${path}`, { method, headers });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'UPLOAD_SESSION_UNAUTHORIZED' });
    }
  });

it('keeps denied Cookie errors private from cross-origin credential requests', async () => {
  const h = await setup();
  const cookie = `contact-upload-dev-${h.session.sessionId}=${h.session.sessionId}.${h.session.bearer}`;
  for (const path of ['/contact-files', '/contact-upload/import', '/contact-upload/commit', '/contact-upload/exit']) {
    const response = await fetch(`${h.base}${path}`, { method: 'POST', headers: {
      Cookie: cookie, Origin: 'https://evil.example', 'X-Upload-Session': h.session.sessionId } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code: 'UPLOAD_ORIGIN_DENIED' });
  }
});

it('returns generic no-store CORS JSON for malformed App commit bodies', async () => {
  const h = await setup();
  const response = await fetch(`${h.base}/contact-upload/commit`, { method: 'POST',
    headers: { ...h.headers, Origin: 'https://web-sandbox.oaiusercontent.com', 'Content-Type': 'application/json' },
    body: '{"preview_version": private-invalid-json' });
  expect(response.status).toBe(400);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect(await response.json()).toEqual({ code: 'INVALID_UPLOAD_REQUEST' });
});

it('exchanges a same-origin handoff once and denies cross-origin cookie mutations', async () => {
  const h = await setup();
  const handoff = h.sessions.createHandoff('alice', 'source');
  const response = await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
    headers: { Origin: h.base, 'Content-Type': 'application/json' }, body: JSON.stringify(handoff) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const exchanged = await response.json() as { session_id: string };
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
    headers: { Origin: h.base, 'Content-Type': 'application/json' }, body: JSON.stringify(handoff) })).status).toBe(401);
  expect((await fetch(`${h.base}/contact-upload/import`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-Upload-Session': exchanged.session_id } })).status).toBe(403);
});


it.each([
  ['malformed', '{"code":EXCHANGE_PAYLOAD_CANARY}', 400, 'INVALID_UPLOAD_REQUEST'],
  ['oversized', JSON.stringify({ code: 'EXCHANGE_PAYLOAD_CANARY'.repeat(100) }), 413, 'UPLOAD_REQUEST_TOO_LARGE'],
] as const)('keeps %s exchange errors private, uncached and without credential CORS', async (_kind, body, status, code) => {
  vi.stubEnv('NODE_ENV', 'production');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const h = await setup();
    const response = await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
      headers: { Origin: h.base, ...h.headers, 'Content-Type': 'application/json' }, body });
    const text = await response.text();
    // Express finalhandler logs on a later turn; let that callback execute before asserting.
    await new Promise(resolve => setImmediate(resolve));
    expect.soft(response.status).toBe(status);
    expect.soft(response.headers.get('Cache-Control')).toBe('no-store');
    expect.soft(response.headers.get('Content-Type')).toContain('application/json');
    expect.soft(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect.soft(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect.soft(text).toBe(JSON.stringify({ code }));
    expect.soft(text).not.toContain('EXCHANGE_PAYLOAD_CANARY');
    expect(logged).not.toHaveBeenCalled();
  } finally { logged.mockRestore(); vi.unstubAllEnvs(); }
});

it('does not exchange a handoff for a foreign Origin even with a valid App Bearer', async () => {
  const h = await setup();
  const handoff = h.sessions.createHandoff('alice', 'source');
  const response = await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
    headers: { ...h.headers, Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
    body: JSON.stringify(handoff) });
  expect(response.status).toBe(403);
  expect(response.headers.get('Set-Cookie')).toBeNull();
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(h.sessions.exchange(handoff.code)).not.toBeNull();
});


it('returns a complete server decision for a single located subject', async () => {
  const review = realReviewService({ processed_block_ids: ['b_1'], unprocessed_block_ids: [] });
  const result = await review.service.getUploadPreview('import_1', 'alice');
  expect(result).toMatchObject({ total_candidates: 1, confirmation: { allowed: true, reasons: [] } });
  expect(result!.candidates).toHaveLength(1);
});

it.each([
  ['unknown coverage', {}],
  ['unprocessed coverage', { processed_block_ids: ['b_1'], unprocessed_block_ids: ['b_2'] }],
  ['matching failure', { processed_block_ids: [], unprocessed_block_ids: [], warnings: ['身份匹配查询失败，请人工核对已有联系人'] }],
  ['matching truncation', { processed_block_ids: [], unprocessed_block_ids: [], warnings: ['身份匹配结果已截断，可能遗漏已有联系人'] }],
  ['no subject', { processed_block_ids: [], unprocessed_block_ids: [], candidates: [] }],
] as const)('uses the service decision to deny %s in both preview and page commit', async (_name, data) => {
  const review = realReviewService(data);
  const result = await review.service.getUploadPreview('import_1', 'alice');
  expect(result!.confirmation.allowed).toBe(false);
  expect(result!.confirmation.reasons.length).toBeGreaterThan(0);
  await expect(review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', auto_create: true, require_confirmation: true }, 'alice'))
    .rejects.toThrow('MANUAL_REVIEW_REQUIRED');
  expect(review.formalWrites).toEqual([]);
});

it('rejects multiple real subjects and an unlocated sole subject with the same owner selection used by auto_create', async () => {
  const { person } = realReviewService({});
  for (const candidates of [[person, { ...person, candidate_id: 'c_2' }],
    [{ ...person, evidence: person.evidence.map(proof => ({ ...proof, locator_status: 'unavailable' })) }]]) {
    const review = realReviewService({ candidates, processed_block_ids: [], unprocessed_block_ids: [] });
    expect((await review.service.getUploadPreview('import_1', 'alice'))!.confirmation.allowed).toBe(false);
  }
});

it('returns the full later-page candidate and refuses its matching blocker', async () => {
  const { person } = realReviewService({});
  const candidates = Array.from({ length: 51 }, (_, n) => ({ ...person, candidate_id: `c_${n + 1}`,
    ...(n > 0 ? { can_commit: false, warnings: ['非主体人物线索'] } : {}) }));
  const data = { candidates, processed_block_ids: ['b_1'], unprocessed_block_ids: [] };
  const review = realReviewService(data, { ...data, warnings: ['身份匹配结果已截断，可能遗漏已有联系人'] });
  const result = await review.service.getUploadPreview('import_1', 'alice');
  expect(result!.candidates).toHaveLength(51);
  expect((result!.candidates.at(-1) as { candidate_id: string }).candidate_id).toBe('c_51');
  expect(result!.confirmation.allowed).toBe(false);
  await expect(review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', auto_create: true, require_confirmation: true }, 'alice'))
    .rejects.toThrow('MANUAL_REVIEW_REQUIRED');
  expect(review.formalWrites).toEqual([]);
});

it('rereads server policy after GET before accepting the HTTP confirmation', async () => {
  const review = realReviewService({ processed_block_ids: ['b_1'], unprocessed_block_ids: [] },
    { processed_block_ids: ['b_1'], unprocessed_block_ids: ['b_2'] });
  const h = await setup({ reviewService: review.service });
  await ready(h);
  const shown = await fetch(`${h.base}/contact-upload/import`, { headers: h.headers });
  expect((await shown.json() as any).confirmation?.allowed).toBe(true);
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'MANUAL_REVIEW_REQUIRED', import_id: 'import_1' });
  expect(review.formalWrites).toEqual([]);
});


it.each(['duplicate', 'truncated', 'failure'] as const)('denies an actual %s matching result in the server decision and commit', async matching => {
  const { person } = realReviewService({});
  const review = realReviewService({ candidates: [{ ...person, properties: { ...person.properties, telephone: ['13800138000'] } }],
    processed_block_ids: ['b_1'], unprocessed_block_ids: [] }, undefined, 3, matching);
  const result = await review.service.getUploadPreview('import_1', 'alice');
  expect(result!.confirmation.allowed).toBe(false);
  if (matching === 'duplicate') expect(result!.match_suggestions).toHaveLength(1);
  await expect(review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', auto_create: true, require_confirmation: true }, 'alice'))
    .rejects.toThrow('MANUAL_REVIEW_REQUIRED');
  expect(review.formalWrites).toEqual([]);
});

it('rejects a job version changed after the complete decision and before auto selection', async () => {
  const review = realReviewService({ processed_block_ids: ['b_1'], unprocessed_block_ids: [] }, undefined, 4);
  await expect(review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', auto_create: true, require_confirmation: true }, 'alice'))
    .rejects.toThrow('PREVIEW_VERSION_CHANGED');
  expect(review.formalWrites).toEqual([]);
});

it('preserves the anonymous institution subject rule in the server decision', async () => {
  const { person } = realReviewService({});
  const relation = { source_candidate_id: 'c_1', target_candidate_id: 'org_1', relation_type: 'worksFor',
    properties: {}, evidence: [{ ...person.evidence[0], subject_kind: 'relation', subject_id: 'r_1',
      field_path: '$relation', value: { source_id: 'c_1', target_id: 'org_1', relation_type: 'worksFor' }, quote: '本人任职测试公司' }] };
  const candidates = [{ ...person, properties: {}, evidence: [], relation_suggestions: [relation] }];
  const review = realReviewService({ candidates, processed_block_ids: ['b_1'], unprocessed_block_ids: [] });
  expect((await review.service.getUploadPreview('import_1', 'alice'))!.confirmation.allowed).toBe(true);
  await review.service.commit({ import_id: 'import_1', preview_version: 3,
    operation_id: 'contact-import:import_1', auto_create: true, require_confirmation: true }, 'alice');
  expect(review.formalWrites).toHaveLength(1);
});


it('reports a final transactional graph version conflict as a refreshable preview conflict', async () => {
  const h = await setup();
  await ready(h);
  h.commit.mockRejectedValueOnce(new GraphClientError('VERSION_CONFLICT'));
  const response = await confirm(h);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'PREVIEW_VERSION_CHANGED' });
  expect(h.formalWrites).toEqual([]);
});


it('retains the bound import number when complete GET rejects malformed page identity', async () => {
  const h = await setup();
  await ready(h);
  h.get.mockResolvedValueOnce(previewPage(0, 1, { import_id: 'import_other' }));
  const response = await fetch(`${h.base}/contact-upload/import`, { headers: h.headers });
  expect(await response.json()).toMatchObject({ import_id: 'import_1', confirmation: { allowed: false } });
});
