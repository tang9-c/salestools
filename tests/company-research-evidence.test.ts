import { expect, it } from 'vitest';
import { ingestEvidence, independentSourceCount, validateClaim, validateClaimResult, evidenceDependencyGroup, packEvidenceGroups, toResearchItem } from '../src/research/evidence.js';
import { findSoftwareAliases } from '../src/research/software-aliases.js';
const source = { source_type: 'web' as const, url: 'https://example.org/job', publisher: '企业甲', content: '岗位要求熟练掌握 Creo，未部署 CATIA。', collected_at: '2026-10-17T00:00:00Z', published_at: null, company_scope: 'confirmed' as const };
const extraction = { title: '招聘', quote: '岗位要求熟练掌握 Creo', product_keys: ['creo' as const], signal_kind: 'job_requirement' as const };
it('accepts exact source substrings only and keeps content IDs stable across collection times', () => {
  const a = ingestEvidence(source, extraction)!;
  expect(a.quote).toBe('岗位要求熟练掌握 Creo');
  expect(ingestEvidence({ ...source, collected_at: '2026-10-18T00:00:00Z' }, extraction)!.evidence_id).toBe(a.evidence_id);
  expect(ingestEvidence(source, { ...extraction, quote: '企业已经部署 Creo' })).toBeNull();
  expect(ingestEvidence({ ...source, content: source.content + ' 已修订' }, extraction)!.evidence_id).not.toBe(a.evidence_id);
});
it('counts fields and syndicated copies of one trusted source once and never passes private contacts', () => {
  const a = ingestEvidence(source, extraction)!;
  const b = ingestEvidence(source, { ...extraction, quote: '未部署 CATIA', product_keys: ['catia'], signal_kind: 'other' })!;
  expect(independentSourceCount([a, b])).toBe(1);
  expect(ingestEvidence({ ...source, content: 'Creo 电话 13800138000' }, { ...extraction, quote: 'Creo 电话 13800138000' })).toBeNull();
});
it('requires dependency closure and rejects use claims from associated skills or conflicts', () => {
  const employment = ingestEvidence(source, extraction)!;
  const skill = { ...employment, evidence_id: 'skill', signal_kind: 'associated_skill' as const, required_evidence_ids: [employment.evidence_id] };
  const claim = { claim_id: 'claim', kind: 'supported' as const, text: '企业部署 Creo', product_keys: ['creo' as const], evidence_ids: ['skill'], temporal_scope: 'unknown' as const, subject_key: null, predicate: 'software_use', object_key: 'creo' };
  expect(validateClaim(claim, [skill])).toBe(false);
  expect(validateClaim(claim, [skill, employment])).toBe(false);
  expect(validateClaimResult({ ...claim, evidence_ids: [employment.evidence_id] }, [employment], { conflict_evidence_ids: [employment.evidence_id] }).reasons).toContain('CONFLICTING_EVIDENCE');
  expect(evidenceDependencyGroup(skill, [skill, employment])?.length).toBe(2);
  expect(packEvidenceGroups([skill, employment], { max_count: 1 }).evidence.map(e => e.evidence_id)).toEqual([employment.evidence_id]);
});
it('maps graph evidence without inventing a webpage and matches explicit aliases with word boundaries', () => {
  const a = ingestEvidence(source, extraction)!;
  expect(toResearchItem(a)).toMatchObject({ source: 'doubao_search', evidenceId: a.evidence_id });
  expect(toResearchItem({ ...a, source_type: 'graph', url: null, locator: { entity_id: 'p', entity_version: 1, evidence_id: 'e', text_hash: 'hash' } })).toBeNull();
  expect(findSoftwareAliases('Creo 与 CST Studio Suite；microcreology')).toMatchObject([{ product: 'creo' }, { product: 'cst' }]);
});

it('packs one complete usage chain when another root shares its employment proof', () => {
  const employment = ingestEvidence(source, extraction)!;
  const a = { ...employment, evidence_id: 'use-a', required_evidence_ids: [employment.evidence_id] };
  const b = { ...employment, evidence_id: 'use-b', required_evidence_ids: [employment.evidence_id] };
  expect(packEvidenceGroups([a, b, employment], { max_count: 2 }).evidence.map(e => e.evidence_id)).toEqual(['use-a', employment.evidence_id]);
});
it('keeps ISO dates in exact professional excerpts', () => {
  expect(ingestEvidence({ ...source, content: '2020-01-01至2022-01-01在企业甲使用Creo' }, { ...extraction, quote: '2020-01-01至2022-01-01在企业甲使用Creo' })).not.toBeNull();
});
it('rejects cross-product claims and hypotheses presented as settled facts', () => {
  const item = ingestEvidence(source, extraction)!;
  const base = { claim_id: 'c', kind: 'supported' as const, text: '企业招聘需要相关技能', product_keys: ['catia' as const], evidence_ids: [item.evidence_id], temporal_scope: 'unknown' as const, subject_key: null, predicate: 'skill_requirement', object_key: null };
  expect(validateClaim(base, [item])).toBe(false);
  expect(validateClaim({ ...base, product_keys: ['creo'], kind: 'hypothesis', text: '确定需要大量许可证' }, [item])).toBe(false);
  expect(validateClaim({ ...base, product_keys: ['creo'], kind: 'hypothesis', text: '可能需要补充许可证，待验证' }, [item])).toBe(true);
});
it('requires actual use attribution for each claimed product separately', () => {
  const creo = ingestEvidence({ ...source, content: '企业甲使用Creo设计' }, { ...extraction, quote: '企业甲使用Creo设计', signal_kind: 'direct_use' })!;
  const catia = ingestEvidence({ ...source, content: '企业甲招聘要求熟悉CATIA' }, { ...extraction, quote: '企业甲招聘要求熟悉CATIA', product_keys: ['catia'], signal_kind: 'job_requirement' })!;
  const claim = { claim_id: 'multi', kind: 'supported' as const, text: '企业甲使用Creo和CATIA', product_keys: ['creo' as const, 'catia' as const], evidence_ids: [creo.evidence_id, catia.evidence_id], temporal_scope: 'unknown' as const, subject_key: null, predicate: 'software_use', object_key: null };
  expect(validateClaimResult(claim, [creo, catia])).toMatchObject({ valid: false, reasons: ['INSUFFICIENT_USE_ATTRIBUTION'] });
  const actualCatia = ingestEvidence({ ...source, content: '企业甲使用CATIA设计' }, { ...extraction, quote: '企业甲使用CATIA设计', product_keys: ['catia'], signal_kind: 'direct_use' })!;
  expect(validateClaim({ ...claim, evidence_ids: [creo.evidence_id, actualCatia.evidence_id] }, [creo, actualCatia])).toBe(true);
  expect(validateClaim({ ...claim, text: '企业甲使用Creo', product_keys: ['creo'], evidence_ids: [creo.evidence_id] }, [creo])).toBe(true);
});
it.each(['不采用Creo', '没有采用Creo', '未运用Creo'])('rejects definite use claims from the negative source %s', wording => {
  const quote = `企业甲${wording}设计`;
  const item = ingestEvidence({ ...source, content: quote }, { ...extraction, quote, signal_kind: 'direct_use' })!;
  const claim = { claim_id: 'negative', kind: 'supported' as const, text: '企业甲使用Creo', product_keys: ['creo' as const], evidence_ids: [item.evidence_id], temporal_scope: 'unknown' as const, subject_key: null, predicate: 'software_use', object_key: 'creo' };
  expect(validateClaimResult(claim, [item]).reasons).toContain('QUALIFIED_OR_NEGATED_USE');
});
