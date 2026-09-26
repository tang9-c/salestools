import { describe, expect, it } from 'vitest';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import { ImportCandidateSchema } from '../src/contracts/index.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import type { UploadStore, UploadedFile } from '../src/contacts/upload-store.js';

const file: UploadedFile = {
  fileId: 'file-1', fileName: 'invented.pdf', sha256: 'a'.repeat(64),
  mime: 'application/pdf', tempPath: '/tmp/invented.pdf', uploadedAt: '2026-09-26T00:00:00.000Z',
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

function harness() {
  const state = { job: null as Record<string, unknown> | null, calls: [] as GraphOp[],
    runCount: 0, released: 0, fileAvailable: true };
  const graph: GraphClient = {
    request: async <T>(op: GraphOp, payload: unknown): Promise<T> => {
      state.calls.push(op);
      const input = payload as Record<string, unknown>;
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
  const service = new ContactImportService({ graph, uploads, jobs,
    parse: async () => [{ block_id: 'b_1', text: '陈晓', page: 1 }],
    extract: async () => {
      state.runCount += 1;
      return { candidates: [candidate], warnings: [], processedBlockIds: ['b_1'], unprocessedBlockIds: [] };
    },
  });
  return { state, service, jobs };
}

describe('reviewed contact imports', () => {
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
