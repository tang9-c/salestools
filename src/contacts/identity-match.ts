import type { ContactEntity, ContactEvidence, ImportCandidate } from '../contracts/index.js';

// Docling Graph bbcd0e4 merge/identity.py can fold nodes by template keys.
// File imports instead produce review suggestions: a shared or recycled phone
// and a matching name cannot establish person identity without user approval.
export function normalizePhoneForSuggestion(value: string): string {
  return value.trim().replace(/[\s().-]/gu, '');
}

export interface MatchSuggestion {
  entityId: string;
  candidateId: string;
  candidateName: string;
  existingName: string;
  reasons: Array<{ kind: 'self_phone' | 'email' | 'instant_messaging' | 'name_with_organization'; value: string }>;
  candidateSourceDate?: string;
  existingUpdatedAt: string;
  candidateSources: MatchSource[];
  existingSources: MatchSource[];
}

export interface MatchSource {
  sourceType: ContactEvidence['source_type'];
  collectedAt: string;
  fileName?: string;
  sourceUrl?: string;
}

export interface MatchContext {
  candidateOrganizations?: readonly string[];
  existingOrganizationsById?: Readonly<Record<string, readonly string[]>>;
  existingEvidenceById?: Readonly<Record<string, readonly ContactEvidence[]>>;
}

type PersonCandidate = Extract<ImportCandidate, { label: 'Person' }>;
type PersonEntity = Extract<ContactEntity, { label: 'Person' }>;

function ownPhones(person: PersonCandidate | PersonEntity): string[] {
  const direct = person.properties.telephone ?? [];
  const ownedPoints = (person.properties.contactPoint ?? [])
    .filter(point => /^(self|personal|本人|私人)$/iu.test(point.contactType))
    .flatMap(point => point.telephone);
  return [...direct, ...ownedPoints].map(normalizePhoneForSuggestion).filter(Boolean);
}

function emails(person: PersonCandidate | PersonEntity): string[] {
  const direct = person.properties.email ?? [];
  const ownedPoints = (person.properties.contactPoint ?? [])
    .filter(point => /^(self|personal|本人|私人)$/iu.test(point.contactType))
    .flatMap(point => point.email);
  return [...direct, ...ownedPoints].map(value => value.trim().toLowerCase()).filter(Boolean);
}

function accounts(person: PersonCandidate | PersonEntity): string[] {
  return person.extensions.instantMessaging.map(item => `${item.platform.toLowerCase()}\0${item.accountId}`);
}

function sources(evidence: readonly ContactEvidence[]): MatchSource[] {
  const values = evidence.map(item => ({ sourceType: item.source_type, collectedAt: item.collected_at,
    ...(item.file_name ? { fileName: item.file_name } : {}),
    ...(item.source_url ? { sourceUrl: item.source_url } : {}) }));
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
}

export function suggestMatches(
  candidate: ImportCandidate, existing: readonly ContactEntity[], context: MatchContext = {},
): MatchSuggestion[] {
  if (candidate.label !== 'Person') return [];
  const candidatePhones = new Set(ownPhones(candidate));
  const candidateEmails = new Set(emails(candidate));
  const candidateAccounts = new Set(accounts(candidate));
  const results: MatchSuggestion[] = [];
  for (const entity of existing) {
    if (entity.label !== 'Person' || entity.metadata.archived_at) continue;
    const reasons: MatchSuggestion['reasons'] = [];
    for (const phone of ownPhones(entity)) {
      if (candidatePhones.has(phone)) reasons.push({ kind: 'self_phone', value: phone });
    }
    for (const email of emails(entity)) {
      if (candidateEmails.has(email)) reasons.push({ kind: 'email', value: email });
    }
    for (const account of accounts(entity)) {
      if (candidateAccounts.has(account)) reasons.push({ kind: 'instant_messaging', value: account.replace('\0', ':') });
    }
    if (candidate.properties.name && candidate.properties.name.normalize('NFKC').trim().toLowerCase()
      === entity.properties.name.normalize('NFKC').trim().toLowerCase()) {
      const candidateOrgs = new Set((context.candidateOrganizations ?? []).map(value => value.normalize('NFKC').trim().toLowerCase()));
      for (const org of context.existingOrganizationsById?.[entity.entity_id] ?? []) {
        if (candidateOrgs.has(org.normalize('NFKC').trim().toLowerCase())) {
          reasons.push({ kind: 'name_with_organization', value: org });
        }
      }
    }
    if (reasons.length === 0) continue;
    const dates = candidate.evidence.map(item => item.collected_at).sort();
    results.push({ entityId: entity.entity_id, candidateId: candidate.candidate_id,
      candidateName: candidate.properties.name ?? '', existingName: entity.properties.name,
      reasons, ...(dates[0] ? { candidateSourceDate: dates[0] } : {}),
      existingUpdatedAt: entity.metadata.updated_at,
      candidateSources: sources(candidate.evidence),
      existingSources: sources(context.existingEvidenceById?.[entity.entity_id] ?? []) });
  }
  return results.sort((a, b) => b.reasons.length - a.reasons.length || a.entityId.localeCompare(b.entityId));
}
