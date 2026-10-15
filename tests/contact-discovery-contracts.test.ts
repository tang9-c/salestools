import { expect, it } from 'vitest';
import { PublicContactSchema, ContactSnapshotPayloadSchema } from '../src/contracts/contact.js';
import { projectContactHistory, type StoredContactSnapshot } from '../src/contacts/contact-cache.js';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/database.js';
import { ContactSnapshotRepository } from '../src/db/contact-snapshot-repository.js';

const observedAt = '2026-10-15T00:00:00.000Z';
const person = { name: '林知远', title: null, source_url: 'https://example.test/team',
  published_at: null, affiliation_status: 'unverified', evidence_quote: '示例公司的林知远参加了活动。' } as const;
it('keeps a located person without inventing a title', () => {
  expect(PublicContactSchema.parse(person)).toEqual(person);
});
it('stores more than ten observations without truncation', () => {
  const contacts = Array.from({ length: 12 }, (_, i) => ({ name: `示例人员${i}`,
    title: '工程师', source_url: `https://example.test/${i}`, published_at: null }));
  expect(ContactSnapshotPayloadSchema.parse({ companies: [{ company_name: '示例公司', contacts }],
    warnings: [], collected_at: observedAt }).companies[0]!.contacts).toHaveLength(12);
});
it('rejects direct contact details in evidence quotes', () => {
  for (const evidence_quote of ['林知远 foo@example.test', '林知远 13800000000']) {
    expect(PublicContactSchema.safeParse({ ...person, evidence_quote }).success).toBe(false);
  }
});
it('reads legacy snapshots and persists all four groups without a migration', () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const repository = new ContactSnapshotRepository(db);
    const legacy = { name: '林知远', title: '工程师', source_url: 'https://example.test/team', published_at: null };
    const payload = ContactSnapshotPayloadSchema.parse({ companies: ['示例', '示例有限公司', '示例集团', '示例子公司']
      .map(company_name => ({ company_name, contacts: [legacy] })), warnings: [], collected_at: observedAt });
    repository.append({ cacheKey: 'a'.repeat(64), normalizedQuery: '示例', normalizedRegionHint: null,
      payload, storedAt: observedAt });
    const restored = repository.findLatest('a'.repeat(64))!;
    expect(restored.payload.companies).toHaveLength(4);
    expect(restored.payload.companies[0]!.contacts[0]).toEqual(legacy);
    expect(restored.payload.coverage).toBeUndefined();
  } finally { db.close(); }
});
it('binds real SQLite reads to the query and region key, requires the anchor and excludes newer IDs', () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const repository = new ContactSnapshotRepository(db);
    const key = 'a'.repeat(64);
    const otherRegionKey = 'b'.repeat(64);
    const otherQueryKey = 'c'.repeat(64);
    const append = (cacheKey: string, normalizedQuery: string, normalizedRegionHint: string | null, name: string) => {
      repository.append({ cacheKey, normalizedQuery, normalizedRegionHint, storedAt: observedAt,
        payload: ContactSnapshotPayloadSchema.parse({ companies: [{ company_name: '示例公司', contacts: [{ ...person, name }] }],
          warnings: [], collected_at: observedAt }) });
      return repository.findLatest(cacheKey)!.snapshotId;
    };
    const olderId = append(key, '示例', '上海', '旧观察');
    const otherRegionId = append(otherRegionKey, '示例', '北京', '异地观察');
    const otherQueryId = append(otherQueryKey, '另一公司', '上海', '异企观察');
    const anchorId = append(key, '示例', '上海', '绑定观察');
    const newerId = append(key, '示例', '上海', '后续观察');
    expect(newerId).toBeGreaterThan(anchorId);
    const bound = repository.findThroughSnapshot(key, anchorId)!;
    expect(bound.map(row => row.snapshotId)).toEqual([olderId, anchorId]);
    expect(bound.map(row => row.payload.companies[0]!.contacts[0]!.name)).toEqual(['旧观察', '绑定观察']);
    expect(repository.findThroughSnapshot(key, otherRegionId)).toBeNull();
    expect(repository.findThroughSnapshot(key, otherQueryId)).toBeNull();
    expect(repository.findThroughSnapshot(otherRegionKey, anchorId)).toBeNull();
    expect(repository.findThroughSnapshot(otherQueryKey, anchorId)).toBeNull();
    expect(repository.findThroughSnapshot(key, newerId + 1)).toBeNull();
    const output = projectContactHistory(bound, anchorId);
    expect(output.companies[0]!.contacts[0]!.name).toBe('绑定观察');
    expect(output.companies[0]!.historical_contacts.map(contact => contact.name)).toEqual(['旧观察']);
    expect(JSON.stringify(output)).not.toMatch(/后续观察|异地观察|异企观察/);
  } finally { db.close(); }
});
function snapshot(id: number, companies: unknown[]): StoredContactSnapshot {
  return { snapshotId: id, cacheKey: 'a'.repeat(64), normalizedQuery: '示例', normalizedRegionHint: null,
    storedAt: `2026-10-${id === 1 ? '14' : '15'}T00:00:00.000Z`,
    payload: ContactSnapshotPayloadSchema.parse({ companies, warnings: [], collected_at: observedAt }) };
}
it('preserves twelve historical observations and separate source, quote, status and title identities', () => {
  const contacts = Array.from({ length: 12 }, (_, i) => ({ ...person, source_url: `https://example.test/${i}` }));
  const current = { ...person, source_url: 'https://example.test/0', title: '工程师' };
  const output = projectContactHistory([
    snapshot(1, [{ company_name: '示例公司', contacts: [...contacts,
      { ...person, evidence_quote: '林知远与示例公司合作。' },
      { ...person, affiliation_status: 'employment_evidence' }] }]),
    snapshot(2, [{ company_name: '示例公司', contacts: [current] }]),
  ]);
  expect(output.companies[0]!.historical_contacts).toHaveLength(14);
  expect(output.companies[0]!.historical_contacts.every(item => item.status === 'historical_evidence')).toBe(true);
});
it('keeps four exact original company groups including historical-only groups', () => {
  const companies = ['示例', '示例有限公司', '示例集团', '示例子公司'].map(company_name => ({ company_name, contacts: [person] }));
  expect(snapshot(1, companies).payload.companies).toHaveLength(4);
  const output = projectContactHistory([snapshot(1, companies), snapshot(2, companies.slice(0, 2))]);
  expect(output.companies).toHaveLength(4);
  expect(output.companies.slice(2).every(company => company.historical_contacts.length === 1)).toBe(true);
});
it('accepts optional coverage and keeps legacy records without verification defaults', () => {
  const legacy = { name: '林知远', title: '工程师', source_url: 'https://example.test/team', published_at: null };
  const coverage = { version: 2, total_pages: 1, total_chunks: 2, processed_chunks: 1,
    pending_pages: ['https://example.test/team'], complete: false };
  const payload = ContactSnapshotPayloadSchema.parse({ companies: [{ company_name: '示例公司', contacts: [legacy] }],
    warnings: [], collected_at: observedAt, coverage });
  expect(payload.coverage).toEqual(coverage);
  expect(payload.companies[0]!.contacts[0]).toEqual(legacy);
});
