import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EvidenceBundle,
  IdentityProfile,
  ResearchBundle,
  ResearchItem,
} from '../src/contracts/index.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { JsonlLogger } from '../src/logging/logger.js';
import { AssessmentRunner, AssessmentWorkerError } from '../src/orchestration/assessment-runner.js';
import { retryOnce, UpstreamError } from '../src/orchestration/retry.js';
import { ArkEvidenceService } from '../src/upstream/ark/client.js';
import { QccResearchCollector, type SourceCollection } from '../src/upstream/qcc/assessment-research.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const IDENTITY: IdentityProfile = {
  legalName: '示例机器人有限公司',
  creditCode: '91110000123456789A',
  formerNames: [], aliases: ['示例机器人'], englishNames: [], brands: [],
  officialDomains: ['example.cn'], registeredAddress: '北京市海淀区',
  parentLegalName: null, subsidiaryLegalNames: [],
};

function item(source: 'qcc' | 'doubao_search', suffix: string): ResearchItem {
  return {
    evidenceId: `${source}-${suffix}`,
    source,
    sourceKind: source === 'qcc' ? 'company' : 'web',
    title: '企业产品与研发信息',
    url: `https://${source === 'qcc' ? 'qcc.com' : 'example.cn'}/${suffix}`,
    originalPublisher: source === 'qcc' ? '企业官网' : '示例机器人官网',
    originalDomain: 'example.cn',
    summary: '示例机器人有限公司从事机器人研发', content: null,
    publishedAt: null, collectedAt: NOW.toISOString(), mentionedName: IDENTITY.legalName,
    entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['法定名称一致'],
    query: source === 'qcc' ? null : '示例机器人 研发', position: source === 'qcc' ? null : 1,
    logId: null,
  };
}

function collection(status: SourceCollection['sourceStatus']['status'], items: ResearchItem[] = []): SourceCollection {
  return {
    items,
    sourceStatus: { status, error: status === 'failed' ? 'source unavailable' : null },
    gaps: status === 'failed' ? ['来源信息获取失败'] : [],
  };
}

function evidence(bundle: ResearchBundle): EvidenceBundle {
  return {
    identity: bundle.identity,
    industryClassification: 'unverified',
    industryEvidenceIds: [],
    evidence: [], facts: [], financingRecords: [], conflicts: [],
    gaps: [...bundle.gaps, ...(bundle.items.length === 0 ? ['未获得可用证据，不能形成销售判断'] : ['产品技术场景待核实'])],
    collectedAt: bundle.collectedAt,
  };
}

describe('AssessmentRunner', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { databases.splice(0).forEach(database => database.close()); });

  function setup(overrides: Record<string, unknown> = {}) {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(database);
    const assessments = new AssessmentRepository(database);
    const profiles = new ProfileRepository(database);
    profiles.upsert({
      identity: IDENTITY,
      normalizedLegalName: IDENTITY.legalName,
      basicProfile: {
        industry: '机器人', region: '北京', company_type: '有限公司', founded_year: 2020,
        registered_capital: null, legal_representative: null, website: 'https://example.cn',
        employee_range: null, risk_summary: null, collected_at: NOW.toISOString(),
      },
      collectedAt: NOW.toISOString(),
    });
    const task = assessments.createOrReuseAssessment({
      requestedBy: 'sales-1', legalName: IDENTITY.legalName, creditCode: IDENTITY.creditCode,
    }, false, NOW, 30).record;
    const qccResearch = {
      collectQccResearch: vi.fn(async () => collection('completed', [item('qcc', 'profile')])),
    };
    const searchClient = { search: vi.fn(async () => [item('doubao_search', 'web')]) };
    const ark = { extract: vi.fn(async (bundle: ResearchBundle) => evidence(bundle)) };
    const logger = new JsonlLogger({ write: () => undefined }, () => NOW);
    const dependencies = {
      assessments,
      profiles,
      qccResearch,
      searchClient,
      ark,
      logger,
      profileCacheTtlDays: 30,
      budgetLimits: { qcc: 8, doubaoSearch: 8, ark: 2, total: 18 },
      now: () => NOW,
      ...overrides,
    };
    return { database, assessments, profiles, task, qccResearch, searchClient, ark, dependencies };
  }

  it.each([
    ['QCC-only failure', collection('failed'), false, 'failed', 'completed'],
    ['search-only failure', collection('completed', [item('qcc', 'profile')]), true, 'completed', 'failed'],
  ] as const)('completes a degraded report for %s', async (_name, qccResult, failSearch, qccStatus, searchStatus) => {
    const runtime = setup();
    runtime.dependencies.qccResearch = { collectQccResearch: vi.fn(async () => qccResult) };
    runtime.dependencies.searchClient = {
      search: vi.fn(async () => {
        if (failSearch) throw new UpstreamError('doubao_search', 'UNAVAILABLE', 'search failed');
        return [item('doubao_search', 'web')];
      }),
    };
    const runner = new AssessmentRunner(runtime.dependencies);

    await runner.run(runtime.task.assessmentId);

    expect(runtime.assessments.get(runtime.task.assessmentId)).toMatchObject({
      status: 'completed',
      sourceStatus: { qcc: qccStatus, doubaoSearch: searchStatus, ark: 'completed' },
      overallOpportunity: '待核实',
      recommendedProduct: null,
    });
  });

  it('passes an empty bundle to Ark and completes a gaps-only report when both research sources fail', async () => {
    const runtime = setup({
      qccResearch: { collectQccResearch: vi.fn(async () => collection('failed')) },
      searchClient: { search: vi.fn(async () => { throw new UpstreamError('doubao_search', 'DOWN', 'down'); }) },
      budgetLimits: { qcc: 8, doubaoSearch: 2, ark: 2, total: 12 },
    });
    const ark = { extract: vi.fn(async (bundle: ResearchBundle) => {
      expect(bundle.items).toEqual([]);
      expect(bundle.sourceStatus.qcc.status).toBe('failed');
      expect(bundle.sourceStatus.doubaoSearch.status).toBe('failed');
      return evidence(bundle);
    }) };
    runtime.dependencies.ark = ark;

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    const stored = runtime.assessments.get(runtime.task.assessmentId)!;
    expect(stored).toMatchObject({ status: 'completed', overallOpportunity: '待核实', recommendedProduct: null });
    expect(stored.reportMarkdown).toContain('未获得可用证据，不能形成销售判断');
    expect(stored.reportMarkdown).not.toMatch(/Windchill|CATIA|Abaqus|SolidWorks/);
  });

  it('retains financing, annual-report, and Ark input-budget gaps in the final report', async () => {
    const financingGap = '融资结果无法结构化验证（适配器契约缺口）';
    const annualReportGap = '年报信息获取失败';
    const budgetGap = '方舟输入受网关容量限制，仅选取4条代表证据，未选数据不代表不存在';
    const qccItems = [
      item('qcc', 'company-get_company_profile-1'),
      item('qcc', 'operation-get_recruitment_info-1'),
      { ...item('qcc', 'risk-get_company_risk_scan-1'), sourceKind: 'risk' as const },
    ];
    let searchIndex = 0;
    const model: EvidenceBundle = {
      identity: IDENTITY,
      industryClassification: 'unverified',
      industryEvidenceIds: [],
      evidence: [],
      facts: [],
      financingRecords: [],
      conflicts: [],
      gaps: [],
      collectedAt: NOW.toISOString(),
    };
    const runtime = setup({
      qccResearch: {
        collectQccResearch: vi.fn(async (): Promise<SourceCollection> => ({
          items: qccItems,
          sourceStatus: { status: 'partial', error: null },
          gaps: [financingGap, annualReportGap],
        })),
      },
      searchClient: {
        search: vi.fn(async (query: { Query: string }) => [{
          ...item('doubao_search', `web-${searchIndex += 1}`),
          query: query.Query,
        }]),
      },
      ark: new ArkEvidenceService({
        url: 'https://ark.example/v1/chat/completions',
        model: 'test-model',
        credential: 'test-credential',
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(model) } }],
        }), { status: 200 })),
      }),
    });

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    const markdown = runtime.assessments.get(runtime.task.assessmentId)?.reportMarkdown ?? '';
    expect(markdown).toContain(financingGap);
    expect(markdown).toContain(annualReportGap);
    expect(markdown).toContain(budgetGap);
  });

  it('does not start the search client when the search budget is exhausted', async () => {
    const runtime = setup({ budgetLimits: { qcc: 8, doubaoSearch: 0, ark: 2, total: 10 } });
    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);
    expect(runtime.searchClient.search).not.toHaveBeenCalled();
    expect(runtime.assessments.get(runtime.task.assessmentId)).toMatchObject({
      status: 'completed', sourceStatus: { doubaoSearch: 'failed' },
    });
  });

  it('attempts each failed search request at most twice', async () => {
    const searchClient = {
      search: vi.fn(async () => { throw new UpstreamError('doubao_search', 'DOWN', 'down'); }),
    };
    const runtime = setup({
      searchClient,
      budgetLimits: { qcc: 8, doubaoSearch: 2, ark: 2, total: 12 },
    });
    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);
    expect(searchClient.search).toHaveBeenCalledTimes(2);
  });

  it('retries Ark exactly once, fails the task, and never builds or persists a report', async () => {
    const ark = {
      extract: vi.fn(async () => { throw new UpstreamError('ark', 'DOWN', 'ark down'); }),
    };
    const reportModelBuilder = vi.fn(() => { throw new Error('must not be called'); });
    const runtime = setup({ ark, reportModelBuilder });

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    expect(ark.extract).toHaveBeenCalledTimes(2);
    expect(reportModelBuilder).not.toHaveBeenCalled();
    expect(runtime.assessments.get(runtime.task.assessmentId)).toMatchObject({
      status: 'failed', reportMarkdown: null, errorMessage: '模型事实整理不可用',
    });
  });

  it('marks the task failed without Markdown when atomic SQLite completion fails', async () => {
    const runtime = setup();
    const failingAssessments = {
      get: runtime.assessments.get.bind(runtime.assessments),
      completeAssessment: vi.fn(() => { throw new Error('disk full'); }),
      failAssessment: runtime.assessments.failAssessment.bind(runtime.assessments),
    };
    await new AssessmentRunner({ ...runtime.dependencies, assessments: failingAssessments })
      .run(runtime.task.assessmentId);

    expect(failingAssessments.completeAssessment).toHaveBeenCalledTimes(1);
    expect(runtime.assessments.get(runtime.task.assessmentId)).toMatchObject({
      status: 'failed', reportMarkdown: null,
    });
  });

  it('converts an unexpected orchestration contract error into failed instead of leaving processing stuck', async () => {
    const runtime = setup({
      qccResearch: {
        collectQccResearch: vi.fn(async () => ({
          items: [{ unexpected: 'raw payload' }],
          sourceStatus: { status: 'completed', error: null },
          gaps: [],
        })),
      },
      budgetLimits: { qcc: 8, doubaoSearch: 0, ark: 2, total: 10 },
    });

    await expect(new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId)).resolves.toBeUndefined();
    expect(runtime.assessments.get(runtime.task.assessmentId)).toMatchObject({
      status: 'failed', reportMarkdown: null, errorMessage: '体检任务处理失败',
    });
  });

  it('logs every real QCC attempt while the collector retains sole retry ownership', async () => {
    const lines: string[] = [];
    const gateway = {
      call: vi.fn(async () => { throw new UpstreamError('qcc', 'DOWN', 'qcc down'); }),
    };
    const qccResearch = new QccResearchCollector(gateway, () => NOW);
    const runtime = setup({
      qccResearch,
      logger: new JsonlLogger({ write: line => lines.push(line) }, () => NOW),
      budgetLimits: { qcc: 4, doubaoSearch: 0, ark: 1, total: 5 },
    });

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    expect(gateway.call).toHaveBeenCalledTimes(4);
    const qccLines = lines.map(line => JSON.parse(line)).filter(line => line.source === 'qcc');
    expect(qccLines).toHaveLength(4);
    expect(qccLines.map(line => line.attempt)).toEqual([1, 1, 2, 2]);
  });

  it('attempts to fail the assessment by UUID when the first repository read throws', async () => {
    const runtime = setup();
    const failAssessment = vi.fn(() => runtime.assessments.get(runtime.task.assessmentId)!);
    const assessments = {
      get: vi.fn(() => { throw new Error('sqlite path and raw state'); }),
      completeAssessment: runtime.assessments.completeAssessment.bind(runtime.assessments),
      failAssessment,
    };

    await new AssessmentRunner({ ...runtime.dependencies, assessments }).run(runtime.task.assessmentId);

    expect(failAssessment).toHaveBeenCalledWith(
      runtime.task.assessmentId,
      '体检任务处理失败',
      NOW,
    );
  });

  it('throws only a fixed worker error when both initial read and failure persistence throw', async () => {
    const runtime = setup();
    const assessments = {
      get: vi.fn(() => { throw new Error('sqlite secret path'); }),
      completeAssessment: runtime.assessments.completeAssessment.bind(runtime.assessments),
      failAssessment: vi.fn(() => { throw new Error('raw journal body'); }),
    };

    const failure = new AssessmentRunner({ ...runtime.dependencies, assessments }).run(runtime.task.assessmentId);
    await expect(failure).rejects.toMatchObject({
      name: 'AssessmentWorkerError',
      code: 'ASSESSMENT_STATE_UNAVAILABLE',
      message: 'Assessment worker state could not be persisted',
    } satisfies Partial<AssessmentWorkerError>);
  });

  it('preserves two total calls for an Ark retry when research shares a total limit of ten', async () => {
    let qccAttempts = 0;
    const qccResearch = {
      collectQccResearch: vi.fn(async (_identity, budget, retryOptions) => {
        while (budget.canConsume('qcc')) {
          await retryOnce('qcc', budget, async () => { qccAttempts += 1; }, retryOptions);
        }
        return collection('failed');
      }),
    };
    const searchClient = {
      search: vi.fn(async () => { throw new UpstreamError('doubao_search', 'DOWN', 'raw search body'); }),
    };
    let arkAttempts = 0;
    const ark = {
      extract: vi.fn(async (bundle: ResearchBundle) => {
        arkAttempts += 1;
        if (arkAttempts === 1) throw new UpstreamError('ark', 'NETWORK_ERROR', 'raw ark body');
        return evidence(bundle);
      }),
    };
    const runtime = setup({
      qccResearch,
      searchClient,
      ark,
      budgetLimits: { qcc: 8, doubaoSearch: 8, ark: 2, total: 10 },
    });

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    expect(qccAttempts + searchClient.search.mock.calls.length).toBe(8);
    expect(ark.extract).toHaveBeenCalledTimes(2);
    expect(qccAttempts + searchClient.search.mock.calls.length + arkAttempts).toBe(10);
    expect(runtime.assessments.get(runtime.task.assessmentId)?.status).toBe('completed');
  });

  it('passes only fixed source errors to Ark and the final Markdown', async () => {
    const rawQcc = 'token=qcc-secret raw_body=/private/qcc/path';
    const rawSearch = 'credential=search-secret response_body=customer-private-data';
    const arkInputs: ResearchBundle[] = [];
    const runtime = setup({
      qccResearch: {
        collectQccResearch: vi.fn(async () => { throw new UpstreamError('qcc', 'TRANSPORT', rawQcc); }),
      },
      searchClient: {
        search: vi.fn(async () => { throw new UpstreamError('doubao_search', 'NETWORK_ERROR', rawSearch); }),
      },
      ark: {
        extract: vi.fn(async (bundle: ResearchBundle) => {
          arkInputs.push(bundle);
          return evidence(bundle);
        }),
      },
      budgetLimits: { qcc: 4, doubaoSearch: 2, ark: 2, total: 8 },
    });

    await new AssessmentRunner(runtime.dependencies).run(runtime.task.assessmentId);

    const arkInput = arkInputs[0];
    const arkJson = JSON.stringify(arkInput);
    const markdown = runtime.assessments.get(runtime.task.assessmentId)?.reportMarkdown ?? '';
    for (const output of [arkJson, markdown]) {
      expect(output).not.toMatch(/qcc-secret|search-secret|customer-private-data|private\/qcc|raw_body|response_body/);
    }
    expect(arkInput?.sourceStatus).toEqual({
      qcc: { status: 'failed', error: 'QCC transport unavailable' },
      doubaoSearch: { status: 'failed', error: 'Doubao search network request failed' },
    });
    expect(markdown).toContain('企查查信息获取失败：QCC transport unavailable');
    expect(markdown).toContain('豆包搜索查询失败：official\\_products');
  });
});
