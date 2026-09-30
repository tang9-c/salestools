import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import { UploadSessions } from '../src/contacts/upload-session.js';
import { UploadStore } from '../src/contacts/upload-store.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import { ImportCandidateSchema } from '../src/contracts/index.js';

const pdf = readFileSync(new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });

function previewPage(offset = 0, total = 1, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { import_id: 'import_1', status: 'ready_for_review', version: 3, total_candidates: total,
    candidates: Array.from({ length: Math.min(50, Math.max(0, total - offset)) }, (_, n) => ({ candidate_id: `c_${offset + n + 1}` })),
    warnings: [], match_suggestions: [], match_suggestions_truncated: false,
    processed_block_ids: ['b_1'], unprocessed_block_ids: [], coverage_available: true, offset, limit: 50, ...patch };
}

async function setup(options: { now?: () => number; sourceEnabled?: () => boolean;
  commitService?: ContactImportService; reviewService?: ContactImportService } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'upload-session-http-'));
  const store = new UploadStore({ directory, maxPendingFiles: 10,
    maxFileBytes: 20 * 1024 * 1024, maxTempBytes: 100 * 1024 * 1024 });
  const sessions = new UploadSessions(options.sourceEnabled ?? (() => true), options.now);
  const start = vi.fn(async () => ({ import_id: 'import_1' }));
  const get = vi.fn(async (importId: string, actor: string, offset = 0, limit = 20): Promise<Record<string, unknown> | null> =>
    options.reviewService ? options.reviewService.get(importId, actor, offset, limit) : previewPage());
  const commit = vi.fn(async (...args: [Parameters<ContactImportService['commit']>[0], string, (() => void)?]) =>
    options.reviewService ? options.reviewService.commit(...args) : options.commitService ? options.commitService.commit(...args) : { status: 'committed', version: 4, candidates: ['private'],
      results: [{ entity_id: 'person_1' }] });
  const imports = { start, get, commit } as unknown as ContactImportService;
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
  return { base, store, sessions, session, headers, upload, start, get, commit };
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
  const cookie = `contact-upload-dev=${h.session.sessionId}.${h.session.bearer}`;
  const headers = { Cookie: cookie, Origin: h.base } as unknown as typeof h.headers;
  const first = confirm(h, 3, headers);
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
  const second = confirm(h, 3, headers);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(results[0].headers.get('set-cookie')).toBeNull();
  expect((await confirm(h, 3, { Cookie: cookie, Origin: 'https://evil.example' } as unknown as typeof h.headers)).status).toBe(403);
  expect((await confirm(h, 3, headers)).status).toBe(200);
  const exit = await fetch(`${h.base}/contact-upload/exit`, { method: 'POST', headers });
  expect(exit.status).toBe(200);
  expect(exit.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await confirm(h, 3, headers)).status).toBe(401);
});

it('exits a Cookie session only from the exact origin', async () => {
  const h = await setup();
  const cookie = `contact-upload-dev=${h.session.sessionId}.${h.session.bearer}`;
  expect((await fetch(`${h.base}/contact-upload/exit`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
  expect(h.sessions.authorize(h.session.sessionId, h.session.bearer)).not.toBeNull();
  expect((await fetch(`${h.base}/contact-upload/exit`, { method: 'POST',
    headers: { Cookie: cookie, Origin: h.base } })).status).toBe(200);
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
          version: 3, data: { candidates: [person] } } as T;
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
  expect(h.commit).not.toHaveBeenCalled();
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
  expect(h.commit).not.toHaveBeenCalled();
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
  expect(h.commit).not.toHaveBeenCalled();
});

function realReviewService(data: Record<string, unknown>, laterData?: Record<string, unknown>) {
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
        return { import_id: 'import_1', actor: 'alice', file_id: 'file_1', status: 'ready_for_review', version: 3,
          data: { candidates: [person], ...(reads > 1 && laterData ? laterData : data) } } as T;
      }
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
  const cookie = `contact-upload-dev=${h.session.sessionId}.${h.session.bearer}`;
  for (const path of ['/contact-files', '/contact-upload/import', '/contact-upload/commit', '/contact-upload/exit']) {
    const response = await fetch(`${h.base}${path}`, { method: 'POST', headers: {
      Cookie: cookie, Origin: 'https://evil.example' } });
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
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await fetch(`${h.base}/contact-upload/exchange`, { method: 'POST',
    headers: { Origin: h.base, 'Content-Type': 'application/json' }, body: JSON.stringify(handoff) })).status).toBe(401);
  expect((await fetch(`${h.base}/contact-upload/import`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
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
