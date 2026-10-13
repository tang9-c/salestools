import { ContactEntitySchema, parseStoredContactEvidence, ContactRelationSchema, ImportCandidateSchema, ReviewItemSchema,
  type ContactEvidence, type ImportCandidate, type ParsedBlock } from '../contracts/index.js';
import { readCompleteContact, type GraphClient } from './graph-client.js';
import type { ImportJobs } from './import-jobs.js';
import type { UploadedFile, UploadStore } from './upload-store.js';
import { normalizePhoneForSuggestion, suggestMatches, type MatchSuggestion } from './identity-match.js';
import { importFailure, type ImportFailure, type ImportStage } from './import-diagnostics.js';
import { ContactRateLimit } from './contact-rate-limit.js';
import { createHash } from 'node:crypto';

export interface ImportEvent {
  import_id: string; file_id: string; stage: ImportStage;
  outcome: 'started' | 'completed' | 'failed'; duration_ms?: number;
  count?: number; failure?: ImportFailure;
}

type CandidateRelation = ImportCandidate['relation_suggestions'][number];

function locatedSource(proof: ImportCandidate['evidence'][number]): boolean {
  return proof.locator_status === 'located' && !!proof.quote?.trim()
    && ((proof.source_type === 'file' && !!proof.file_sha256)
      || (proof.source_type === 'text' && !!proof.text_sha256));
}

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
    && locatedSource(proof)
    && proof.value && typeof proof.value === 'object'
    && !Array.isArray(proof.value)
    && (proof.value as Record<string, unknown>).relation_type === relation.relation_type
    && (proof.value as Record<string, unknown>).source_id === relation.source_candidate_id
    && (proof.value as Record<string, unknown>).target_id === relation.target_candidate_id);
}

function hasLocatedName(candidate: ImportCandidate): boolean {
  if (candidate.label !== 'Organization') return false;
  return candidate.evidence.some(proof => proof.field_path === 'properties.name'
    && proof.value === candidate.properties.name && locatedSource(proof));
}

function projectAnchor(candidate: ImportCandidate): string | null {
  if (candidate.label !== 'Project') return null;
  const field = candidate.properties.name ? 'name' : 'description';
  const value = candidate.properties[field];
  if (!value) return null;
  return candidate.evidence.some(proof => proof.field_path === `properties.${field}`
    && proof.value === value && locatedSource(proof)) ? value : null;
}

function hasLocatedRoleFields(relation: CandidateRelation): boolean {
  if (relation.relation_type === 'alumniOf') {
    return Object.entries(relation.properties).every(([field, value]) => relation.evidence.some(proof =>
      proof.field_path === `properties.${field}` && proof.value === value && locatedSource(proof)
      && typeof value === 'string'));
  }
  const role = relation.properties.role;
  if (!role || typeof role !== 'object' || Array.isArray(role)) return relation.relation_type !== 'worksFor';
  return Object.entries(role).every(([field, value]) => field === '@type'
    || relation.evidence.some(proof => proof.field_path === `properties.role.${field}`
      && proof.value === value && locatedSource(proof) && typeof value === 'string'));
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

  async startText(input: { text: string; operation_id: string }, actor: string): Promise<{ import_id: string }> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    if (!input.text.trim() || input.text.length > 20_000 || !input.operation_id.trim()
      || input.operation_id.length > 200) throw new Error('INVALID_CONTACT_TEXT');
    const fileId = `text_${createHash('sha256').update(JSON.stringify([actor, input.operation_id, input.text])).digest('hex')}`;
    const prior = await this.options.graph.request<JobWriteResult | null>('get_import_start', {
      operation_id: input.operation_id, actor, file_id: fileId,
    });
    if (prior) return { import_id: prior.import_id };
    this.options.uploads.registerText(fileId, actor, input.text);
    try { return await this.start({ file_id: fileId, operation_id: input.operation_id }, actor); }
    catch (error) { await this.options.uploads.release(fileId); throw error; }
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
      status: 'queued', data: { candidates: [], ...(file.mime === 'text/plain' ? { source: this.source(file) } : {}) },
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
        let blocks: ParsedBlock[];
        if (file.mime === 'text/plain') blocks = [{ block_id: 'text:1', text: file.originalText! }];
        else {
          begin('parse');
          blocks = await this.options.parse(file, signal);
          completed(blocks.length);
        }
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
    let matches: { suggestions: MatchSuggestion[]; truncated: boolean; incomplete: boolean } = {
      suggestions: [], truncated: false, incomplete: false,
    };
    if (job.status === 'ready_for_review') {
      try {
        matches = await this.matchSuggestions(page, candidates);
        if (matches.truncated) warnings.push('身份匹配结果已截断，可能遗漏已有联系人');
        if (matches.incomplete) warnings.push('身份匹配查询失败，请人工核对已有联系人');
      } catch {
        matches.incomplete = true;
        warnings.push('身份匹配查询失败，请人工核对已有联系人');
      }
    }
    const validBlockIds = (value: unknown): boolean => Array.isArray(value)
      && value.every(id => typeof id === 'string' && !!id.trim());
    return {
      import_id: job.import_id, status: job.status, version: job.version,
      source: this.previewSource(job.data.source), warnings,
      failure: job.data.failure ?? null,
      processed_block_ids: job.data.processed_block_ids ?? [],
      unprocessed_block_ids: job.data.unprocessed_block_ids ?? [],
      coverage_available: validBlockIds(job.data.processed_block_ids) && validBlockIds(job.data.unprocessed_block_ids),
      total_candidates: candidates.length,
      candidates: page, match_suggestions: matches.suggestions,
      match_suggestions_truncated: matches.truncated,
      match_suggestions_incomplete: matches.incomplete,
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
      match_suggestions_incomplete: pages.some(page => page.match_suggestions_incomplete === true),
      processed_block_ids: [...new Set(pages.flatMap(page => Array.isArray(page.processed_block_ids) ? page.processed_block_ids : []))],
      unprocessed_block_ids: [...new Set(pages.flatMap(page => Array.isArray(page.unprocessed_block_ids) ? page.unprocessed_block_ids : []))],
      coverage_available: pages.every(page => page.coverage_available === true),
      confirmation: { allowed: reasons.length === 0, reasons } };
  }

  private async matchSuggestions(rawCandidates: unknown[], allCandidates: unknown[]): Promise<{
    suggestions: MatchSuggestion[]; truncated: boolean; incomplete: boolean;
  }> {
    const candidates = rawCandidates.flatMap(raw => {
      const parsed = ImportCandidateSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    const idsByCandidate = new Map<string, string[]>();
    const allIds = new Set<string>();
    let truncated = false;
    let incomplete = false;
    const attempt = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await action(); } catch { incomplete = true; return fallback; }
    };
    const names = new Map<string, string>();
    const identityReasons = new Map<string, Map<string, Set<MatchSuggestion['reasons'][number]['kind']>>>();
    const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
    const organizationIds = new Map<string, { id: string; name: string }[]>();
    const drafts = allCandidates.flatMap(raw => {
      const parsed = ImportCandidateSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    const employers = new Map<string, { id: string; name: string }[]>();
    for (const candidate of candidates) {
      if (candidate.label !== 'Person') continue;
      const values = identityValues(candidate);
      const found = new Set<string>();
      const search = async (name: string) => {
        const result = await attempt(() => this.options.graph.request<{ items: { entity_id: string; label?: string; name?: string }[]; total: number }>(
          'search_keyword', { name, offset: 0, limit: 50 }), { items: [], total: 0 });
        if (result.total > result.items.length) truncated = true;
        return result.items;
      };
      if (candidate.properties.name?.trim()) {
        for (const item of await search(candidate.properties.name)) {
          if (item.label === 'Person') {
            found.add(item.entity_id);
            if (typeof item.name === 'string') names.set(item.entity_id, item.name);
          }
        }
      }
      const companies: { id: string; name: string }[] = [];
      for (const relation of candidate.relation_suggestions) {
        if (relation.relation_type !== 'worksFor' || relation.uncertain
          || relation.source_candidate_id !== candidate.candidate_id) continue;
        const company = drafts.find(draft => draft.candidate_id === relation.target_candidate_id && draft.label === 'Organization');
        const name = company?.properties.name;
        if (!name?.trim()) continue;
        const key = normalize(name);
        if (!organizationIds.has(key)) {
          const matches = (await search(name)).filter(item => item.label === 'Organization'
            && typeof item.name === 'string' && normalize(item.name) === key);
          // An ambiguous name cannot identify an employer node.
          organizationIds.set(key, matches.length === 1 ? [{ id: matches[0].entity_id, name }] : []);
        }
        companies.push(...organizationIds.get(key)!);
      }
      employers.set(candidate.candidate_id, companies);
      const reasonsByTarget = new Map<string, Set<MatchSuggestion['reasons'][number]['kind']>>();
      identityReasons.set(candidate.candidate_id, reasonsByTarget);
      // Separate kinds so an ID match remains attributable even if profile reads fail.
      for (const [key, reason] of [['phones', 'self_phone'], ['emails', 'email'], ['accounts', 'instant_messaging']] as const) {
        for (let offset = 0; offset < values[key].length; offset += 20) {
          const result = await attempt(() => this.options.graph.request<{ entity_ids: string[]; truncated: boolean }>(
            'find_identity_candidates', {
              phones: [], emails: [], accounts: [],
              [key]: values[key].slice(offset, offset + 20),
            }), { entity_ids: [], truncated: false });
          if (result.truncated) truncated = true;
          for (const id of result.entity_ids) {
            found.add(id);
            const reasons = reasonsByTarget.get(id) ?? new Set();
            reasons.add(reason);
            reasonsByTarget.set(id, reasons);
          }
        }
      }
      const kept: string[] = [];
      for (const id of found) {
        if (!allIds.has(id) && allIds.size >= 50) { truncated = true; continue; }
        allIds.add(id); kept.push(id);
      }
      idsByCandidate.set(candidate.candidate_id, kept);
    }
    const existing = new Map<string, ReturnType<typeof ContactEntitySchema.parse>>();
    const evidence = new Map<string, ContactEvidence[]>();
    const organizations: Record<string, string[]> = {};
    for (const id of allIds) {
      const loaded = await attempt(() => readCompleteContact(this.options.graph, id, {
        onIncomplete: () => { incomplete = true; },
      }), null);
      if (!loaded) { incomplete = true; continue; }
      const entity = ContactEntitySchema.safeParse(loaded.entity);
      if (!entity.success || entity.data.entity_id !== id) { incomplete = true; continue; }
      existing.set(id, entity.data);
      evidence.set(id, (Array.isArray(loaded.evidence) ? loaded.evidence : []).flatMap(raw => {
        const parsed = parseStoredContactEvidence(raw);
        return parsed.success ? [parsed.data] : [];
      }));
      organizations[id] = (Array.isArray(loaded.relations) ? loaded.relations : []).flatMap(raw => {
        const parsed = ContactRelationSchema.safeParse(raw);
        return parsed.success && parsed.data.relation_type === 'worksFor' && parsed.data.source_id === id
          && !parsed.data.metadata.archived_at ? [parsed.data.target_id] : [];
      });
    }
    const suggestions = candidates.flatMap(candidate => {
      const ids = idsByCandidate.get(candidate.candidate_id) ?? [];
      const related = ids.flatMap(id => existing.has(id) ? [existing.get(id)!] : []);
      const verified = suggestMatches(candidate, related, {
        candidateOrganizations: employers.get(candidate.candidate_id),
        existingOrganizationsById: organizations,
        existingEvidenceById: Object.fromEntries(ids.map(id => [id, evidence.get(id) ?? []])),
      });
      const fallback = ids.flatMap(id => {
        const name = names.get(id);
        if (existing.has(id)) return [];
        const reasons: MatchSuggestion['reasons'] = [...(identityReasons.get(candidate.candidate_id)?.get(id) ?? [])]
          .map(kind => ({ kind, value: '' }));
        if (name && candidate.properties.name && normalize(name) === normalize(candidate.properties.name)) {
          reasons.push({ kind: 'same_name', value: name });
        }
        if (!reasons.length) return [];
        return [{ entityId: id, candidateId: candidate.candidate_id, candidateName: candidate.properties.name ?? '',
          existingName: name ?? '', reasons,
          existingUpdatedAt: '', candidateSources: [], existingSources: [] }];
      });
      return [...verified, ...fallback];
    });
    return { suggestions, truncated, incomplete: incomplete || truncated };
  }

  async commit(input: { import_id: string; preview_version: number; operation_id: string;
    choices?: unknown[]; relation_choices?: unknown[]; auto_create?: boolean; require_confirmation?: boolean }, actor: string,
    beforeWrite?: () => void): Promise<Record<string, unknown>> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    if (input.operation_id !== `contact-import:${input.import_id}`) {
      throw new Error('Invalid commit operation_id');
    }
    const initialJob = await this.getRaw(input.import_id);
    if (!initialJob) throw new Error('IMPORT_NOT_FOUND');
    if (initialJob.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
    if (input.require_confirmation && initialJob.status !== 'committed') {
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
      if (input.require_confirmation && job.status !== 'committed' && job.version !== input.preview_version) throw new Error('PREVIEW_VERSION_CHANGED');
      if (!['ready_for_review', 'committed'].includes(job.status)) throw new Error('IMPORT_NOT_READY');
      const candidates = (Array.isArray(job.data.candidates) ? job.data.candidates : [])
        .map(raw => ImportCandidateSchema.parse(raw));
      ({ choices, relationChoices } = autoCreateSelection(candidates));
      if (job.status === 'ready_for_review' && !input.require_confirmation) {
        const preview = await this.getUploadPreview(input.import_id, actor);
        beforeWrite?.();
        if (!preview?.confirmation.allowed) {
          throw new Error('MANUAL_REVIEW_REQUIRED');
        }
      }
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
    const job = await this.getRaw(input.import_id);
    if (!job) throw new Error('IMPORT_NOT_FOUND');
    if (job.actor !== actor) throw new Error('IMPORT_ACCESS_DENIED');
    const allCandidates = Array.isArray(job.data.candidates) ? job.data.candidates : [];
    const selected = new Map(choices.flatMap(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const choice = raw as Record<string, unknown>;
      return (choice.action === 'create' || choice.action === 'merge') && typeof choice.candidate_id === 'string'
        ? [[choice.candidate_id, choice] as const] : [];
    }));
    const matchCandidates = allCandidates.filter(raw => raw && typeof raw === 'object'
      && selected.has((raw as Record<string, unknown>).candidate_id as string));
    const duplicateMatches: { candidate_id: string; target_id: string; reasons: string[] }[] = [];
    const duplicateTargetIds = new Set<string>();
    let duplicateMatchIncomplete = false;
    if (job.status === 'ready_for_review') {
      for (let offset = 0; offset < matchCandidates.length; offset += 50) {
        const matches = await this.matchSuggestions(matchCandidates.slice(offset, offset + 50), allCandidates);
        duplicateMatchIncomplete ||= matches.incomplete;
        for (const match of matches.suggestions) {
          if (selected.get(match.candidateId)?.target_id === match.entityId) continue;
          if (!duplicateTargetIds.has(match.entityId) && duplicateTargetIds.size >= 50) {
            duplicateMatchIncomplete = true;
            continue;
          }
          duplicateTargetIds.add(match.entityId);
          duplicateMatches.push({ candidate_id: match.candidateId, target_id: match.entityId,
            reasons: [...new Set(match.reasons.map(reason => reason.kind))].sort() });
        }
      }
    }
    // The page capability may be revoked while the service awaits preview reads.
    beforeWrite?.();
    const result = await this.options.graph.request<Record<string, unknown>>('commit_import', {
      operation_id: input.operation_id, actor, import_id: input.import_id,
      expected_version: input.preview_version, choices,
      relation_choices: relationChoices,
      duplicate_matches: duplicateMatches,
      duplicate_match_incomplete: duplicateMatchIncomplete,
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
    if (file.mime === 'text/plain') return { source_type: 'text', text_sha256: file.sha256,
      original_text: file.originalText, collected_at: file.uploadedAt };
    return { file_name: file.fileName, file_sha256: file.sha256, uploaded_at: file.uploadedAt };
  }

  private previewSource(source: unknown): unknown {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source ?? null;
    const { original_text: _originalText, ...identity } = source as Record<string, unknown>;
    return identity;
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
