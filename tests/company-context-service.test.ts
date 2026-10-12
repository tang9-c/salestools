import { expect, it, vi } from 'vitest';
import { AT, CODE, createContextFixture } from './fixtures/company-context.js';
import { identityHash } from '../src/companies/company-link.js';
import type { ContactEvidence } from '../src/contracts/index.js';

function report(f: ReturnType<typeof createContextFixture>, id: string, at = AT) {
  f.db.prepare(`INSERT INTO assessments
    (assessment_id,cache_key,requested_by,legal_name,credit_code,status,report_markdown,
      overall_opportunity,collected_at,created_at,completed_at)
    VALUES (?,?,?,?,?,'completed','PRIVATE BODY','high',?,?,?)`)
    .run(id, CODE, 'test', '测试装备有限公司', CODE, at, at, at);
}

it('does not attach company reports to a name-only candidate or write during search', async () => {
  const f = createContextFixture();
  try {
    report(f, 'r1');
    f.db.exec('DELETE FROM company_link_operations; DELETE FROM company_links;');
    const before = f.db.prepare('SELECT count(*) AS n FROM company_links').get();
    const result = await f.service.summaries(['o1']);
    expect(result.get('o1')?.link.state).toBe('candidate');
    expect(result.get('o1')?.report_count).toBeNull();
    const detail = await f.service.detail('o1', 0, 10);
    expect(detail.reports).toMatchObject({ total: null, complete: false, items: [] });
    expect(f.db.prepare('SELECT count(*) AS n FROM company_links').get()).toEqual(before);
    expect(f.request.mock.calls.some(([op]) => op === 'save_contact')).toBe(false);
  } finally { f.db.close(); }
});

it('shows only confirmed reports in detail and keeps completed report bodies private', async () => {
  const f = createContextFixture();
  try {
    report(f, 'r1'); report(f, 'r2');
    const detail = await f.service.detail('o1', 0, 1);
    expect(detail.link.state).toBe('confirmed');
    expect(detail.report_count).toBe(2);
    expect(detail.reports).toMatchObject({ total: 2, next_offset: 1 });
    expect(detail.latest_report?.assessment_id).toBe('r2');
    expect(JSON.stringify(detail)).not.toContain('PRIVATE BODY');
    await expect(f.service.detail('o1', -1, 1)).rejects.toThrow('INVALID_PAGINATION');
  } finally { f.db.close(); }
});

it('finds automatic matches, excludes revoked links, and deduplicates people across organizations', async () => {
  const f = createContextFixture();
  try {
    const o2 = { ...f.org, entity_id: 'o2' };
    const identifier = { '@type': 'PropertyValue' as const, propertyID: '统一社会信用代码', value: CODE };
    const evidence = (field_path: string, value: unknown): ContactEvidence => ({
      evidence_id: field_path, subject_kind: 'entity', subject_id: 'o3', field_path, value,
      source_type: 'manual', locator_status: 'not_applicable', collected_at: AT,
    } as ContactEvidence);
    const o3 = { ...f.org, entity_id: 'o3', identifiers: [identifier],
      evidence: [evidence('properties.identifier', identifier), evidence('properties.name', f.org.name)] };
    f.links.write({ action: 'confirm', organization_id: 'o2', credit_code: CODE,
      operation_id: 'o2', expected_link_version: 0, expected_organization_version: 1, note: 'test' },
    'test', identityHash(o2), AT);
    f.links.write({ action: 'unlink', organization_id: 'o1', operation_id: 'revoke',
      expected_link_version: 1, expected_organization_version: 1, note: 'test' },
    'test', identityHash(f.org), AT);
    f.request.mockImplementation(async (op) => {
      if (op === 'company_organizations') return { items: [f.org, o2, o3], total: null, next_offset: null, complete: true };
      if (op === 'company_relations') return { items: [
        { relation_id: 'a', source_id: 'p1', target_id: 'o2', relation_type: 'worksFor' },
        { relation_id: 'b', source_id: 'p1', target_id: 'o3', relation_type: 'alumniOf' },
      ], total: null, next_offset: null, complete: true };
      return { items: [], total: null, next_offset: null, complete: true };
    });
    const overview = await f.service.overview(CODE);
    expect(overview.organization_ids).toEqual(['o2', 'o3']);
    expect(overview.people).toMatchObject({ count: 1, complete: true });
    expect(overview.projects.count).toBe(0);
  } finally { f.db.close(); }
});

it('preserves loaded counts but not exact totals when a relation page remains', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op) => op === 'company_relations'
      ? { items: [{ relation_id: 'a', source_id: 'p1', target_id: 'o1', relation_type: 'worksFor' }],
        total: null, next_offset: 1, complete: false }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const overview = await f.service.overview(CODE);
    expect(overview.people).toMatchObject({ count: null, loaded_count: 1, complete: false });
  } finally { f.db.close(); }
});

it('counts only projects linked through clientOrganization and their members', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op) => op === 'company_relations'
      ? { items: [
        { relation_id: 'a', source_id: 'project1', target_id: 'o1', relation_type: 'clientOrganization' },
        { relation_id: 'b', source_id: 'p1', target_id: 'project1', relation_type: 'memberOf' },
        { relation_id: 'c', source_id: 'p2', target_id: 'unrelated-project', relation_type: 'memberOf' },
        { relation_id: 'd', source_id: 'p3', target_id: 'o2', relation_type: 'worksFor' },
        { relation_id: 'e', source_id: 'p4', target_id: 'o1', relation_type: 'family' },
      ], total: null, next_offset: null, complete: true }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const overview = await f.service.overview(CODE);
    expect(overview.projects.count).toBe(1);
    expect(overview.people.count).toBe(1);
  } finally { f.db.close(); }
});

it('keeps reports available when graph fails', async () => {
  const f = createContextFixture();
  try {
    report(f, 'r1');
    f.request.mockRejectedValue(new Error('graph offline'));
    const overview = await f.service.overview(CODE);
    expect(overview.state).toBe('partial');
    expect(overview.reports?.count).toBe(1);
    expect(overview.people.count).toBeNull();
  } finally { f.db.close(); }
});

it('reports an exact zero when both empty reports and graph succeed', async () => {
  const f = createContextFixture();
  try {
    const overview = await f.service.overview(CODE);
    expect(overview.state).toBe('ok');
    expect(overview.reports).toEqual({ count: 0, latest: null });
    expect(overview.people).toMatchObject({ count: 0, complete: true });
  } finally { f.db.close(); }
});

it('keeps graph counts available when the report source fails', async () => {
  const f = createContextFixture();
  try {
    vi.spyOn(f.assessments, 'summariesByCreditCodes').mockImplementation(() => { throw new Error('report offline'); });
    const overview = await f.service.overview(CODE);
    expect(overview.state).toBe('partial');
    expect(overview.reports).toBeNull();
    expect(overview.people).toMatchObject({ count: 0, complete: true });
    expect(overview.warnings).toContain('REPORTS_UNAVAILABLE');
  } finally { f.db.close(); }
});

it('combines recent graph, profile and assessment records with a bounded scope', async () => {
  const f = createContextFixture();
  try {
    report(f, 'r1');
    f.request.mockImplementation(async (op) => op === 'company_recent_records'
      ? { items: [{ kind: 'entity', id: 'p1', entity_id: 'p1', recorded_at: AT, label: 'Person' }],
        total: null, next_offset: null, complete: true }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T00:00:00.000Z');
    expect(updates.scope).toEqual(expect.arrayContaining(['graph', 'profile', 'assessment']));
    expect(updates.items.map(item => item.kind)).toEqual(expect.arrayContaining(['entity', 'profile', 'assessment']));
    expect(updates.truncated).toBe(false);
    expect(JSON.stringify(updates)).not.toContain('PRIVATE BODY');
  } finally { f.db.close(); }
});

it('does not invent an entity id for a graph record missing attribution', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op) => op === 'company_recent_records'
      ? { items: [{ kind: 'relation', id: 'r1', recorded_at: AT, label: 'worksFor' }],
        total: null, next_offset: null, complete: true }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T00:00:00.000Z');
    expect(updates.state).toBe('partial');
    expect(updates.truncated).toBe(true);
    expect(updates.items.some(item => item.id === 'r1')).toBe(false);
    expect(updates.warnings).toContain('GRAPH_RECORD_UNATTRIBUTED');
  } finally { f.db.close(); }
});

it('continues graph pages after invalid records to collect valid updates', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op, payload) => {
      if (op !== 'company_recent_records') return { items: [f.org], total: null, next_offset: null, complete: true };
      const offset = (payload as { offset: number }).offset;
      if (offset === 0) return { items: Array.from({ length: 20 }, (_, i) => ({
        kind: 'relation', id: `invalid-${i}`, recorded_at: AT, label: 'worksFor',
      })), total: null, next_offset: 20, complete: false };
      return { items: [{ kind: 'entity', id: 'valid', entity_id: 'p1', recorded_at: AT, label: 'Person' }],
        total: null, next_offset: null, complete: true };
    });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T00:00:00.000Z');
    expect(updates.items.some(item => item.id === 'valid')).toBe(true);
    expect(f.request.mock.calls.filter(([op]) => op === 'company_recent_records')
      .map(([, payload]) => (payload as { offset: number }).offset)).toEqual([0, 20]);
    expect(updates.state).toBe('partial');
    expect(updates.truncated).toBe(true);
  } finally { f.db.close(); }
});

it('stops recent graph pagination at the shared twenty-page budget', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op, payload) => op === 'company_recent_records'
      ? { items: [{ kind: 'relation', id: `invalid-${(payload as { offset: number }).offset}`,
        recorded_at: AT, label: 'worksFor' }], total: null,
        next_offset: (payload as { offset: number }).offset + 1, complete: false }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T00:00:00.000Z');
    expect(f.request.mock.calls.filter(([op]) => op === 'company_recent_records')).toHaveLength(20);
    expect(updates).toMatchObject({ state: 'partial', truncated: true });
    expect(updates.warnings).toContain('GRAPH_UPDATES_PAGE_LIMIT');
  } finally { f.db.close(); }
});

it('counts failed recent requests against the shared budget across organization batches', async () => {
  const f = createContextFixture();
  try {
    const organizations = new Map([[f.org.entity_id, f.org]]);
    for (let i = 2; i <= 1001; i++) {
      const org = { ...f.org, entity_id: `o${i}` };
      organizations.set(org.entity_id, org);
      f.links.write({ action: 'confirm', organization_id: org.entity_id, credit_code: CODE,
        operation_id: `fixture-${i}`, expected_link_version: 0, expected_organization_version: 1,
        note: '合成数据人工关联' }, 'test', identityHash(org), AT);
    }
    f.request.mockImplementation(async (op, payload) => {
      if (op === 'company_recent_records') throw new Error('temporary graph failure');
      const ids = (payload as { entity_ids: string[] }).entity_ids;
      return { items: ids.length ? ids.map(id => organizations.get(id)) : [f.org],
        total: null, next_offset: null, complete: true };
    });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T00:00:00.000Z');
    expect(f.request.mock.calls.filter(([op]) => op === 'company_recent_records')).toHaveLength(20);
    expect(updates).toMatchObject({ state: 'partial', truncated: true });
    expect(updates.warnings).toContain('GRAPH_UPDATES_PAGE_LIMIT');
    expect(updates.scope).not.toContain('graph');
  } finally { f.db.close(); }
});

it('sorts mixed RFC3339 offsets by actual time with stable ties', async () => {
  const f = createContextFixture();
  try {
    f.request.mockImplementation(async (op) => op === 'company_recent_records'
      ? { items: [
        { kind: 'entity', id: 'earlier', entity_id: 'p1', recorded_at: '2026-10-12T00:30:00+01:00', label: 'Person' },
        { kind: 'entity', id: 'later', entity_id: 'p2', recorded_at: '2026-10-11T23:45:00Z', label: 'Person' },
        { kind: 'evidence', id: 'tie', entity_id: 'p3', recorded_at: '2026-10-11T23:45:00+00:00', label: '职业身份依据' },
      ], total: null, next_offset: null, complete: true }
      : { items: [f.org], total: null, next_offset: null, complete: true });
    const updates = await f.service.relatedUpdates(CODE, '2026-10-11T23:00:00Z');
    expect(updates.items.filter(item => ['tie', 'later', 'earlier'].includes(item.id))
      .map(item => item.id)).toEqual(['later', 'tie', 'earlier']);
  } finally { f.db.close(); }
});

it('propagates cancellation before requesting a second graph page', async () => {
  const f = createContextFixture(), controller = new AbortController();
  try {
    f.request.mockImplementation(async (_op, _payload, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('stop'));
      return { items: [f.org], total: 2, next_offset: 1, complete: false };
    });
    await expect(f.service.overview(CODE, controller.signal)).rejects.toThrow('stop');
    expect(f.request).toHaveBeenCalledTimes(1);
  } finally { f.db.close(); }
});
