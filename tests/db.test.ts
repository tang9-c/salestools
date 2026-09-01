import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import {
  AssessmentNotFoundError,
  AssessmentRepository,
  InvalidAssessmentTransitionError,
} from '../src/db/assessment-repository.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { TokenRepository } from '../src/db/token-repository.js';

const now = new Date('2026-08-29T12:00:00.000Z');
const identity = {
  legalName: '测试制造有限公司', creditCode: '91310000TEST000001', formerNames: [], aliases: [],
  englishNames: [], brands: [], officialDomains: [], registeredAddress: null, parentLegalName: null, subsidiaryLegalNames: [],
};
const basicProfile = {
  industry: null, region: null, company_type: null, founded_year: null, registered_capital: null,
  legal_representative: null, website: null, employee_range: null, risk_summary: null,
  collected_at: now.toISOString(),
};
const assessmentInput = { requestedBy: 'user-1', legalName: identity.legalName, creditCode: identity.creditCode };
const resultAudit = {
  industryClassification: 'P1' as const,
  industryEvidenceIds: ['qcc-profile'],
  evidenceSelection: {
    selectedEvidenceIds: ['qcc-profile', 'doubao_search-web'],
    originalCount: 3,
    selectedCount: 2,
    excludedCount: 1,
    categoryCounts: { industry: 1, technology: 1, timing: 0, capacity: 0 },
    researchBytes: 2_048,
    requestBytes: 4_096,
  },
  opportunities: [
    { product: 'windchill' as const, level: '高' as const, evidenceIds: ['qcc-profile'] },
    { product: 'feigenbaum_qms' as const, level: '中' as const, evidenceIds: ['qcc-profile'] },
    { product: 'creo' as const, level: '低' as const, evidenceIds: [] },
    { product: 'catia' as const, level: '待核实' as const, evidenceIds: [] },
    { product: 'abaqus' as const, level: '待核实' as const, evidenceIds: [] },
    { product: 'cst' as const, level: '待核实' as const, evidenceIds: [] },
    { product: 'solidworks' as const, level: '待核实' as const, evidenceIds: [] },
  ],
};
const completedResult = {
  reportMarkdown: '# 报告',
  recommendedProduct: null,
  overallOpportunity: '中' as const,
  sourceStatus: { qcc: 'completed' as const, doubaoSearch: 'partial' as const, ark: 'completed' as const },
  collectedAt: now.toISOString(),
  resultAudit,
};

describe('SQLite repositories', () => {
  let directory: string;
  let path: string;
  let db: DatabaseSync;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'target-customer-db-'));
    path = join(directory, 'service.sqlite');
    db = openDatabase(path);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('initializes WAL, busy timeout, tables, and processing uniqueness', () => {
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['tokens', 'company_profiles', 'assessments']));
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map(row => (row as { name: string }).name);
    expect(indexes).toContain('one_processing_per_company');
  });

  it('idempotently migrates a legacy assessments table and round-trips a compact result audit', () => {
    const legacyPath = join(directory, 'legacy.sqlite');
    const legacyAssessmentId = '10bd94c4-724a-4ca9-87fb-f474f563d475';
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE assessments (
        assessment_id TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        legal_name TEXT NOT NULL,
        credit_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        report_markdown TEXT,
        recommended_product TEXT,
        overall_opportunity TEXT,
        source_status_json TEXT,
        collected_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        cached_at TEXT,
        failed_at TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO assessments (
        assessment_id, cache_key, requested_by, legal_name, credit_code, status,
        report_markdown, recommended_product, overall_opportunity, source_status_json,
        collected_at, created_at, completed_at, cached_at
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyAssessmentId,
      assessmentInput.creditCode,
      assessmentInput.requestedBy,
      assessmentInput.legalName,
      assessmentInput.creditCode,
      '# 旧版报告',
      '中',
      JSON.stringify(completedResult.sourceStatus),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    legacy.close();

    const migrated = openDatabase(legacyPath);
    expect(migrated.prepare('PRAGMA table_info(assessments)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'result_json', type: 'TEXT' })]));
    const assessments = new AssessmentRepository(migrated);
    expect(assessments.get(legacyAssessmentId)).toMatchObject({
      assessmentId: legacyAssessmentId,
      status: 'completed',
      reportMarkdown: '# 旧版报告',
      resultAudit: null,
    });
    expect(assessments.createOrReuseAssessment(assessmentInput, false, now, 30)).toMatchObject({
      created: false,
      cacheHit: true,
      record: { assessmentId: legacyAssessmentId, resultAudit: null },
    });

    const created = assessments.createOrReuseAssessment(assessmentInput, true, now, 30);
    const completed = assessments.completeAssessment(created.record.assessmentId, completedResult, now);

    expect(completed.resultAudit).toEqual(resultAudit);
    const stored = migrated.prepare('SELECT result_json FROM assessments WHERE assessment_id = ?')
      .get(created.record.assessmentId) as { result_json: string };
    expect(JSON.parse(stored.result_json)).toEqual(resultAudit);
    expect(stored.result_json).not.toMatch(/summary|content|raw|response|reportMarkdown/iu);
    migrated.close();

    expect(() => openDatabase(legacyPath).close()).not.toThrow();
  });

  it('stores token hashes but only lists safe metadata', () => {
    const tokens = new TokenRepository(db);
    tokens.insert({ userId: 'user-1', tokenHash: 'secret-hash', enabled: true, createdAt: now.toISOString() });
    expect(tokens.findByHash('secret-hash')).toMatchObject({ userId: 'user-1', tokenHash: 'secret-hash', enabled: true });
    expect(tokens.list()).toEqual([{ userId: 'user-1', enabled: true, createdAt: now.toISOString() }]);
    expect(tokens.disableByUserId('user-1')).toBe(1);
    expect(tokens.findByHash('secret-hash')?.enabled).toBe(false);
  });

  it('finds profiles by credit code or ordinary normalized-name index until TTL expires', () => {
    const profiles = new ProfileRepository(db);
    profiles.upsert({ identity, normalizedLegalName: '测试制造有限公司', basicProfile, collectedAt: now.toISOString() });
    expect(profiles.findFreshByCreditCode(identity.creditCode, now, 30)?.identity).toEqual(identity);
    expect(profiles.findFreshByNormalizedName('测试制造有限公司', now, 30)).toHaveLength(1);
    const expired = new Date('2026-09-29T12:00:00.001Z');
    expect(profiles.findFreshByCreditCode(identity.creditCode, expired, 30)).toBeNull();
    expect(profiles.findFreshByNormalizedName('测试制造有限公司', expired, 30)).toEqual([]);
  });

  it('reuses one processing assessment per credit code', () => {
    const assessments = new AssessmentRepository(db);
    const first = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const second = assessments.createOrReuseAssessment({ ...assessmentInput, requestedBy: 'user-2' }, false, now, 30);
    expect(second.record.assessmentId).toBe(first.record.assessmentId);
    expect(second).toMatchObject({ cacheHit: false, cachedAt: null, record: { status: 'processing' } });
    expect(db.prepare("SELECT count(*) AS count FROM assessments WHERE status='processing'").get()).toEqual({ count: 1 });
  });

  it('reuses processing work even when force refresh is true', () => {
    const assessments = new AssessmentRepository(db);
    const first = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const forced = assessments.createOrReuseAssessment(assessmentInput, true, now, 30);
    expect(forced.record.assessmentId).toBe(first.record.assessmentId);
    expect(forced).toMatchObject({ cacheHit: false, cachedAt: null, record: { status: 'processing' } });
  });

  it('reuses fresh completed cache using completedAt, and force refresh bypasses it', () => {
    const assessments = new AssessmentRepository(db);
    const created = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const completedAt = new Date('2026-08-30T12:00:00.000Z');
    const completed = assessments.completeAssessment(created.record.assessmentId, completedResult, completedAt);
    expect(completed.completedAt).toBe(completedAt.toISOString());
    expect(completed.cachedAt).toBe(completedAt.toISOString());

    const reused = assessments.createOrReuseAssessment(
      assessmentInput,
      false,
      new Date('2026-09-29T12:00:00.000Z'),
      30,
    );
    expect(reused).toMatchObject({
      cacheHit: true,
      cachedAt: completedAt.toISOString(),
      record: { assessmentId: created.record.assessmentId, status: 'completed' },
    });

    const refreshed = assessments.createOrReuseAssessment(
      assessmentInput,
      true,
      new Date('2026-09-29T12:00:00.000Z'),
      30,
    );
    expect(refreshed.record.assessmentId).not.toBe(created.record.assessmentId);
    expect(refreshed.cacheHit).toBe(false);
  });

  it('calculates completed cache freshness from completedAt, not createdAt or collectedAt', () => {
    const assessments = new AssessmentRepository(db);
    const veryOldCreatedAt = new Date('2020-01-01T00:00:00.000Z');
    const created = assessments.createOrReuseAssessment(assessmentInput, false, veryOldCreatedAt, 30);
    const completedAt = new Date('2026-08-29T12:00:00.000Z');
    assessments.completeAssessment(created.record.assessmentId, {
      ...completedResult,
      collectedAt: '2020-01-01T00:00:00.000Z',
    }, completedAt);

    const reused = assessments.createOrReuseAssessment(
      assessmentInput,
      false,
      new Date('2026-09-28T12:00:00.000Z'),
      30,
    );
    expect(reused.cacheHit).toBe(true);
    expect(reused.cachedAt).toBe(completedAt.toISOString());
  });

  it('does not reuse failed work and converts interrupted work to failed on restart', () => {
    const assessments = new AssessmentRepository(db);
    const failed = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    assessments.failAssessment(failed.record.assessmentId, '上游失败', now);
    const retried = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    expect(retried.record.assessmentId).not.toBe(failed.record.assessmentId);

    db.close();
    db = openDatabase(path);
    const restarted = new AssessmentRepository(db);
    expect(restarted.failInterruptedAssessments(new Date('2026-08-29T12:01:00.000Z'))).toBe(1);
    expect(restarted.get(retried.record.assessmentId)).toMatchObject({
      status: 'failed',
      errorMessage: 'Assessment interrupted by service restart',
    });
  });

  it('rejects completing a failed assessment and preserves the failed terminal state', () => {
    const assessments = new AssessmentRepository(db);
    const created = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const failed = assessments.failAssessment(created.record.assessmentId, '上游失败', now);

    expect(() => assessments.completeAssessment(created.record.assessmentId, completedResult, now))
      .toThrow(InvalidAssessmentTransitionError);
    expect(assessments.get(created.record.assessmentId)).toEqual(failed);
  });

  it('rejects failing a completed assessment and preserves its report and timestamps', () => {
    const assessments = new AssessmentRepository(db);
    const created = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const completed = assessments.completeAssessment(created.record.assessmentId, completedResult, now);

    expect(() => assessments.failAssessment(created.record.assessmentId, '迟到失败', new Date('2026-08-30T00:00:00.000Z')))
      .toThrow(InvalidAssessmentTransitionError);
    expect(assessments.get(created.record.assessmentId)).toEqual(completed);
  });

  it('rejects completing an assessment a second time', () => {
    const assessments = new AssessmentRepository(db);
    const created = assessments.createOrReuseAssessment(assessmentInput, false, now, 30);
    const completed = assessments.completeAssessment(created.record.assessmentId, completedResult, now);

    expect(() => assessments.completeAssessment(
      created.record.assessmentId,
      { ...completedResult, reportMarkdown: '# 被覆盖' },
      new Date('2026-08-30T00:00:00.000Z'),
    )).toThrow(InvalidAssessmentTransitionError);
    expect(assessments.get(created.record.assessmentId)).toEqual(completed);
  });

  it('distinguishes a missing assessment from an invalid terminal transition', () => {
    const assessments = new AssessmentRepository(db);
    expect(() => assessments.failAssessment(
      '10bd94c4-724a-4ca9-87fb-f474f563d475',
      '不存在',
      now,
    )).toThrow(AssessmentNotFoundError);
  });
});
