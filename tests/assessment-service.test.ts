import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssessmentResultAudit } from '../src/contracts/index.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { initializeDatabase } from '../src/db/database.js';
import { AssessmentService } from '../src/orchestration/assessment-service.js';
import { AssessmentQueue } from '../src/orchestration/fifo-queue.js';

const COMPANY = {
  requestedBy: 'sales-1',
  legalName: '示例机器人有限公司',
  creditCode: '91110000123456789A',
};
const SOURCE_STATUS = { qcc: 'completed', doubaoSearch: 'completed', ark: 'completed' } as const;
const MARKDOWN = '# 目标客户体检报告\n\n> 信息采集时间：2026-08-01T00:00:00.000Z\n\n## 证据缺口\n\n- 待核实';
const PRODUCT_KEYS = [
  'windchill', 'feigenbaum_qms', 'creo', 'catia', 'abaqus', 'cst', 'solidworks',
] as const;
const RESULT_AUDIT: AssessmentResultAudit = {
  industryLabel: null,
  industryEvidenceIds: [],
  evidenceSelection: {
    selectedEvidenceIds: [], originalCount: 0, selectedCount: 0, excludedCount: 0,
    categoryCounts: { industry: 0, technology: 0, timing: 0, capacity: 0 },
    researchBytes: 0, requestBytes: 0,
  },
  opportunities: PRODUCT_KEYS.map(product => ({ product, level: '待核实' as const, evidenceIds: [] })),
};

describe('AssessmentService', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { databases.splice(0).forEach(database => database.close()); });

  function setup(now: () => Date) {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(database);
    const assessments = new AssessmentRepository(database);
    const enqueued: string[] = [];
    const service = new AssessmentService({
      assessments,
      queue: { enqueue: id => { enqueued.push(id); return true; } },
      assessmentCacheTtlDays: 30,
      now,
    });
    return { database, assessments, service, enqueued };
  }

  it('rejects new submissions after the shared shutdown signal is aborted without creating work', () => {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(database);
    const controller = new AbortController();
    const service = new AssessmentService({
      assessments: new AssessmentRepository(database),
      queue: { enqueue: () => { throw new Error('must not enqueue'); } },
      assessmentCacheTtlDays: 30,
      signal: controller.signal,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    controller.abort();

    expect(() => service.submit({
      legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: false,
    }, COMPANY.requestedBy)).toThrow(/shutting down/i);
    const count = database.prepare('SELECT COUNT(*) AS count FROM assessments').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('marks a newly persisted task failed when queue shutdown races with submit', () => {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(database);
    const service = new AssessmentService({
      assessments: new AssessmentRepository(database),
      queue: { enqueue: () => { throw new Error('Assessment queue is not accepting new work'); } },
      assessmentCacheTtlDays: 30,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });

    expect(() => service.submit({
      legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: false,
    }, COMPANY.requestedBy)).toThrow(/not accepting/i);
    const row = database.prepare('SELECT status FROM assessments').get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('keeps waiting and duplicate submissions processing and enqueues one UUID', async () => {
    const { service, enqueued } = setup(() => new Date('2026-08-30T00:00:00.000Z'));
    const input = { legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: false };
    const first = await service.submit(input, COMPANY.requestedBy);
    const duplicate = await service.submit(input, 'sales-2');

    expect(first).toMatchObject({ status: 'processing', cacheHit: false, estimatedMinutes: '5-10' });
    expect(duplicate).toEqual(first);
    expect(enqueued).toEqual([first.assessmentId]);
    expect(await service.status({ assessmentId: first.assessmentId })).toMatchObject({ status: 'processing' });
  });

  it('returns a completed cache hit whose cachedAt is completedAt and TTL ignores createdAt', async () => {
    let current = new Date('2026-05-01T00:00:00.000Z');
    const { assessments, service, enqueued } = setup(() => current);
    const created = assessments.createOrReuseAssessment(COMPANY, false, current, 30).record;
    current = new Date('2026-08-29T00:00:00.000Z');
    const completed = assessments.completeAssessment(created.assessmentId, {
      reportMarkdown: MARKDOWN,
      recommendedProduct: null,
      overallOpportunity: '待核实',
      sourceStatus: SOURCE_STATUS,
      collectedAt: '2026-08-29T00:00:00.000Z',
      resultAudit: RESULT_AUDIT,
    }, current);
    current = new Date('2026-08-30T00:00:00.000Z');

    expect(service.submit({
      legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: false,
    }, 'sales-2')).toEqual({
      assessmentId: completed.assessmentId,
      status: 'completed',
      cacheHit: true,
      cachedAt: completed.completedAt,
    });
    expect(enqueued).toEqual([]);
  });

  it('uses presentStoredReport at exactly and after seven days without persisting duplicate warnings', async () => {
    let current = new Date('2026-08-01T00:00:00.000Z');
    const { assessments, service } = setup(() => current);
    const created = assessments.createOrReuseAssessment(COMPANY, false, current, 30).record;
    assessments.completeAssessment(created.assessmentId, {
      reportMarkdown: MARKDOWN,
      recommendedProduct: null,
      overallOpportunity: '待核实',
      sourceStatus: SOURCE_STATUS,
      collectedAt: current.toISOString(),
      resultAudit: RESULT_AUDIT,
    }, current);

    current = new Date('2026-08-08T00:00:00.000Z');
    const exact = await service.report({ assessmentId: created.assessmentId });
    expect(exact).toMatchObject({ status: 'completed', dynamicSignalFreshness: 'current' });
    expect(exact.status === 'completed' ? exact.markdown : '').not.toContain('动态信号已超过 7 天');

    current = new Date('2026-08-08T00:00:00.001Z');
    const stale = await service.report({ assessmentId: created.assessmentId });
    const repeated = await service.report({ assessmentId: created.assessmentId });
    for (const output of [stale, repeated]) {
      expect(output).toMatchObject({ status: 'completed', dynamicSignalFreshness: 'stale' });
      const markdown = output.status === 'completed' ? output.markdown : '';
      expect(markdown.match(/动态信号已超过 7 天/g)).toHaveLength(1);
    }
    expect(assessments.get(created.assessmentId)?.reportMarkdown).toBe(MARKDOWN);
  });

  it('force refreshes completed work, reuses processing work, and resubmits failed work', async () => {
    let current = new Date('2026-08-01T00:00:00.000Z');
    const { assessments, service } = setup(() => current);
    const completed = assessments.createOrReuseAssessment(COMPANY, false, current, 30).record;
    assessments.completeAssessment(completed.assessmentId, {
      reportMarkdown: MARKDOWN, recommendedProduct: null, overallOpportunity: '待核实',
      sourceStatus: SOURCE_STATUS, collectedAt: current.toISOString(),
      resultAudit: RESULT_AUDIT,
    }, current);
    current = new Date('2026-08-02T00:00:00.000Z');

    const forced = await service.submit({
      legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: true,
    }, 'sales-2');
    const reused = await service.submit({
      legalName: COMPANY.legalName, creditCode: COMPANY.creditCode, forceRefresh: true,
    }, 'sales-3');
    expect(forced.status).toBe('processing');
    expect(reused).toEqual(forced);

    assessments.failAssessment(forced.assessmentId, 'upstream failed', current);
    const failedCompany = {
      legalName: '失败任务示例有限公司',
      creditCode: '91110000123456789B',
      forceRefresh: false,
    };
    const failed = await service.submit(failedCompany, 'sales-4');
    assessments.failAssessment(failed.assessmentId, 'upstream failed', current);
    const resubmitted = await service.submit({
      ...failedCompany,
    }, 'sales-4');
    expect(resubmitted.status).toBe('processing');
    expect(resubmitted.assessmentId).not.toBe(failed.assessmentId);
  });

  it('marks startup-interrupted processing tasks failed', () => {
    const current = new Date('2026-08-30T00:00:00.000Z');
    const { assessments, service } = setup(() => current);
    const task = assessments.createOrReuseAssessment(COMPANY, false, current, 30).record;
    expect(service.failInterruptedAssessments()).toBe(1);
    expect(assessments.get(task.assessmentId)).toMatchObject({
      status: 'failed', errorMessage: 'Assessment interrupted by service restart',
    });
  });

  it('keeps a database-backed waiting queue item processing without starting it', async () => {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(database);
    const assessments = new AssessmentRepository(database);
    let releaseActive!: () => void;
    const active = new Promise<void>(resolve => { releaseActive = resolve; });
    const started: string[] = [];
    const queue = new AssessmentQueue(async assessmentId => {
      started.push(assessmentId);
      await active;
    }, 1);
    const service = new AssessmentService({
      assessments,
      queue,
      assessmentCacheTtlDays: 30,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const first = service.submit({
      legalName: '甲公司', creditCode: '91110000123456789C', forceRefresh: false,
    }, 'sales-1');
    const waiting = service.submit({
      legalName: '乙公司', creditCode: '91110000123456789D', forceRefresh: false,
    }, 'sales-1');
    queue.start();
    for (let index = 0; index < 20 && started.length === 0; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    expect(started).toEqual([first.assessmentId]);
    expect(service.status({ assessmentId: waiting.assessmentId }).status).toBe('processing');
    queue.stopAccepting();
    releaseActive();
    await queue.waitForActive();
    expect(started).toEqual([first.assessmentId]);
    expect(assessments.get(waiting.assessmentId)?.status).toBe('processing');
  });
});
