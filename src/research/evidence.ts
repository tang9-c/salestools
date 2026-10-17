import { createHash } from 'node:crypto';
import { findSoftwareAliases } from './software-aliases.js';
import { ResearchItemSchema, type ResearchItem } from '../contracts/research.js';
import { ResearchClaimSchema, ResearchEvidenceSchema, type ResearchClaim, type ResearchEvidence, type ProductKey } from './contracts.js';
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export function containsPrivateContact(text: string): boolean {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, '').replace(/\b[0-9A-Z]{18}\b/gu, '');
  return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\d ()-]{8,}\d)|电话|手机|邮箱|婚姻|身份证|出生日期|家庭住址)/iu.test(withoutDates);
}
/** Shared conservative guard for all supported use verbs; preserve qualified text as a clue. */
export function hasUseLimitation(text: string): boolean {
  return /(?:不|没有|未|未曾|不曾|并未|尚未)(?:实际|正式|直接|曾经)?\s*(?:使用|采用|运用|部署|安装|采购)|尚未|计划|拟|\b(?:not|never|planned?|proposed?|intend(?:s|ed)?|will|would)\b/iu.test(text);
}
export interface TrustedSourceCommon {
  content: string; collected_at: string; published_at: string | null;
  company_scope: ResearchEvidence['company_scope'];
  valid_from?: string | null; valid_to?: string | null;
  /** Set by a trusted adapter when the original record/URL is known (including syndication). */
  original_source_key?: string;
}
export type TrustedEvidenceSource = TrustedSourceCommon & (
  | { source_type: 'web'; url: string; publisher: string }
  | { source_type: 'qcc'; url: string | null; tool: string; record_id: string }
  | { source_type: 'graph'; locator: Extract<ResearchEvidence, { source_type: 'graph' }>['locator'] }
  | { source_type: 'assessment'; url: string | null; assessment_id: string; evidence_id: string }
);
export interface EvidenceExtraction {
  title: string; quote: string; product_keys: ProductKey[];
  signal_kind: ResearchEvidence['signal_kind']; required_evidence_ids?: string[];
}
/** Metadata comes only from the trusted adapter; extracted text must be an exact substring. */
export function ingestEvidence(source: TrustedEvidenceSource, extraction: EvidenceExtraction): ResearchEvidence | null {
  if (!extraction.quote || extraction.quote.trim() !== extraction.quote || !source.content.includes(extraction.quote)
    || containsPrivateContact(extraction.quote) || containsPrivateContact(extraction.title)) return null;
  const locator = source.source_type === 'web' ? { url: source.url, publisher: source.publisher }
    : source.source_type === 'qcc' ? { tool: source.tool, record_id: source.record_id }
      : source.source_type === 'assessment' ? { assessment_id: source.assessment_id, evidence_id: source.evidence_id } : source.locator;
  const underlying = source.source_type === 'web' ? source.url
    : source.source_type === 'qcc' ? `${source.tool}:${source.record_id}`
      : source.source_type === 'assessment' ? `${source.assessment_id}:${source.evidence_id}`
        : source.locator.file_sha256 ?? source.locator.text_hash!;
  const source_key = sha256(source.original_source_key ?? `${source.source_type}:${underlying}`);
  const evidence_id = sha256(JSON.stringify(canonical({ source_type: source.source_type, locator, quote: extraction.quote, content_version: sha256(source.content) })));
  const parsed = ResearchEvidenceSchema.safeParse({ evidence_id, source_type: source.source_type, source_key,
    title: extraction.title, quote: extraction.quote, url: source.source_type === 'graph' ? null : source.url,
    published_at: source.published_at, collected_at: source.collected_at,
    valid_from: source.valid_from ?? null, valid_to: source.valid_to ?? null, locator,
    company_scope: source.company_scope, signal_kind: extraction.signal_kind,
    product_keys: extraction.product_keys, required_evidence_ids: [...new Set(extraction.required_evidence_ids ?? [])] });
  return parsed.success ? parsed.data : null;
}
export function independentSourceCount(evidence: readonly ResearchEvidence[]): number {
  return new Set(evidence.map(item => item.source_key)).size;
}
export function evidenceDependencyGroup(root: ResearchEvidence, evidence: readonly ResearchEvidence[]): ResearchEvidence[] | null {
  const byId = new Map(evidence.map(item => [item.evidence_id, item]));
  const visited = new Set<string>(), pending = [root.evidence_id], group: ResearchEvidence[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const item = byId.get(id);
    if (!item || item.required_evidence_ids.includes(id)) return null;
    group.push(item);
    pending.push(...item.required_evidence_ids);
  }
  return group;
}
export function packEvidenceGroups(evidence: readonly ResearchEvidence[], limits: { max_count?: number; max_excerpt_bytes?: number } = {}) {
  const unique = [...new Map(evidence.map(item => [item.evidence_id, item])).values()];
  const admitted: ResearchEvidence[] = [], included = new Set<string>();
  let bytes = 0;
  for (const root of unique) {
    if (included.has(root.evidence_id)) continue;
    const closure = evidenceDependencyGroup(root, unique);
    if (!closure) continue;
    const group = closure.filter(item => !included.has(item.evidence_id));
    const groupBytes = group.reduce((sum, item) => sum + Buffer.byteLength(item.quote, 'utf8'), 0);
    if (group.length + admitted.length > Math.min(80, limits.max_count ?? 80)
      || bytes + groupBytes > Math.min(1024 * 1024, limits.max_excerpt_bytes ?? 1024 * 1024)) continue;
    admitted.push(...group);
    for (const item of group) included.add(item.evidence_id);
    bytes += groupBytes;
  }
  return { evidence: admitted, omitted: unique.length - admitted.length, excerpt_bytes: bytes };
}

export function validateClaimResult(claim: ResearchClaim, evidence: readonly ResearchEvidence[], options: { conflict_evidence_ids?: readonly string[] } = {}) {
  const reasons: string[] = [];
  if (!ResearchClaimSchema.safeParse(claim).success) return { valid: false, reasons: ['INVALID_CLAIM'] };
  const roots = claim.evidence_ids.map(id => evidence.find(item => item.evidence_id === id));
  const closure = roots.flatMap(item => item ? evidenceDependencyGroup(item, evidence) ?? [] : []);
  if (roots.some(item => !item || !evidenceDependencyGroup(item, evidence))) reasons.push('INCOMPLETE_EVIDENCE_DEPENDENCIES');
  if (closure.some(item => !ResearchEvidenceSchema.safeParse(item).success)) reasons.push('INVALID_EVIDENCE');
  if (claim.product_keys.some(product => !roots.some(item => item?.product_keys.includes(product)))) reasons.push('PRODUCT_NOT_SUPPORTED');
  if (claim.kind === 'hypothesis' && !/待验证|待核实|假设|hypothesis|unverified/iu.test(claim.text)) reasons.push('HYPOTHESIS_NOT_LABELLED');
  const assertive = claim.kind === 'supported' || claim.kind === 'strong_signal';
  if (assertive && closure.some(item => options.conflict_evidence_ids?.includes(item.evidence_id))) reasons.push('CONFLICTING_EVIDENCE');
  if (assertive && roots.some(item => item?.company_scope !== 'confirmed')) reasons.push('UNCONFIRMED_COMPANY');
  const useClaim = /(?:use|deploy|install|purchase|使用|采用|运用|部署|采购|安装)/iu.test(`${claim.predicate ?? ''} ${claim.text}`);
  if (assertive && useClaim && claim.product_keys.some(product => !roots.some(item => item?.product_keys.includes(product) && ['direct_use', 'project_use'].includes(item.signal_kind)))) reasons.push('INSUFFICIENT_USE_ATTRIBUTION');
  if (assertive && useClaim && roots.some(item => item && hasUseLimitation(item.quote))) reasons.push('QUALIFIED_OR_NEGATED_USE');
  if (claim.temporal_scope === 'current_supported' && roots.some(item => !item || !item.valid_from || item.valid_to || item.published_at === null)) reasons.push('CURRENT_USE_NOT_SUPPORTED');
  if (claim.kind === 'unknown' && useClaim && !/未知|待核实|无法确认|unknown|unconfirmed/iu.test(claim.text)) reasons.push('AFFIRMATIVE_UNKNOWN');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}
export const validateClaim = (claim: ResearchClaim, evidence: readonly ResearchEvidence[], options?: Parameters<typeof validateClaimResult>[2]): boolean => validateClaimResult(claim, evidence, options).valid;
/** Legacy evaluators accept only real public sources; graph/assessment remain research-native. */
export function toResearchItem(evidence: ResearchEvidence, legalName = ''): ResearchItem | null {
  if (evidence.source_type !== 'web' && evidence.source_type !== 'qcc') return null;
  const parsed = ResearchItemSchema.safeParse({ evidenceId: evidence.evidence_id,
    source: evidence.source_type === 'web' ? 'doubao_search' : 'qcc', sourceKind: evidence.source_type === 'web' ? 'web' : 'company',
    title: evidence.title, url: evidence.url, originalPublisher: evidence.source_type === 'web' ? evidence.locator.publisher : null,
    originalDomain: evidence.url ? new URL(evidence.url).hostname : null, summary: evidence.quote, content: evidence.quote,
    publishedAt: evidence.published_at ? new Date(evidence.published_at).toISOString() : null, collectedAt: new Date(evidence.collected_at).toISOString(), mentionedName: legalName,
    entityScope: 'legal_entity', entityMatch: evidence.company_scope, matchBasis: ['validated_research_source'], query: null, position: null, logId: null });
  return parsed.success ? parsed.data : null;
}
/** Semantic keys are accepted only when the trusted signal and its literal text support them. */
export function normalizeClaimSemantics(
  claim: ResearchClaim,
  evidence: readonly ResearchEvidence[],
  companyKey?: string,
): ResearchClaim {
  const unstructured = () => ({
    ...claim,
    subject_key: null,
    predicate: null,
    object_key: null,
  });
  if (
    !companyKey ||
    claim.subject_key !== companyKey ||
    !claim.predicate ||
    !claim.object_key
  )
    return unstructured();
  const product = claim.product_keys.find((p) => p === claim.object_key);
  if (!product) return unstructured();
  const sources = evidence.filter(
    (e) =>
      claim.evidence_ids.includes(e.evidence_id) &&
      e.company_scope === 'confirmed' &&
      e.product_keys.includes(product) &&
      findSoftwareAliases(e.quote).some((alias) => alias.product === product),
  );
  const supported = sources.some((e) => {
    if (claim.predicate === 'associated_clue')
      return (
        claim.kind === 'hypothesis' &&
        ['associated_skill', 'supplier_project'].includes(e.signal_kind)
      );
    if (
      !['supported', 'strong_signal'].includes(claim.kind) ||
      !e.quote.includes(claim.text)
    )
      return false;
    if (claim.predicate === 'uses')
      return (
        ['direct_use', 'project_use'].includes(e.signal_kind) &&
        !hasUseLimitation(e.quote)
      );
    if (claim.predicate === 'recruitment')
      return e.signal_kind === 'job_requirement';
    if (claim.predicate === 'requires_skill') {
      if (e.signal_kind !== 'job_requirement') return false;
      // A requirement for another software cannot lend its verb to this product.
      return e.quote.split(/[，,。；;\n]|但|而|\b(?:but|however|whereas|while)\b/iu).some((clause) => {
        const alias = findSoftwareAliases(clause).find((a) => a.product === product);
        if (
          !alias ||
          /(?:不|未|没有|并非)(?:必|要求|需要|强制|硬性|熟练|熟悉|掌握|精通)|无需|无须|非必|可选|任选|任一|之一|或者|或|优先|加分|\b(?:not|no|optional|preferred|bonus|one of|either|or|nice[- ]to[- ]have)\b/iu.test(clause)
        )
          return false;
        const name = alias.matched_alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        // Only grammatical skill modifiers may connect the requirement and name.
        const before = new RegExp(
          `(?:要求|必须|必需|需要|熟练|熟悉|掌握|精通|\\b(?:requires?|required|must|mandatory)\\b)(?:\\s|熟练|熟悉|掌握|精通|具备|使用|的|proficiency|experience|skills?|knowledge|in|of|with|be|have){0,8}${name}(?![A-Za-z0-9_])`,
          'iu',
        );
        const after = new RegExp(
          `${name}(?![A-Za-z0-9_])(?:\\s|技能|能力|proficiency|experience|skills?|knowledge|is|are){0,8}(?:必需|必须|要求|\\b(?:required|mandatory)\\b)`,
          'iu',
        );
        return before.test(clause) || after.test(clause);
      });
    }
    return false;
  });
  return supported ? claim : unstructured();
}
