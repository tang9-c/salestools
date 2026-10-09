import { ContactEntitySchema, ContactEvidenceSchema, ContactRelationSchema, ImportCandidateSchema, ReviewItemSchema,
  type ImportCandidate, type ParsedBlock } from '../contracts/index.js';
import type { GraphClient } from './graph-client.js';
import type { ImportJobs } from './import-jobs.js';
import type { UploadedFile, UploadStore } from './upload-store.js';
import { normalizePhoneForSuggestion, suggestMatches, type MatchSuggestion } from './identity-match.js';
import { importFailure, type ImportFailure, type ImportStage } from './import-diagnostics.js';
import { ContactRateLimit } from './contact-rate-limit.js';

export interface ImportEvent {
  import_id: string; file_id: string; stage: ImportStage;
  outcome: 'started' | 'completed' | 'failed'; duration_ms?: number;
  count?: number; failure?: ImportFailure;
}

type CandidateRelation = ImportCandidate['relation_suggestions'][number];

function validSelectedProperties(relation: CandidateRelation): boolean {
  const now = new Date().toISOString();
  return ContactRelationSchema.safeParse({
    relation_id: 'preview', source_id: relation.source_candidate_id,
    target_id: relation.target_candidate_id, relation_type: relation.relation_type,
    properties: relation.properties,
    metadata: { version: 1, created_at: now, updated_at: now },
  }).success;
}

function locatedRelationProof(relation: CandidateRelation) {
  return relation.evidence.filter(proof => proof.field_path === '$relation'
    && proof.source_type === 'file' && proof.locator_status === 'located'
    && proof.value && typeof proof.value === 'object'
    && !Array.isArray(proof.value)
    && (proof.value as Record<string, unknown>).relation_type === relation.relation_type
    && (proof.value as Record<string, unknown>).source_id === relation.source_candidate_id
    && (proof.value as Record<string, unknown>).target_id === relation.target_candidate_id
    && !!proof.file_sha256 && !!proof.quote?.trim());
}

function hasLocatedName(candidate: ImportCandidate): boolean {
  if (candidate.label !== 'Organization') return false;
  return candidate.evidence.some(proof => proof.field_path === 'properties.name'
    && proof.value === candidate.properties.name && proof.source_type === 'file'
    && proof.locator_status === 'located' && !!proof.file_sha256
    && !!proof.quote?.trim());
}

function projectAnchor(candidate: ImportCandidate): string | null {
  if (candidate.label !== 'Project') return null;
  const field = candidate.properties.name ? 'name' : 'description';
  const value = candidate.properties[field];
  if (!value) return null;
  return candidate.evidence.some(proof => proof.field_path === `properties.${field}`
    && proof.value === value && proof.source_type === 'file'
    && proof.locator_status === 'located' && !!proof.file_sha256
    && !!proof.quote?.trim()) ? value : null;
}

function hasLocatedRoleFields(relation: CandidateRelation): boolean {
  if (relation.relation_type === 'alumniOf') {
    return Object.entries(relation.properties).every(([field, value]) => relation.evidence.some(proof =>
      proof.field_path === `properties.${field}` && proof.value === value && proof.source_type === 'file'
      && proof.locator_status === 'located' && !!proof.file_sha256
      && typeof value === 'string' && !!proof.quote?.trim()));
  }
  const role = relation.properties.role;
  if (!role || typeof role !== 'object' || Array.isArray(role)) return relation.relation_type !== 'worksFor';
  return Object.entries(role).every(([field, value]) => field === '@type'
    || relation.evidence.some(proof => proof.field_path === `properties.role.${field}`
      && proof.value === value && proof.source_type === 'file'
      && proof.locator_status === 'located' && !!proof.file_sha256
      && typeof value === 'string' && !!proof.quote?.trim()));
}

function isAutoSelectableInstitutionRelation(relation: CandidateRelation, owner: ImportCandidate,
  candidates: ImportCandidate[], createdIds: Set<string>): boolean {
  if (owner.label !== 'Person' || relation.source_candidate_id !== owner.candidate_id
    || !['worksFor', 'alumniOf'].includes(relation.relation_type)
    || !createdIds.has(relation.target_candidate_id) || !validSelectedProperties(relation)
    || !hasLocatedRoleFields(relation)) return false;
  const target = candidates.find(candidate => candidate.candidate_id === relation.target_candidate_id);
  if (!target || target.label !== 'Organization' || !hasLocatedName(target)) return false;
  return !relation.uncertain && !relation.review_reason && locatedRelationProof(relation).length > 0;
}

function isAutoSelectableProjectRelation(relation: CandidateRelation, owner: ImportCandidate,
  candidates: ImportCandidate[], createdIds: Set<string>, ownerProjectIds: Set<string>): boolean {
  if (relation.uncertain || relation.review_reason || !validSelectedProperties(relation)
    || !hasLocatedRoleFields(relation)
    || !createdIds.has(relation.source_candidate_id)
    || !createdIds.has(relation.target_candidate_id)) return false;
  const source = candidates.find(candidate => candidate.candidate_id === relation.source_candidate_id);
  const target = candidates.find(candidate => candidate.candidate_id === relation.target_candidate_id);
  if (relation.relation_type === 'memberOf') {
    const anchor = target && projectAnchor(target);
    return source?.candidate_id === owner.candidate_id && target?.label === 'Project'
      && !!anchor && locatedRelationProof(relation).length > 0;
  }
  if (relation.relation_type === 'clientOrganization') {
    const anchor = source && projectAnchor(source);
    if (!anchor || source?.label !== 'Project' || !ownerProjectIds.has(source.candidate_id)
      || target?.label !== 'Organization' || !target.properties.name || !hasLocatedName(target)) return false;
    return locatedRelationProof(relation).length > 0;
  }
  return false;
}

// A project below the node threshold still belongs to its owner's review queue.
function preserveSkippedProjects(candidates: ImportCandidate[], warnings: string[]): void {
  for (const owner of candidates.filter(candidate => candidate.label === 'Person')) {
    const projectIds = new Set([...owner.relation_suggestions,
      ...owner.review_items.filter((item): item is Extract<ImportCandidate['review_items'][number], { kind: 'relation' }> => item.kind === 'relation')]
      .filter(item => item.source_candidate_id === owner.candidate_id && item.relation_type === 'memberOf')
      .map(item => item.target_candidate_id));
    for (const project of candidates.filter(candidate => candidate.label === 'Project'
      && !candidate.can_commit && projectIds.has(candidate.candidate_id))) {
      const clients = [...project.relation_suggestions,
        ...project.review_items.filter((item): item is Extract<ImportCandidate['review_items'][number], { kind: 'relation' }> => item.kind === 'relation')]
        .filter(item => item.relation_type === 'clientOrganization')
        .map(item => candidates.find(candidate => candidate.candidate_id === item.target_candidate_id)?.properties.name)
        .filter(Boolean);
      const value = { project: project.properties, review_items: project.review_items, clients };
      let item = ReviewItemSchema.safeParse({ kind: 'field', field_path: '$project', value, reason: 'invalid_shape' });
      if (!item.success) {
        let excerpt = '';
        for (const character of JSON.stringify(value)) {
          if (Buffer.byteLength(excerpt + character, 'utf8') > 1200) break;
          excerpt += character;
        }
        item = ReviewItemSchema.safeParse({ kind: 'field', field_path: '$project', value: `${excerpt}…`, reason: 'invalid_shape' });
        warnings.push('项目待核实线索超过2KB，已截断');
      }
      if (item.success && owner.review_items.length < 100) owner.review_items.push(item.data);
      else warnings.push('项目待核实线索未能保存：主体待核实队列已满或内容超限');
    }
  }
}

function autoCreateSelection(candidates: ImportCandidate[]) {
  const present = (value: unknown): boolean => value !== undefined && value !== null
    && (typeof value === 'string' ? value.trim().length > 0
      : Array.isArray(value) ? value.some(present) : typeof value === 'object'
        ? Object.values(value).some(present) : true);
  const hasInstitutionEvidence = (candidate: ImportCandidate) => candidate.relation_suggestions.some(relation =>
    relation.source_candidate_id === candidate.candidate_id && ['worksFor', 'alumniOf'].includes(relation.relation_type)
    && !relation.uncertain && !relation.review_reason && locatedRelationProof(relation).length > 0);
  const people = candidates.filter(candidate => candidate.label === 'Person'
    && (Object.values(candidate.properties).some(present)
      || Object.values(candidate.extensions).some(present)
      || candidate.evidence.length > 0
      || hasInstitutionEvidence(candidate)
      || candidate.review_items.some(item => item.kind === 'field' && present(item.value))));
  const owners = people.filter(person => !person.warnings.includes('非主体人物线索'));
  if (owners.length > 1) throw new Error('AUTO_CREATE_AMBIGUOUS_PERSON');
  if (owners.length !== 1 || !owners[0].can_commit
    || !(owners[0].evidence.some(proof => proof.locator_status === 'located') || hasInstitutionEvidence(owners[0]))) {
    throw new Error('AUTO_CREATE_NO_PERSON');
  }
  const ownerProjectIds = new Set([...owners[0].relation_suggestions,
    ...owners[0].review_items.filter((item): item is Extract<ImportCandidate['review_items'][number], { kind: 'relation' }> => item.kind === 'relation')]
    .filter(relation => relation.relation_type === 'memberOf'
      && relation.source_candidate_id === owners[0].candidate_id)
    .map(relation => relation.target_candidate_id));
  const autoChoices = candidates.map(candidate => ({
    candidate_id: candidate.candidate_id,
    action: candidate.can_commit && (candidate.candidate_id === owners[0].candidate_id
      || hasLocatedName(candidate)
      || (candidate.label === 'Project' && ownerProjectIds.has(candidate.candidate_id)
        && !!projectAnchor(candidate)))
      ? 'create' : 'skip',
  }));
  const createdIds = new Set(autoChoices.filter(choice => choice.action === 'create')
    .map(choice => choice.candidate_id));
  const suggestions = candidates.flatMap(candidate => candidate.relation_suggestions);
  const relationKey = (relation: CandidateRelation) => JSON.stringify([
    relation.source_candidate_id, relation.target_candidate_id, relation.relation_type,
    relation.properties]);
  const counts = new Map<string, number>();
  for (const relation of suggestions) counts.set(relationKey(relation), (counts.get(relationKey(relation)) ?? 0) + 1);
  const relationChoices = suggestions
    .filter(relation => counts.get(relationKey(relation)) === 1)
    .filter(relation => isAutoSelectableInstitutionRelation(relation, owners[0], candidates, createdIds)
      || isAutoSelectableProjectRelation(relation, owners[0], candidates, createdIds, ownerProjectIds))
    .map(({ source_candidate_id, target_candidate_id, relation_type, properties }) =>
      ({ source_candidate_id, target_candidate_id, relation_type, properties }));
  return { choices: autoChoices, relationChoices };
}

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
  private readonly rateLimit = new ContactRateLimit();
  constructor(private readonly options: {
    graph: GraphClient;
    uploads: UploadStore;
    jobs: ImportJobs;
    parse: (file: UploadedFile, signal: AbortSignal) => Promise<ParsedBlock[]>;
    extract: (blocks: ParsedBlock[], file: UploadedFile, signal: AbortSignal) => Promise<ExtractedDocument>;
    onCommitted?: (entityIds: string[]) => Promise<void> | void;
    onEvent?: (event: ImportEvent) => void;
  }) {}

  private record(event: ImportEvent): void {
    try { this.options.onEvent?.(event); }
    catch { /* Logging failure cannot prevent durable task completion. */ }
  }

  async start(input: { file_id: string; operation_id: string }, actor: string): Promise<{ import_id: string }> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    const file = this.options.uploads.get(input.file_id);
    if (file && file.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
    const prior = await this.options.graph.request<JobWriteResult | null>('get_import_start', {
      operation_id: input.operation_id, actor, file_id: input.file_id,
    });
    if (prior) return { import_id: prior.import_id };
    if (!file) throw new Error('UPLOADED_FILE_MISSING');
    this.rateLimit.consume(actor);
    const result = await this.options.graph.request<JobWriteResult>('put_import_job', {
      operation_id: input.operation_id, actor, file_id: input.file_id,
      status: 'queued', data: { candidates: [] },
    });
    if (result.replayed) return { import_id: result.import_id };
    const importId = result.import_id;
    let stage: ImportStage = 'persist';
    let startedAt = Date.now();
    const begin = (next: ImportStage) => {
      stage = next; startedAt = Date.now();
      this.record({ import_id: importId, file_id: file.fileId, stage, outcome: 'started' });
    };
    const completed = (count?: number) => this.record({ import_id: importId,
      file_id: file.fileId, stage, outcome: 'completed', duration_ms: Date.now() - startedAt, count });
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
        begin('parse');
        const blocks = await this.options.parse(file, signal);
        completed(blocks.length);
        begin('extract');
        const extracted = await this.options.extract(blocks, file, signal);
        completed(extracted.candidates.length);
        begin('validate');
        const candidates = extracted.candidates.map(candidate => ImportCandidateSchema.parse(candidate));
        preserveSkippedProjects(candidates, extracted.warnings);
        completed(candidates.length);
        return {
          candidates,
          warnings: extracted.warnings,
          source: this.source(file),
          processed_block_ids: extracted.processedBlockIds,
          unprocessed_block_ids: extracted.unprocessedBlockIds,
        };
      },
      async data => {
        begin('persist');
        await this.transition(importId, file.fileId, 2, 'ready_for_review', data);
        completed();
      },
      async (code, error) => {
        const failure = importFailure(stage, error, code);
        this.record({ import_id: importId, file_id: file.fileId, stage,
          outcome: 'failed', duration_ms: Date.now() - startedAt, failure });
        const current = await this.getRaw(importId);
        if (!current || ['committed', 'failed', 'cancelled'].includes(current.status)) return;
        await this.transition(importId, file.fileId, current.version,
          code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed',
          { candidates: [], source: this.source(file), warnings: [code], failure });
      }).catch(error => {
        // Covers queue admission/persistence failures too; do not log raw errors.
        const persistenceFailed = Object.hasOwn(error, 'persistenceError');
        const failedStage = persistenceFailed ? 'persist' : stage;
        this.record({ import_id: importId, file_id: file.fileId, stage: failedStage,
          outcome: 'failed', failure: importFailure(failedStage,
            persistenceFailed ? error.persistenceError : error.cause ?? error,
            persistenceFailed ? 'IMPORT_STATE_WRITE_FAILED' : undefined) });
      });
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
    const validBlockIds = (value: unknown): boolean => Array.isArray(value)
      && value.every(id => typeof id === 'string' && !!id.trim());
    return {
      import_id: job.import_id, status: job.status, version: job.version,
      source: job.data.source ?? null, warnings,
      failure: job.data.failure ?? null,
      processed_block_ids: job.data.processed_block_ids ?? [],
      unprocessed_block_ids: job.data.unprocessed_block_ids ?? [],
      coverage_available: validBlockIds(job.data.processed_block_ids) && validBlockIds(job.data.unprocessed_block_ids),
      total_candidates: candidates.length,
      candidates: page, match_suggestions: matches.suggestions,
      match_suggestions_truncated: matches.truncated,
      offset, limit,
    };
  }

  // The upload page consumes one complete preview and one server-owned decision.
  async getUploadPreview(importId: string, actor: string): Promise<(Record<string, unknown> & {
    candidates: unknown[]; confirmation: { allowed: boolean; reasons: string[] };
  }) | null> {
    const first = await this.get(importId, actor, 0, 50);
    if (!first) return null;
    const pages = [first];
    const reasons: string[] = [];
    const total = first.total_candidates;
    const processed = first.processed_block_ids;
    const unprocessed = first.unprocessed_block_ids;
    const validIds = (value: unknown): value is string[] => Array.isArray(value)
      && value.every(id => typeof id === 'string' && !!id.trim());
    const candidateIds = new Set<string>();
    const completePage = (page: Record<string, unknown> | null, offset: number): boolean => {
      if (!page || page.import_id !== importId || page.status !== first.status || page.version !== first.version
        || page.total_candidates !== total || page.offset !== offset || page.limit !== 50
        || !Array.isArray(page.candidates) || page.candidates.length !== Math.min(50, Math.max(0, (total as number) - offset))
        || page.coverage_available !== true || !validIds(processed) || !validIds(unprocessed)
        || !validIds(page.processed_block_ids) || !validIds(page.unprocessed_block_ids)
        || JSON.stringify(page.processed_block_ids) !== JSON.stringify(processed)
        || JSON.stringify(page.unprocessed_block_ids) !== JSON.stringify(unprocessed)) return false;
      return page.candidates.every(candidate => {
        const id = candidate && typeof candidate === 'object' ? candidate.candidate_id : undefined;
        if (typeof id !== 'string' || !id.trim() || candidateIds.has(id)) return false;
        candidateIds.add(id);
        return true;
      });
    };
    let complete = Number.isSafeInteger(total) && (total as number) >= 0
      && Number.isSafeInteger(first.version) && (first.version as number) > 0 && completePage(first, 0);
    if (Number.isSafeInteger(total) && (total as number) > 0) {
      for (let offset = 50; offset < (total as number); offset += 50) {
        const page = await this.get(importId, actor, offset, 50);
        if (!completePage(page, offset)) complete = false;
        if (!page) break;
        pages.push(page);
      }
    }
    if (!complete) reasons.push('预览不完整或版本发生变化，请重新加载完整预览。');
    if (pages.some(page => Array.isArray(page.unprocessed_block_ids) && page.unprocessed_block_ids.length)) {
      reasons.push('原件仍有未处理文本块。');
    }
    const candidates = pages.flatMap(page => Array.isArray(page.candidates) ? page.candidates : []);
    const warnings = [...new Set(pages.flatMap(page => Array.isArray(page.warnings) ? page.warnings : []))];
    const matches = pages.flatMap(page => Array.isArray(page.match_suggestions) ? page.match_suggestions : []);
    if (pages.some(page => page.match_suggestions_truncated !== false
      || !Array.isArray(page.match_suggestions) || !Array.isArray(page.warnings))
      || warnings.some(warning => typeof warning === 'string' && (warning.includes('匹配查询失败') || warning.includes('截断')))) {
      reasons.push('身份匹配未完整完成。');
    }
    if (matches.length) reasons.push('存在可能重复的联系人，请在聊天中比较资料。');
    if (first.status !== 'ready_for_review') reasons.push('任务尚未达到可确认状态。');
    else {
      try { autoCreateSelection(candidates.map(raw => ImportCandidateSchema.parse(raw))); }
      catch (error) {
        reasons.push(error instanceof Error && error.message === 'AUTO_CREATE_AMBIGUOUS_PERSON'
          ? '识别到多个主体人物。' : '缺少可入库且有定位证据的主体人物。');
      }
    }
    return { ...first, import_id: importId, candidates, warnings, match_suggestions: matches,
      match_suggestions_truncated: pages.some(page => page.match_suggestions_truncated === true),
      processed_block_ids: [...new Set(pages.flatMap(page => Array.isArray(page.processed_block_ids) ? page.processed_block_ids : []))],
      unprocessed_block_ids: [...new Set(pages.flatMap(page => Array.isArray(page.unprocessed_block_ids) ? page.unprocessed_block_ids : []))],
      coverage_available: pages.every(page => page.coverage_available === true),
      confirmation: { allowed: reasons.length === 0, reasons } };
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
    choices?: unknown[]; relation_choices?: unknown[]; auto_create?: boolean; require_confirmation?: boolean }, actor: string,
    beforeWrite?: () => void): Promise<Record<string, unknown>> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    if (input.operation_id !== `contact-import:${input.import_id}`) {
      throw new Error('Invalid commit operation_id');
    }
    if (input.require_confirmation) {
      const preview = await this.getUploadPreview(input.import_id, actor);
      beforeWrite?.();
      if (!preview) throw new Error('IMPORT_NOT_FOUND');
      if (preview.version !== input.preview_version) throw new Error('PREVIEW_VERSION_CHANGED');
      if (!preview.confirmation.allowed) throw new Error('MANUAL_REVIEW_REQUIRED');
    }
    let choices = input.choices;
    let relationChoices = input.relation_choices ?? [];
    if (input.auto_create) {
      if (choices !== undefined || input.relation_choices?.length) throw new Error('AUTO_CREATE_CONFLICT');
      const job = await this.getRaw(input.import_id);
      if (!job) throw new Error('IMPORT_NOT_FOUND');
      if (job.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
      if (input.require_confirmation && job.version !== input.preview_version) throw new Error('PREVIEW_VERSION_CHANGED');
      if (!['ready_for_review', 'committed'].includes(job.status)) throw new Error('IMPORT_NOT_READY');
      const candidates = (Array.isArray(job.data.candidates) ? job.data.candidates : [])
        .map(raw => ImportCandidateSchema.parse(raw));
      ({ choices, relationChoices } = autoCreateSelection(candidates));
    } else if (Array.isArray(choices)) {
      const createdIds = new Set(choices.flatMap(choice => {
        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return [];
        const value = choice as Record<string, unknown>;
        return value.action === 'create' && typeof value.candidate_id === 'string'
          ? [value.candidate_id] : [];
      }));
      if (createdIds.size > 1) {
        const job = await this.getRaw(input.import_id);
        if (job && job.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
        const peopleCreated = (Array.isArray(job?.data.candidates) ? job.data.candidates : [])
          .flatMap(raw => {
            const parsed = ImportCandidateSchema.safeParse(raw);
            return parsed.success ? [parsed.data] : [];
          }).filter(candidate => candidate.label === 'Person' && createdIds.has(candidate.candidate_id));
        if (peopleCreated.length > 1) throw new Error('MULTIPLE_PERSON_CREATE_FOR_ONE_FILE');
      }
    }
    if (!choices) throw new Error('Commit choices are required');
    // The page capability may be revoked while the service awaits preview reads.
    beforeWrite?.();
    const result = await this.options.graph.request<Record<string, unknown>>('commit_import', {
      operation_id: input.operation_id, actor, import_id: input.import_id,
      expected_version: input.preview_version, choices,
      relation_choices: relationChoices,
      ...(input.auto_create ? { auto_selected_relations: true } : {}),
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
