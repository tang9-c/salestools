import { createHash } from 'node:crypto';
import {
  GetContactsOutputSchema,
  type ContactSnapshotPayload,
  type GetContactsOutput,
  type HistoricalContact,
} from '../contracts/index.js';

export interface StoredContactSnapshot {
  snapshotId: number;
  cacheKey: string;
  normalizedQuery: string;
  normalizedRegionHint: string | null;
  payload: ContactSnapshotPayload;
  storedAt: string;
}

export interface ContactCacheIdentity {
  cacheKey: string;
  normalizedQuery: string;
  normalizedRegionHint: string | null;
}

interface HistoricalObservation {
  companyKey: string;
  companyName: string;
  contact: ContactSnapshotPayload['companies'][number]['contacts'][number];
  firstSeenAt: string;
  lastSeenAt: string;
}

export function normalizeContactCachePart(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function contactCacheIdentity(input: { query: string; regionHint?: string }): ContactCacheIdentity {
  const normalizedQuery = normalizeContactCachePart(input.query);
  const normalizedRegionHint = input.regionHint === undefined
    ? null
    : normalizeContactCachePart(input.regionHint);
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([normalizedQuery, normalizedRegionHint]))
    .digest('hex');
  return { cacheKey, normalizedQuery, normalizedRegionHint };
}

function contactKey(companyName: string, name: string, title: string): string {
  return [companyName, name, title].map(normalizeContactCachePart).join('\0');
}

function historyContact(observation: HistoricalObservation): HistoricalContact {
  return {
    ...observation.contact,
    first_seen_at: observation.firstSeenAt,
    last_seen_at: observation.lastSeenAt,
    status: 'historical_evidence',
  };
}

function compareHistory(left: HistoricalObservation, right: HistoricalObservation): number {
  return right.lastSeenAt.localeCompare(left.lastSeenAt)
    || normalizeContactCachePart(left.contact.name)
      .localeCompare(normalizeContactCachePart(right.contact.name))
    || normalizeContactCachePart(left.contact.title)
      .localeCompare(normalizeContactCachePart(right.contact.title));
}

export function projectContactHistory(
  inputSnapshots: readonly StoredContactSnapshot[],
): GetContactsOutput {
  if (inputSnapshots.length === 0) throw new Error('At least one contact snapshot is required');
  const snapshots = [...inputSnapshots].sort((left, right) => (
    left.storedAt.localeCompare(right.storedAt) || left.snapshotId - right.snapshotId
  ));
  const latest = snapshots.at(-1)!;
  const currentKeys = new Set(latest.payload.companies.flatMap(company => (
    company.contacts.map(contact => contactKey(company.company_name, contact.name, contact.title))
  )));
  const observations = new Map<string, HistoricalObservation>();

  for (const snapshot of snapshots.slice(0, -1)) {
    for (const company of snapshot.payload.companies) {
      const companyKey = normalizeContactCachePart(company.company_name);
      for (const contact of company.contacts) {
        const key = contactKey(company.company_name, contact.name, contact.title);
        if (currentKeys.has(key)) continue;
        const existing = observations.get(key);
        if (existing === undefined) {
          observations.set(key, {
            companyKey,
            companyName: company.company_name,
            contact,
            firstSeenAt: snapshot.payload.collected_at,
            lastSeenAt: snapshot.payload.collected_at,
          });
        } else {
          existing.companyName = company.company_name;
          existing.contact = contact;
          existing.lastSeenAt = snapshot.payload.collected_at;
        }
      }
    }
  }

  const observationsByCompany = new Map<string, HistoricalObservation[]>();
  for (const observation of observations.values()) {
    const company = observationsByCompany.get(observation.companyKey) ?? [];
    company.push(observation);
    observationsByCompany.set(observation.companyKey, company);
  }

  const companies: GetContactsOutput['companies'] = latest.payload.companies.map(company => {
    const history = observationsByCompany.get(normalizeContactCachePart(company.company_name)) ?? [];
    observationsByCompany.delete(normalizeContactCachePart(company.company_name));
    return {
      ...company,
      historical_contacts: history.sort(compareHistory).slice(0, 10).map(historyContact),
    };
  });

  const historicalOnly = [...observationsByCompany.values()]
    .filter(history => history.length > 0)
    .sort((left, right) => (
      right.reduce((latestSeen, item) => item.lastSeenAt > latestSeen ? item.lastSeenAt : latestSeen, '')
        .localeCompare(left.reduce(
          (latestSeen, item) => item.lastSeenAt > latestSeen ? item.lastSeenAt : latestSeen,
          '',
        ))
    ));
  for (const history of historicalOnly) {
    if (companies.length >= 3) break;
    history.sort(compareHistory);
    companies.push({
      company_name: history[0]!.companyName,
      contacts: [],
      historical_contacts: history.slice(0, 10).map(historyContact),
    });
  }

  return GetContactsOutputSchema.parse({
    companies,
    warnings: latest.payload.warnings,
    collected_at: latest.payload.collected_at,
  });
}
