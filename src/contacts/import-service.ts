import { ContactEntitySchema, ContactEvidenceSchema, ImportCandidateSchema,
  type ImportCandidate, type ParsedBlock } from '../contracts/index.js';
import type { GraphClient } from './graph-client.js';
import type { ImportJobs } from './import-jobs.js';
import type { UploadedFile, UploadStore } from './upload-store.js';
import { normalizePhoneForSuggestion, suggestMatches, type MatchSuggestion } from './identity-match.js';

export interface ExtractedDocument {
  candidates: ImportCandidate[];
  warnings: string[];
  processedBlockIds: string[];
  unprocessedBlockIds: string[];
}

interface ImportJob {
  import_id: string;
  file_id: string;
  actor: string;
  status: 'queued' | 'processing' | 'ready_for_review' | 'committed' | 'failed' | 'cancelled';
  version: number;
  data: Record<string, unknown>;
}

interface JobWriteResult { import_id: string; version: number; replayed: boolean }

function identityValues(candidate: ImportCandidate): { phones: string[]; emails: string[]; accounts: string[] } {
  if (candidate.label !== 'Person') return { phones: [], emails: [], accounts: [] };
  const ownPoints = candidate.properties.contactPoint.filter(point =>
    /^(self|personal|本人|私人)$/iu.test(point.contactType));
  return {
    phones: [...new Set([...candidate.properties.telephone, ...ownPoints.flatMap(point => point.telephone)]
      .map(normalizePhoneForSuggestion).filter(Boolean))],
    emails: [...new Set([...candidate.properties.email, ...ownPoints.flatMap(point => point.email)]
      .map(value => value.trim().toLowerCase()).filter(Boolean))],
    accounts: [...new Set(candidate.extensions.instantMessaging.map(account =>
      `${account.platform.toLowerCase()}\0${account.accountId}`))],
  };
}

export class ContactImportService {
  constructor(private readonly options: {
    graph: GraphClient;
    uploads: UploadStore;
    jobs: ImportJobs;
    parse: (file: UploadedFile, signal: AbortSignal) => Promise<ParsedBlock[]>;
    extract: (blocks: ParsedBlock[], file: UploadedFile, signal: AbortSignal) => Promise<ExtractedDocument>;
    onCommitted?: (entityIds: string[]) => Promise<void> | void;
  }) {}

  async start(input: { file_id: string; operation_id: string }, actor: string): Promise<{ import_id: string }> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    const file = this.options.uploads.get(input.file_id);
    // A replay is allowed after the original temporary file has been removed.
    const result = await this.options.graph.request<JobWriteResult>('put_import_job', {
      operation_id: input.operation_id, actor, file_id: input.file_id,
      status: 'queued', data: { candidates: [] },
    });
    if (result.replayed) return { import_id: result.import_id };
    if (!file) {
      await this.transition(result.import_id, input.file_id, 1, 'failed',
        { candidates: [], warnings: ['uploaded_file_missing'] });
      throw new Error('UPLOADED_FILE_MISSING');
    }
    const importId = result.import_id;
    try { this.options.uploads.markSubmitted(file.fileId); }
    catch (error) {
      await this.transition(importId, file.fileId, 1, 'failed',
        { candidates: [], source: this.source(file), warnings: ['uploaded_file_missing'] });
      throw error;
    }
    void this.options.jobs.start(file.fileId,
      async signal => {
        await this.transition(importId, file.fileId, 1, 'processing',
          { candidates: [], source: this.source(file) });
        const blocks = await this.options.parse(file, signal);
        const extracted = await this.options.extract(blocks, file, signal);
        return {
          candidates: extracted.candidates.map(candidate => ImportCandidateSchema.parse(candidate)),
          warnings: extracted.warnings,
          source: this.source(file),
          processed_block_ids: extracted.processedBlockIds,
          unprocessed_block_ids: extracted.unprocessedBlockIds,
        };
      },
      async data => {
        await this.transition(importId, file.fileId, 2, 'ready_for_review', data);
      },
      async code => {
        const current = await this.getRaw(importId);
        if (!current || ['committed', 'failed', 'cancelled'].includes(current.status)) return;
        await this.transition(importId, file.fileId, current.version,
          code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed',
          { candidates: [], source: this.source(file), warnings: [code] });
      }).catch(() => undefined);
    return { import_id: importId };
  }

  async get(importId: string, actor: string, offset = 0, limit = 20): Promise<Record<string, unknown> | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('Invalid import pagination');
    }
    const job = await this.getRaw(importId);
    if (!job) return null;
    if (job.actor !== actor || !actor.trim()) throw new Error('IMPORT_ACCESS_DENIED');
    const candidates = Array.isArray(job.data.candidates) ? job.data.candidates : [];
    const page = candidates.slice(offset, offset + limit);
    const warnings = Array.isArray(job.data.warnings) ? [...job.data.warnings] : [];
    let matches: { suggestions: MatchSuggestion[]; truncated: boolean } = {
      suggestions: [], truncated: false,
    };
    if (job.status === 'ready_for_review') {
      try {
        matches = await this.matchSuggestions(page);
        if (matches.truncated) warnings.push('身份匹配结果已截断，可能遗漏已有联系人');
      } catch {
        warnings.push('身份匹配查询失败，请人工核对已有联系人');
      }
    }
    return {
      import_id: job.import_id, status: job.status, version: job.version,
      source: job.data.source ?? null, warnings,
      processed_block_ids: job.data.processed_block_ids ?? [],
      unprocessed_block_ids: job.data.unprocessed_block_ids ?? [],
      total_candidates: candidates.length,
      candidates: page, match_suggestions: matches.suggestions,
      match_suggestions_truncated: matches.truncated,
      offset, limit,
    };
  }

  private async matchSuggestions(rawCandidates: unknown[]): Promise<{
    suggestions: MatchSuggestion[]; truncated: boolean;
  }> {
    const candidates = rawCandidates.flatMap(raw => {
      const parsed = ImportCandidateSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    const idsByCandidate = new Map<string, string[]>();
    const allIds = new Set<string>();
    let truncated = false;
    for (const candidate of candidates) {
      const values = identityValues(candidate);
      const found = new Set<string>();
      const count = Math.max(values.phones.length, values.emails.length, values.accounts.length);
      for (let offset = 0; offset < count; offset += 20) {
        const result = await this.options.graph.request<{ entity_ids: string[]; truncated: boolean }>(
          'find_identity_candidates', {
            phones: values.phones.slice(offset, offset + 20),
            emails: values.emails.slice(offset, offset + 20),
            accounts: values.accounts.slice(offset, offset + 20),
          });
        if (result.truncated) truncated = true;
        for (const id of result.entity_ids) {
          if (!allIds.has(id) && allIds.size >= 50) {
            truncated = true;
            continue;
          }
          found.add(id);
          allIds.add(id);
        }
      }
      idsByCandidate.set(candidate.candidate_id, [...found]);
    }
    const existing = new Map<string, ReturnType<typeof ContactEntitySchema.parse>>();
    const evidence = new Map<string, ReturnType<typeof ContactEvidenceSchema.parse>[]>();
    for (const id of allIds) {
      const loaded = await this.options.graph.request<{ entity: unknown; evidence: unknown[] } | null>(
        'get_contact', { entity_id: id });
      if (!loaded) continue;
      const entity = ContactEntitySchema.safeParse(loaded.entity);
      if (!entity.success) continue;
      existing.set(id, entity.data);
      evidence.set(id, loaded.evidence.flatMap(raw => {
        const parsed = ContactEvidenceSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      }));
    }
    const suggestions = candidates.flatMap(candidate => {
      const ids = idsByCandidate.get(candidate.candidate_id) ?? [];
      const related = ids.flatMap(id => existing.has(id) ? [existing.get(id)!] : []);
      return suggestMatches(candidate, related, {
        existingEvidenceById: Object.fromEntries(ids.map(id => [id, evidence.get(id) ?? []])),
      });
    });
    return { suggestions, truncated };
  }

  async commit(input: { import_id: string; preview_version: number; operation_id: string;
    choices: unknown[]; relation_choices?: unknown[] }, actor: string): Promise<Record<string, unknown>> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    if (input.operation_id !== `contact-import:${input.import_id}`) {
      throw new Error('Invalid commit operation_id');
    }
    const result = await this.options.graph.request<Record<string, unknown>>('commit_import', {
      operation_id: input.operation_id, actor, import_id: input.import_id,
      expected_version: input.preview_version, choices: input.choices,
      relation_choices: input.relation_choices ?? [],
    });
    if (this.options.onCommitted && Array.isArray(result.results)) {
      const ids = [...new Set(result.results.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const id = (item as Record<string, unknown>).entity_id;
        return typeof id === 'string' && id ? [id] : [];
      }))];
      if (ids.length) void Promise.resolve().then(() => this.options.onCommitted?.(ids)).catch(() => undefined);
    }
    return result;
  }

  async cancel(input: { import_id: string; operation_id: string }, actor: string): Promise<Record<string, unknown>> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    const job = await this.getRaw(input.import_id);
    if (!job) throw new Error('IMPORT_NOT_FOUND');
    if (job.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
    if (job.status === 'committed' || job.status === 'failed') throw new Error('IMPORT_NOT_CANCELLABLE');
    const result = await this.options.graph.request<Record<string, unknown>>('put_import_job', {
      operation_id: input.operation_id, actor, file_id: job.file_id,
      import_id: input.import_id, expected_version: job.status === 'cancelled' ? job.version - 1 : job.version,
      status: 'cancelled', data: job.data,
    });
    await this.options.jobs.cancel(job.file_id);
    return result;
  }

  private source(file: UploadedFile): Record<string, unknown> {
    return { file_name: file.fileName, file_sha256: file.sha256, uploaded_at: file.uploadedAt };
  }

  private getRaw(importId: string): Promise<ImportJob | null> {
    return this.options.graph.request('get_import_job', { import_id: importId });
  }

  private transition(importId: string, fileId: string, version: number,
    status: ImportJob['status'], data: Record<string, unknown>): Promise<JobWriteResult> {
    return this.options.graph.request('put_import_job', {
      operation_id: `import:${importId}:${status}:${version + 1}`,
      actor: 'system', file_id: fileId, import_id: importId,
      expected_version: version, status, data,
    });
  }
}
