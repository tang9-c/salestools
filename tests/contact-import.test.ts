import { describe, expect, it, vi } from 'vitest';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { ImportCandidateSchema } from '../src/contracts/index.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import type { UploadStore, UploadedFile } from '../src/contacts/upload-store.js';

const file: UploadedFile = {
  fileId: 'file-1', fileName: 'invented.pdf', sha256: 'a'.repeat(64),
  mime: 'application/pdf', tempPath: '/tmp/invented.pdf', uploadedAt: '2026-09-26T00:00:00.000Z',
  actor: 'reviewer',
};
const candidate = ImportCandidateSchema.parse({
  candidate_id: 'c_1', label: 'Person', properties: { name: '陈晓' },
  extensions: { hobbies: [], instantMessaging: [] }, evidence: [],
  relation_suggestions: [], warnings: [], can_commit: true,
});

async function eventually(assertion: () => void): Promise<void> {
  for (let n = 0; n < 100; n += 1) {
    try { assertion(); return; } catch { await new Promise(resolve => setTimeout(resolve, 2)); }
  }
  assertion();
}

function harness(overrides: Partial<ConstructorParameters<typeof ContactImportService>[0]> = {}) {
  const state = { job: null as Record<string, unknown> | null, calls: [] as GraphOp[],
    runCount: 0, released: 0, fileAvailable: true, lastCommit: null as Record<string, unknown> | null };
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      state.calls.push(op);
      const input = payload as Record<string, unknown>;
      if ((op as string) === 'get_import_start') {
        if (!state.job || input.operation_id !== state.job.operation_id) return null as T;
        if (input.actor !== state.job.actor || input.file_id !== state.job.file_id) throw new Error('OPERATION_CONFLICT');
        return { import_id: state.job.import_id, replayed: true } as T;
      }
      if (op === 'put_import_job') {
        if (!state.job) {
          state.job = { import_id: 'ci_1', file_id: input.file_id, actor: input.actor,
            status: 'queued', version: 1, data: input.data, operation_id: input.operation_id };
          return { import_id: 'ci_1', version: 1, replayed: false } as T;
        }
        if (input.import_id === undefined) {
          if (input.operation_id === state.job.operation_id && input.actor === state.job.actor) {
            if (JSON.stringify(input.data) !== JSON.stringify({ candidates: [] })) throw new Error('OPERATION_CONFLICT');
            return { import_id: 'ci_1', version: 1, replayed: true } as T;
          }
          throw new Error('FILE_ALREADY_USED');
        }
        if (input.expected_version !== state.job.version) throw new Error('VERSION_CONFLICT');
        state.job = { ...state.job, status: input.status, version: Number(state.job.version) + 1,
          data: input.data };
        return { import_id: 'ci_1', version: Number(state.job?.version), replayed: false } as T;
      }
      if (op === 'get_import_job') return state.job as T;
      if (op === 'commit_import') {
        state.lastCommit = input;
        if (input.expected_version !== state.job?.version) throw new Error('VERSION_CONFLICT');
        state.job = { ...state.job, status: 'committed', version: Number(state.job?.version) + 1 };
        return { import_id: 'ci_1', status: 'committed', version: state.job.version } as T;
      }
      throw new Error(`Unexpected graph op ${op}`);
    },
    close: async () => undefined,
  };
  const uploads = { get: (id: string) => state.fileAvailable && id === file.fileId ? file : null,
    markSubmitted: () => file } as unknown as UploadStore;
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 10_000,
    submit: () => undefined, release: async () => { state.released += 1; } });
  const newService = () => new ContactImportService({ graph, uploads, jobs,
    parse: async () => [{ block_id: 'b_1', text: '陈晓', page: 1 }],
    extract: async () => {
      state.runCount += 1;
      return { candidates: [candidate], warnings: [], processedBlockIds: ['b_1'], unprocessedBlockIds: [] };
    }, ...overrides,
  });
  const service = newService();
  return { state, service, jobs, newService, graph };
}

describe('reviewed contact imports', () => {
  it('logs terminal storage failure separately from the original parser failure without private text', async () => {
    const events: unknown[] = [];
    const h = harness({ parse: async () => { throw new Error('CONVERSION_FAILED'); },
      onEvent: event => events.push(event) });
    const request = h.graph.request;
    h.graph.request = async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      if (op === 'put_import_job' && (payload as Record<string, unknown>).status === 'failed') {
        throw new Error('private database path and document');
      }
      return request<T>(op, payload);
    };
    await h.service.start({ file_id: file.fileId, operation_id: 'write-fails' }, 'reviewer');
    await eventually(() => expect(events).toContainEqual(expect.objectContaining({ stage: 'persist',
      outcome: 'failed', failure: expect.objectContaining({ code: 'IMPORT_STATE_WRITE_FAILED' }) })));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'parse', outcome: 'failed',
      failure: expect.objectContaining({ code: 'CONVERSION_FAILED' }) }));
    expect(JSON.stringify(events)).not.toContain('private');
    expect(h.state.released).toBe(1);
  });

  it('keeps a safe parse failure on the task without retaining exception text', async () => {
    const error = Object.assign(new Error('CONVERSION_FAILED'), { code: 'CONVERSION_FAILED' });
    const h = harness({ parse: async () => { throw error; } });
    const started = await h.service.start({ file_id: file.fileId, operation_id: 'diagnostic-parse' }, 'reviewer');
    await eventually(() => expect(h.state.job?.status).toBe('failed'));
    const preview = await h.service.get(started.import_id, 'reviewer');
    expect(preview?.failure).toMatchObject({ stage: 'parse', code: 'CONVERSION_FAILED' });
    expect(h.state.runCount).toBe(0);
    expect(h.state.released).toBe(1);
  });

  it('reports an unknown model error without exposing its response or credentials', async () => {
    const h = harness({ extract: async () => { throw new Error('private document 13800138000 secret=private-token'); } });
    await h.service.start({ file_id: file.fileId, operation_id: 'diagnostic-model' }, 'reviewer');
    await eventually(() => expect(h.state.job?.status).toBe('failed'));
    const preview = await h.service.get('ci_1', 'reviewer');
    expect(preview?.failure).toMatchObject({ stage: 'extract', code: 'IMPORT_FAILED' });
    expect(JSON.stringify(preview)).not.toContain('private document');
    expect(JSON.stringify(preview)).not.toContain('private-token');
  });

  it('saves failure even when the diagnostic log sink is unavailable', async () => {
    const h = harness({ parse: async () => { throw new Error('CONVERSION_FAILED'); },
      onEvent: () => { throw new Error('broken sink'); } });
    await h.service.start({ file_id: file.fileId, operation_id: 'broken-log' }, 'reviewer');
    await eventually(() => expect(h.state.job?.status).toBe('failed'));
    expect((await h.service.get('ci_1', 'reviewer'))?.failure).toMatchObject({ stage: 'parse', code: 'CONVERSION_FAILED' });
    expect(h.state.released).toBe(1);
  });

  it('does not invent diagnostic details for an old failed task', async () => {
    const h = harness();
    h.state.job = { import_id: 'ci_1', actor: 'reviewer', status: 'failed', version: 3,
      data: { candidates: [], warnings: ['IMPORT_FAILED'] } };
    expect((await h.service.get('ci_1', 'reviewer'))?.failure).toBeNull();
  });
  it('replays an old start after more than 1000 later imports and file cleanup', async () => {
    const starts = new Map<string, { import_id: string; actor: string; file_id: string }>();
    let available = true;
    let parsed = 0;
    let released = 0;
    const graph: GraphClient = {
      request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
        const input = payload as Record<string, unknown>;
        if (op === 'get_import_start') {
          const prior = starts.get(String(input.operation_id));
          if (!prior) return null as T;
          if (prior.actor !== input.actor || prior.file_id !== input.file_id) throw new Error('OPERATION_CONFLICT');
          return { import_id: prior.import_id, replayed: true } as T;
        }
        if (op === 'put_import_job') {
          if (input.import_id) return { import_id: input.import_id, version: Number(input.expected_version) + 1 } as T;
          const result = { import_id: `import-${starts.size}`, actor: String(input.actor), file_id: String(input.file_id) };
          starts.set(String(input.operation_id), result);
          return { import_id: result.import_id, version: 1, replayed: false } as T;
        }
        throw new Error(`Unexpected graph op ${op}`);
      },
      close: async () => undefined,
    };
    const uploads = { get: (id: string) => available ? { ...file, fileId: id } : null,
      markSubmitted: () => file } as unknown as UploadStore;
    const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 10_000,
      release: async () => { released++; } });
    const service = new ContactImportService({ graph, uploads, jobs,
      parse: async () => { parsed++; return []; },
      extract: async () => ({ candidates: [], warnings: [], processedBlockIds: [], unprocessedBlockIds: [] }) });
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      for (let n = 0; n < 1001; n++) {
        clock += 60_000;
        await service.start({ file_id: `file-${n}`, operation_id: `start-${n}` }, 'reviewer');
      }
    } finally { now.mockRestore(); }
    await eventually(() => expect(released).toBe(1001));
    available = false;
    expect(await service.start({ file_id: 'file-0', operation_id: 'start-0' }, 'reviewer'))
      .toEqual({ import_id: 'import-0' });
    expect(parsed).toBe(1001);
  });

  it('replays start after a service restart and file cleanup through a read-only durable lookup', async () => {
    const h = harness();
    const original = await h.service.start({ file_id: file.fileId, operation_id: 'start-1' }, 'reviewer');
    await eventually(() => expect(h.state.job?.status).toBe('ready_for_review'));
    h.state.fileAvailable = false;
    h.state.calls.length = 0;
    expect(await h.newService().start({ file_id: file.fileId, operation_id: 'start-1' }, 'reviewer')).toEqual(original);
    expect(h.state.calls).toEqual(['get_import_start']);
    expect(h.state.runCount).toBe(1);
    await expect(h.newService().start({ file_id: file.fileId, operation_id: 'start-1' }, 'other-user'))
      .rejects.toThrow('OPERATION_CONFLICT');
    await expect(h.newService().start({ file_id: 'different-file', operation_id: 'start-1' }, 'reviewer'))
      .rejects.toThrow('OPERATION_CONFLICT');
    expect(h.state.calls).not.toContain('put_import_job');
  });

  it('rejects another user before creating an import job for the uploaded file', async () => {
    const { state, service } = harness();
    await expect(service.start({ file_id: file.fileId, operation_id: 'stolen-file' }, 'other-user'))
      .rejects.toThrow('IMPORT_ACCESS_DENIED');
    expect(state.calls).toEqual([]);
    expect(state.job).toBeNull();
  });

  it('previews without formal graph writes, replays the start, and commits only after confirmation', async () => {
    const { state, service } = harness();
    const started = await service.start({ file_id: file.fileId, operation_id: 'start-1' }, 'reviewer');
    expect(started.import_id).toBe('ci_1');
    await eventually(() => expect(state.job?.status).toBe('ready_for_review'));
    expect(state.runCount).toBe(1);
    expect(state.calls).not.toContain('save_contact');
    expect(state.calls).not.toContain('commit_import');
    const preview = await service.get('ci_1', 'reviewer', 0, 1);
    expect(preview).toMatchObject({ status: 'ready_for_review', total_candidates: 1,
      candidates: [{ candidate_id: 'c_1' }] });
    await expect(service.get('ci_1', 'other-user')).rejects.toThrow('IMPORT_ACCESS_DENIED');
    state.fileAvailable = false;
    expect(await service.start({ file_id: file.fileId, operation_id: 'start-1' }, 'reviewer'))
      .toEqual(started);
    expect(state.runCount).toBe(1);
    const committed = await service.commit({ import_id: 'ci_1', preview_version: 3,
      operation_id: 'contact-import:ci_1', choices: [{ candidate_id: 'c_1', action: 'create' }] }, 'reviewer');
    expect(committed.status).toBe('committed');
    expect(state.calls.filter(op => op === 'commit_import')).toHaveLength(1);
  });

  it('requires the fixed commit id and refuses pagination outside the bounded range', async () => {
    const { service } = harness();
    await expect(service.commit({ import_id: 'ci_1', preview_version: 3,
      operation_id: 'other', choices: [] }, 'reviewer')).rejects.toThrow('operation_id');
    await expect(service.get('ci_1', 'reviewer', -1, 20)).rejects.toThrow('pagination');
    await expect(service.get('ci_1', 'reviewer', 0, 51)).rejects.toThrow('pagination');
  });
});

it.each([false, true])('does not select an education relation with missing or mismatched optional evidence: %j', async wrong => {
  const proof = (subject_kind: string, subject_id: string, field_path: string, value: unknown) => ({ evidence_id: field_path,
    subject_kind, subject_id, field_path, value, source_type: 'file', file_name: 'resume.pdf', file_sha256: 'abc',
    quote: '陈晓就读学校', locator_status: 'located', collected_at: '2026-10-09T00:00:00.000Z' });
  const person = ImportCandidateSchema.parse({ ...candidate, evidence: [proof('entity', 'c_1', 'properties.name', '陈晓')],
    relation_suggestions: [{ source_candidate_id: 'c_1', target_candidate_id: 'school', relation_type: 'alumniOf', properties: { major: '软件工程' },
      evidence: [proof('relation', 'c_1:school', '$relation', { relation_type: 'alumniOf', source_id: 'c_1', target_id: 'school' }),
        ...(wrong ? [proof('relation', 'c_1:school', 'properties.major', '其他专业')] : [])], uncertain: false }] });
  const school = ImportCandidateSchema.parse({ candidate_id: 'school', label: 'Organization', properties: { name: '学校' },
    evidence: [proof('entity', 'school', 'properties.name', '学校')], can_commit: true });
  const { service, state } = harness({ extract: async () => ({ candidates: [person, school], warnings: [], processedBlockIds: ['b_1'], unprocessedBlockIds: [] }) });
  await service.start({ file_id: file.fileId, operation_id: 'education-start' }, 'reviewer');
  await eventually(() => expect(state.job?.status).toBe('ready_for_review'));
  await service.commit({ import_id: 'ci_1', preview_version: Number(state.job!.version), operation_id: 'contact-import:ci_1', auto_create: true }, 'reviewer');
  expect(state.lastCommit?.choices).toEqual([{ candidate_id: 'c_1', action: 'create' }, { candidate_id: 'school', action: 'create' }]);
  expect(state.lastCommit?.relation_choices).toEqual([]);
});
