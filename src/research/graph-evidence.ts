import { z } from 'zod';
import { ContactEntitySchema, ContactRelationSchema, parseStoredContactEvidence, type ContactEntity, type ContactEvidence, type ContactRelation } from '../contracts/contact-graph.js';
import { supportedRelationEvidence } from '../contacts/relation-evidence.js';
import { filterConflictedEvidence } from '../companies/company-evidence.js';
import { maxGraphFrameBytes } from '../contacts/graph-client.js';
import { ResearchSourceStatusSchema, type ProductKey, type ResearchEvidence } from './contracts.js';
import { containsPrivateContact, hasUseLimitation, ingestEvidence, packEvidenceGroups, sha256 } from './evidence.js';
import { findSoftwareAliases } from './software-aliases.js';
export type GraphReadOp = 'company_organizations' | 'company_relations' | 'get_contact';
export interface GraphReadContext {
  signal: AbortSignal;
  /** Must count every actual IPC attempt before dispatch, including errors. */
  request<T>(op: GraphReadOp, payload: object): Promise<T>;
}
export interface ConfirmedOrganizationResult { ids: string[]; complete: boolean; available: boolean; warnings: string[] }
export interface GraphCollectionResult {
  evidence: ResearchEvidence[]; warnings: string[];
  source_status: z.infer<typeof ResearchSourceStatusSchema>[];
  coverage_hints: { product: ProductKey; complete: boolean; reasons: string[] }[];
  conflict_evidence_ids: string[];
}
interface ContactRecord { entity: ContactEntity; version: string | number; evidence: ContactEvidence[]; conflicts: ContactEvidence[]; relations: ContactRelation[] }
interface RelationRef { relation_id: string; source_id: string; target_id: string; relation_type: string }
const relationRefSchema = z.object({ relation_id: z.string(), source_id: z.string(), target_id: z.string(), relation_type: z.string() });
const paginationSchema = z.object({
  evidence: z.object({ total: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative().nullable() }),
  relations: z.object({ total: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative().nullable() }),
});
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const parseProofs = (value: unknown): ContactEvidence[] => array(value).flatMap(raw => { const p = parseStoredContactEvidence(raw); return p.success ? [p.data] : []; });
const unsafeAssertion = /不是|并非|未曾|未在|未任职|尚未|计划|拟任|拟加入|准备|意向|\b(?:not|planned?|proposed?|will|would)\b/iu;
/** A bounded reader for occupational graph evidence. It never owns or closes the shared graph. */
export class GraphEvidenceCollector {
  constructor(private readonly deps: {
    organizations: { confirmedOrganizationIds(code: string, readContext: GraphReadContext): Promise<ConfirmedOrganizationResult> };
    now?: () => Date;
  }) {}
  async collect(identity: { credit_code: string; legal_name: string }, scope: ProductKey[], readContext: GraphReadContext): Promise<GraphCollectionResult> {
    const warnings = new Set<string>(), candidates: ResearchEvidence[] = [], conflictIds = new Set<string>();
    const collectedAt = (this.deps.now?.() ?? new Date()).toISOString();
    let used = 0, people = 0, projects = 0, available = false;
    const signal = readContext.signal;
    const warn = (code: string) => { warnings.add(code); };
    const context: GraphReadContext = { signal, request: async <T>(op: GraphReadOp, payload: object): Promise<T> => {
      signal.throwIfAborted();
      if (used >= 40) { warn('GRAPH_IPC_BUDGET_EXHAUSTED'); throw Error('GRAPH_IPC_BUDGET_EXHAUSTED'); }
      used++;
      const result = await readContext.request<T>(op, payload);
      signal.throwIfAborted();
      // GraphClient enforces the full wire frame. This also protects custom transports/test adapters.
      if (Buffer.byteLength(JSON.stringify(result) ?? 'null', 'utf8') > maxGraphFrameBytes) { warn('GRAPH_FRAME_TOO_LARGE'); throw Error('GRAPH_FRAME_TOO_LARGE'); }
      return result;
    } };
    const cache = new Map<string, ContactRecord | null>();
    const get = async (id: string): Promise<ContactRecord | null> => {
      if (cache.has(id)) return cache.get(id)!;
      cache.set(id, null);
      try {
        const first = asObject(await context.request('get_contact', { entity_id: id, evidence_limit: 50, relation_limit: 50, claim_limit: 0 }));
        const parsed = ContactEntitySchema.safeParse(first.entity);
        if (!parsed.success || parsed.data.entity_id !== id || parsed.data.metadata.archived_at || parsed.data.metadata.merged_into) return null;
        const entity = parsed.data;
        if ((entity.label === 'Person' && ++people > 20) || (entity.label === 'Project' && ++projects > 10)) { warn('GRAPH_ENTITY_BUDGET_EXHAUSTED'); return null; }
        let page = paginationSchema.parse(first.pagination);
        const evidence = [...array(first.evidence)], relations = [...array(first.relations)], conflicts = [...array(first.conflicts)];
        if (typeof first.version !== 'number' && typeof first.version !== 'string') throw Error('GRAPH_INVALID_PAGINATION');
        const initial = page;
        for (let n = 1; page.evidence.next_offset !== null || page.relations.next_offset !== null; n++) {
          if (n >= 40) throw Error('GRAPH_INVALID_PAGINATION');
          const evidenceOffset = page.evidence.next_offset ?? page.evidence.total;
          const relationOffset = page.relations.next_offset ?? page.relations.total;
          const next = asObject(await context.request('get_contact', { entity_id: id, evidence_offset: evidenceOffset, relation_offset: relationOffset, evidence_limit: 50, relation_limit: 50, claim_limit: 0 }));
          if (next.version !== first.version || next.index_content_version !== first.index_content_version) throw Error('GRAPH_ENTITY_CHANGED');
          const following = paginationSchema.parse(next.pagination);
          if (following.evidence.total !== initial.evidence.total || following.relations.total !== initial.relations.total
            || (page.evidence.next_offset !== null && following.evidence.next_offset !== null && following.evidence.next_offset <= evidenceOffset)
            || (page.relations.next_offset !== null && following.relations.next_offset !== null && following.relations.next_offset <= relationOffset)) throw Error('GRAPH_INVALID_PAGINATION');
          if (page.evidence.next_offset !== null) evidence.push(...array(next.evidence));
          if (page.relations.next_offset !== null) relations.push(...array(next.relations));
          conflicts.push(...array(next.conflicts)); page = following;
        }
        if (evidence.length !== initial.evidence.total || relations.length !== initial.relations.total) throw Error('GRAPH_INVALID_PAGINATION');
        const record: ContactRecord = { entity, version: first.version, evidence: parseProofs(evidence), conflicts: parseProofs(conflicts),
          relations: relations.flatMap(raw => { const p = ContactRelationSchema.safeParse(raw); return p.success && !p.data.metadata.archived_at ? [p.data] : []; }) };
        cache.set(id, record); return record;
      } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof Error ? error.message : '';
        warn(['GRAPH_ENTITY_CHANGED', 'GRAPH_INVALID_PAGINATION', 'GRAPH_IPC_BUDGET_EXHAUSTED', 'GRAPH_FRAME_TOO_LARGE'].includes(code) ? code : 'GRAPH_CONTACT_UNAVAILABLE');
        return null;
      }
    };
    const productsFor = (quote: string): ProductKey[] => findSoftwareAliases(quote).map(item => item.product).filter(product => scope.includes(product));
    const toEvidence = (record: ContactRecord, proof: ContactEvidence, productKeys: ProductKey[], kind: ResearchEvidence['signal_kind'], required: string[] = [], exactQuote?: string): ResearchEvidence | null => {
      if (!proof.quote || !['located', 'not_applicable'].includes(proof.locator_status) || !productKeys.length) return null;
      if (!proof.file_sha256 && !proof.text_sha256 && !proof.source_url) return null;
      const quote = exactQuote ?? (!containsPrivateContact(proof.quote) ? proof.quote : undefined);
      if (!quote || quote.trim() !== quote || containsPrivateContact(quote)) return null;
      const relation = record.relations.find(item => item.relation_id === proof.subject_id);
      const date = relation?.relation_type === 'worksFor' ? relation.properties.role : undefined;
      const fullDate = (value: string | undefined) => value && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : null;
      return ingestEvidence({ source_type: 'graph', content: proof.quote, collected_at: proof.collected_at || collectedAt, published_at: null,
        valid_from: fullDate(date?.startDate), valid_to: fullDate(date?.endDate), company_scope: 'confirmed',
        locator: { entity_id: record.entity.entity_id, entity_version: `${record.version}:${record.entity.metadata.version}`,
          evidence_id: proof.evidence_id, ...(proof.subject_kind === 'relation' ? { relation_id: proof.subject_id } : {}),
          ...(proof.file_sha256 ? { file_sha256: proof.file_sha256 } : { text_hash: proof.text_sha256 ?? sha256(proof.source_url!) }), ...(proof.page ? { page: proof.page } : {}) } },
      { title: kind === 'other' ? '职业归属来源' : '职业软件线索', quote, product_keys: productKeys, signal_kind: kind, required_evidence_ids: required });
    };
    const add = (item: ResearchEvidence | null) => { if (item) candidates.push(item); return item; };
    const retainFieldConflicts = (record: ContactRecord) => {
      const relevant = record.conflicts.filter(proof => proof.subject_kind === 'entity' && proof.subject_id === record.entity.entity_id
        && ['properties.skills', 'properties.knowsAbout', 'properties.description', 'properties.name'].includes(proof.field_path)
        && productsFor(proof.quote ?? '').length);
      for (const conflict of relevant) {
        warn('GRAPH_CONFLICT');
        for (const proof of [conflict, ...record.evidence.filter(item => item.subject_id === conflict.subject_id && item.field_path === conflict.field_path)]) {
          const item = toEvidence(record, proof, productsFor(proof.quote ?? '').length ? productsFor(proof.quote!) : scope, 'other');
          if (item) { item.company_scope = 'unverified'; add(item); conflictIds.add(item.evidence_id); }
        }
      }
    };
    const relationProof = (record: ContactRecord, relation: ContactRelation, target: ContactRecord): ContactEvidence | null => {
      const filtered = filterConflictedEvidence(record.evidence, record.conflicts);
      const conflicts = record.conflicts.filter(item => item.subject_id === relation.relation_id);
      if (conflicts.length) {
        warn('GRAPH_CONFLICT');
        for (const proof of [...filtered.blocked, ...conflicts]) {
          const item = add(toEvidence(record, proof, productsFor(proof.quote ?? '').length ? productsFor(proof.quote!) : scope, 'other'));
          if (item) conflictIds.add(item.evidence_id);
        }
        return null;
      }
      const safe = filtered.usable.filter(item => item.subject_id === relation.relation_id && !unsafeAssertion.test(item.quote ?? '')
        && (!record.entity.properties.name || item.quote?.includes(record.entity.properties.name))
        && (relation.relation_type !== 'clientOrganization' || /客户|委托|服务对象|\b(?:client|customer)\b/iu.test(item.quote ?? '')));
      return supportedRelationEvidence(safe, relation, record.entity, target.entity);
    };
    try {
      const organizations = await this.deps.organizations.confirmedOrganizationIds(identity.credit_code, context);
      available = organizations.available;
      if (!organizations.complete) warn('GRAPH_ORGANIZATIONS_INCOMPLETE');
      if (!organizations.available) warn('GRAPH_UNAVAILABLE');
      for (const warning of organizations.warnings) warn(warning === 'GRAPH_NOT_CONFIGURED' ? 'GRAPH_UNAVAILABLE' : warning);
      const confirmed = new Set(organizations.ids), refs = new Map<string, RelationRef>();
      for (let i = 0; i < organizations.ids.length; i += 50) {
        let offset = 0;
        for (let n = 0; n < 40; n++) {
          const raw = asObject(await context.request('company_relations', { organization_ids: organizations.ids.slice(i, i + 50), offset, limit: 50 }));
          for (const item of array(raw.items)) { const p = relationRefSchema.safeParse(item); if (p.success) refs.set(p.data.relation_id, p.data); }
          if (raw.complete === true && raw.next_offset === null) break;
          if (!Number.isSafeInteger(raw.next_offset) || (raw.next_offset as number) <= offset) { warn('GRAPH_RELATIONS_INCOMPLETE'); break; }
          offset = raw.next_offset as number;
        }
      }
      const projectIds = new Set<string>(), personIds = new Set<string>();
      for (const relation of refs.values()) {
        if (!confirmed.has(relation.target_id)) continue;
        if (relation.relation_type === 'worksFor') personIds.add(relation.source_id);
        if (relation.relation_type === 'clientOrganization') projectIds.add(relation.source_id);
      }
      // Customer projects expose their member edges through the existing company relation page.
      for (const relation of refs.values()) if (relation.relation_type === 'memberOf' && projectIds.has(relation.target_id)) personIds.add(relation.source_id);
      const selectedPeople = [...personIds].slice(0, 20);
      if (personIds.size > 20) warn('GRAPH_ENTITY_BUDGET_EXHAUSTED');
      for (const id of selectedPeople) {
        const person = await get(id); if (!person || person.entity.label !== 'Person') continue;
        for (const r of person.relations) if (r.source_id === id && r.relation_type === 'memberOf') projectIds.add(r.target_id);
      }
      if (projectIds.size > 10) warn('GRAPH_ENTITY_BUDGET_EXHAUSTED');
      const selectedProjects = [...projectIds].slice(0, 10);
      // Membership may be visible only on the project's contact pages, not the summary page.
      for (const id of selectedProjects) {
        const project = await get(id); if (!project || project.entity.label !== 'Project') continue;
        retainFieldConflicts(project);
        for (const relation of project.relations) if (relation.relation_type === 'memberOf' && relation.target_id === id && !personIds.has(relation.source_id)) {
          if (selectedPeople.length >= 20) { warn('GRAPH_ENTITY_BUDGET_EXHAUSTED'); break; }
          personIds.add(relation.source_id); selectedPeople.push(relation.source_id); await get(relation.source_id);
        }
      }
      for (const id of selectedPeople) {
        const person = cache.get(id); if (!person || person.entity.label !== 'Person') continue;
        retainFieldConflicts(person);
        const employments: { relation: ContactRelation; target: ContactRecord; proof: ContactEvidence }[] = [];
        for (const relation of person.relations) if (relation.relation_type === 'worksFor' && relation.source_id === id) {
          const target = await get(relation.target_id); if (!target || target.entity.label !== 'Organization') continue;
          const proof = relationProof(person, relation, target); if (proof) employments.push({ relation, target, proof });
        }
        const targetEmployment = employments.filter(item => confirmed.has(item.target.entity.entity_id));
        for (const { proof } of targetEmployment) {
          const usageIndex = proof.quote!.search(/使用|运用|采用|\b(?:used?|using)\b/iu);
          const supportQuote = usageIndex > 0 && !hasUseLimitation(proof.quote!) ? proof.quote!.slice(0, usageIndex).trim() : proof.quote!;
          const support = add(toEvidence(person, proof, scope, 'other', [], supportQuote)); if (!support) continue;
          const useClause = proof.quote!.split(/[，,。；;\n]/u).find(part => part.includes(identity.legal_name) && productsFor(part).length && /使用|运用|采用|\b(?:used?|using)\b/iu.test(part));
          const keys = useClause ? productsFor(useClause) : [];
          // Employment establishes the person's role, not the actor of a later use verb.
          const actorText = useClause
            ?.replaceAll(identity.legal_name, '')
            .replaceAll(person.entity.properties.name ?? '', '');
          const externalActor = actorText &&
            /供应商|客户|外包|外协|指导|培训|帮助|协助|企业|公司|集团|\b(?:supplier|vendor|client|customer|contractor|outsourc|guid|train)\w*/iu.test(actorText);
          if (keys.length && externalActor) {
            add(toEvidence(person, proof, keys, 'other'));
            warn('GRAPH_ATTRIBUTION_MISSING');
          }
          if (keys.length && !externalActor && !hasUseLimitation(proof.quote!) && /使用|运用|采用|\b(?:used?|using)\b/iu.test(proof.quote!)) {
            // Distinguish the attributed use excerpt from the full employment proof without invented text.
            const usage = toEvidence(person, proof, keys, 'direct_use', [support.evidence_id]);
            if (usage && usage.evidence_id !== support.evidence_id) add(usage);
          }
          const filtered = filterConflictedEvidence(person.evidence, person.conflicts);
          for (const skill of filtered.usable) if (skill.subject_kind === 'entity' && skill.subject_id === id && ['properties.skills', 'properties.knowsAbout'].includes(skill.field_path)) {
            const productKeys = productsFor(skill.quote ?? '');
            if (productKeys.length) add(toEvidence(person, skill, productKeys, 'associated_skill', [support.evidence_id]));
          }
        }
        if (!targetEmployment.length && person.evidence.some(e => e.field_path === 'properties.skills' && productsFor(e.quote ?? '').length)) warn('GRAPH_ATTRIBUTION_MISSING');
        for (const membership of person.relations) if (membership.relation_type === 'memberOf' && membership.source_id === id && selectedProjects.includes(membership.target_id)) {
          const project = cache.get(membership.target_id); if (!project || project.entity.label !== 'Project') continue;
          const memberProof = relationProof(person, membership, project); if (!memberProof) { warn('GRAPH_ATTRIBUTION_MISSING'); continue; }
          const memberEvidence = toEvidence(person, memberProof, scope, 'other'); if (!memberEvidence) continue;
          const filtered = filterConflictedEvidence(project.evidence, project.conflicts);
          for (const software of filtered.usable) if (software.subject_kind === 'entity' && software.subject_id === project.entity.entity_id && ['properties.name', 'properties.description'].includes(software.field_path)) {
            // Attribute one source fact at a time: ownership and software cannot cross clauses.
            for (const clause of (software.quote ?? '').split(/[，,。；;\n]/u).map(part => part.trim())) {
              const keys = productsFor(clause); if (!keys.length) continue;
              if (!/使用|运用|采用|\b(?:used?|using)\b/iu.test(clause) || hasUseLimitation(clause)) {
                add(toEvidence(project, software, keys, 'other', [], clause)); continue;
              }
              const projectName = project.entity.properties.name;
              const namesProject = Boolean(projectName && clause.includes(projectName));
              const directOwnership = namesProject && clause.includes(identity.legal_name)
                && /内部|所属|自有|本公司|internal|owned/iu.test(clause)
                && !/供应商|外包|外协|承接|委托|\b(?:supplier|vendor|contractor|outsourc)/iu.test(clause);
              if (directOwnership && targetEmployment.length) {
                const job = add(toEvidence(person, targetEmployment[0].proof, scope, 'other')); if (!job) continue;
                add(memberEvidence);
                add(toEvidence(project, software, keys, 'project_use', [job.evidence_id, memberEvidence.evidence_id], clause));
              } else {
                const clientRelation = project.relations.find(r => r.relation_type === 'clientOrganization' && r.source_id === project.entity.entity_id && confirmed.has(r.target_id));
                const outside = employments.find(item => !confirmed.has(item.target.entity.entity_id)
                  && Boolean(item.target.entity.properties.name && clause.includes(item.target.entity.properties.name)));
                if (!namesProject || !clientRelation || !outside) {
                  add(toEvidence(project, software, keys, 'other', [], clause));
                  warn('GRAPH_ATTRIBUTION_MISSING'); continue;
                }
                const target = await get(clientRelation.target_id); if (!target) continue;
                const clientProof = relationProof(project, clientRelation, target); if (!clientProof) continue;
                const clientEvidence = add(toEvidence(project, clientProof, scope, 'other'));
                const employer = add(toEvidence(person, outside.proof, scope, 'other'));
                if (!clientEvidence || !employer) continue;
                add(memberEvidence);
                add(toEvidence(project, software, keys, 'supplier_project', [clientEvidence.evidence_id, employer.evidence_id, memberEvidence.evidence_id], clause));
              }
            }
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof Error ? error.message : '';
      warn(code === 'GRAPH_IPC_BUDGET_EXHAUSTED' ? code : 'GRAPH_UNAVAILABLE');
    }
    const packed = packEvidenceGroups(candidates);
    if (packed.omitted) warn('GRAPH_EVIDENCE_OMITTED');
    const reasons = [...warnings].sort();
    return { evidence: packed.evidence, warnings: reasons, conflict_evidence_ids: [...conflictIds].filter(id => packed.evidence.some(e => e.evidence_id === id)),
      source_status: [{ source: 'graph', status: !available ? 'unavailable' : reasons.length ? 'partial' : 'completed', ...(reasons.length ? { error_code: reasons[0] } : {}), omitted: packed.omitted }],
      coverage_hints: scope.map(product => ({ product, complete: available && !reasons.length, reasons })) };
  }
}
