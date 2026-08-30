import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
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
const completedResult = {
  reportMarkdown: '# 报告',
  recommendedProduct: null,
  overallOpportunity: '中' as const,
  sourceStatus: { qcc: 'completed' as const, doubaoSearch: 'partial' as const, ark: 'completed' as const },
  collectedAt: now.toISOString(),
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
});
