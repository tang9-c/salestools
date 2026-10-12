import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CompanyQuestionService, type CompanyQuestionOptions } from '../src/orchestration/company-question-service.js';
import type { CompanyAnswerClaim, ResearchItem } from '../src/contracts/index.js';
import type { CompanyAnswerInput } from '../src/upstream/ark/company-answer.js';
import type { SearchQuery } from '../src/upstream/search/search-plan.js';

const NOW = new Date('2026-09-24T00:00:00.000Z');
const identity = {
  legalName: '测试装备有限公司', creditCode: '91310000123456789A', formerNames: [], aliases: ['测试装备'],
  englishNames: [], brands: [], officialDomains: [], registeredAddress: null,
  parentLegalName: null, subsidiaryLegalNames: [],
};
const baseProfile = {
  industry: null, region: null, company_type: null, founded_year: null,
  registered_capital: null, legal_representative: null, website: null,
  employee_range: null, risk_summary: null, collected_at: NOW.toISOString(),
};
const snapshotItem = {
  evidenceId: 'qcc-recruitment-1', source: 'qcc' as const, sourceKind: 'operation' as const,
  title: 'SolidWorks 工程师招聘', url: null, originalPublisher: '企查查', originalDomain: null,
  publishedAt: '2026-09-01T00:00:00.000Z', collectedAt: '2026-09-01T00:00:00.000Z',
  mentionedName: identity.legalName, entityScope: 'legal_entity' as const,
  entityMatch: 'confirmed' as const, matchBasis: ['信用代码查询'],
  excerpt: '岗位要求熟练使用 SolidWorks', excerptTruncated: false,
};
const snapshotFact = {
  factId: 'f1', statement: '招聘岗位要求 SolidWorks 技能', kind: 'recruitment' as const,
  productTags: ['solidworks' as const], strength: 'direct' as const,
  evidenceIds: [snapshotItem.evidenceId], entityScope: 'legal_entity' as const,
  entityMatch: 'confirmed' as const, matchBasis: ['信用代码查询'],
};
const resultAudit = {
  industryLabel: null, industryEvidenceIds: [], evidenceSelection: {
    selectedEvidenceIds: [], originalCount: 0, selectedCount: 0, excludedCount: 0,
    categoryCounts: { industry: 0, technology: 0, timing: 0, capacity: 0 },
    researchBytes: 0, requestBytes: 0, batchCount: 1, successfulBatchCount: 1,
    failedBatchCount: 0, processedCount: 0, unprocessedCount: 0, deduplicatedCount: 0,
  }, opportunities: (['windchill', 'feigenbaum_qms', 'creo', 'catia', 'abaqus', 'cst', 'solidworks'] as const)
    .map(product => ({ product, level: '待核实' as const, evidenceIds: [] })),
};

describe('CompanyQuestionService', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => databases.splice(0).forEach(db => db.close()));

  function setup(options: { profile?: boolean; snapshotAgeDays?: number; qccFails?: boolean; companyContext?: CompanyQuestionOptions['companyContext'] } = {}) {
    const db = initializeDatabase(new DatabaseSync(':memory:'));
    databases.push(db);
    const profiles = new ProfileRepository(db);
    if (options.profile !== false) profiles.upsert({
      identity, normalizedLegalName: identity.legalName,
      basicProfile: baseProfile, collectedAt: NOW.toISOString(),
    });
    const assessments = new AssessmentRepository(db);
    const collectedAt = new Date(NOW.getTime() - (options.snapshotAgeDays ?? 23) * 86_400_000).toISOString();
    const snapshot = { collectedAt, items: [{ ...snapshotItem, collectedAt }], facts: [snapshotFact] };
    const qccCall = vi.fn(async (): Promise<unknown> => {
      if (options.qccFails) throw new Error('QCC unavailable');
      return { Data: [] };
    });
    const qccClose = vi.fn(async () => undefined);
    const search = vi.fn(async (_query: SearchQuery, _signal?: AbortSignal): Promise<ResearchItem[]> => []);
    const answer = vi.fn(async (_input: CompanyAnswerInput): Promise<{
      claims: CompanyAnswerClaim[]; includedEvidenceIds?: string[]; includedContextRefs?: string[]; omittedCount?: number;
    }> => ({ claims: [{
      category: 'supported' as const, text: '该岗位要求 SolidWorks 技能，不能据此断定采购计划。',
      evidenceIds: ['qcc-recruitment-1'],
    }] }));
    const service = new CompanyQuestionService({
      profiles, assessments, companyContext: options.companyContext, profileTtlDays: 30, now: () => NOW,
      qccFactory: () => ({ call: qccCall, close: qccClose }),
      searchFactory: () => ({ search }),
      answerFactory: () => ({ answer }),
      requestTimeoutMs: 100,
    });
    const input = { legalName: identity.legalName, creditCode: identity.creditCode, question: '这条 SolidWorks 招聘支持什么结论？' };
    const complete = (ageDays = options.snapshotAgeDays ?? 23) => {
      const task = assessments.createOrReuseAssessment({ ...input, requestedBy: 'sales' }, true, NOW, 30).record;
      const at = new Date(NOW.getTime() - ageDays * 86_400_000);
      assessments.completeAssessment(task.assessmentId, {
        reportMarkdown: '# 原报告', recommendedProduct: 'solidworks', overallOpportunity: '中',
        sourceStatus: { qcc: 'completed', doubaoSearch: 'completed', ark: 'completed' },
        collectedAt: at.toISOString(), resultAudit, evidenceSnapshot: snapshot,
      }, at);
      return task.assessmentId;
    };
    return { service, input, assessments, profiles, complete, qccCall, qccClose, search, answer, db };
  }

  it.each(['这家公司库内有哪些联系人？','这家公司目前库内有哪些联系人和职位？'])('answers from supplied contacts without fresh research and rejects fabricated refs: %s', async question => {
    const materials = vi.fn(async () => ({state:'ok' as const,warnings:[],omitted_count:0,contacts_read:1,
      items:[{citation:{ref:'contact:e-work',source_type:'contact' as const,subject_id:'p1',quote:'张某曾任工程师'},
        statement:'张某有工程师任职记录，当前状态未知。',source_key:'file:synthetic',predicate:'worksFor',object:'工程师'}]}));
    const runtime = setup({companyContext:{materials}});
    runtime.answer.mockResolvedValueOnce({claims:[{category:'supported',text:'张某有工程师任职记录，当前状态未知。',evidenceIds:[],contextRefs:['contact:e-work']},
      {category:'supported',text:'伪造说法',evidenceIds:[],contextRefs:['fake']}],includedEvidenceIds:[],includedContextRefs:['contact:e-work']});
    const result = await runtime.service.ask({...runtime.input,question});
    expect(result.status).toBe('answered');
    expect(result.markdown).toContain('当前状态未知');
    expect(result.markdown).not.toContain('伪造说法');
    expect(result.context_citations?.map(c=>c.ref)).toEqual(['contact:e-work']);
    expect(runtime.search).not.toHaveBeenCalled();
    expect(runtime.qccCall).not.toHaveBeenCalled();
  });

  it('refuses a contact ref excluded from the actual model input',async()=>{
    const materials=vi.fn(async()=>({state:'ok' as const,warnings:[],omitted_count:0,contacts_read:1,items:[{citation:{ref:'omitted',source_type:'contact' as const,subject_id:'p1'},statement:'已有任职',source_key:'file:one',predicate:'worksFor',object:'工程师'}]}));
    const r=setup({companyContext:{materials}});
    r.answer.mockResolvedValueOnce({claims:[{category:'supported',text:'不得出现的说法',evidenceIds:[],contextRefs:['omitted']}],includedEvidenceIds:[],includedContextRefs:[]});
    const result=await r.service.ask({...r.input,question:'库内联系人是谁？'});
    expect(result.status).toBe('insufficient');expect(result.markdown).not.toContain('不得出现的说法');
    expect(result.context_citations).toBeUndefined();
  });

  it('rejects absent or mismatched confirmed identity before upstream calls', async () => {
    const missing = setup({ profile: false });
    expect((await missing.service.ask(missing.input)).status).toBe('failed');
    expect(missing.search).not.toHaveBeenCalled();
    const mismatched = setup();
    expect((await mismatched.service.ask({ ...mismatched.input, legalName: '另一家公司' })).status).toBe('failed');
    expect(mismatched.qccCall).not.toHaveBeenCalled();
  });

  it('reuses the confirmed snapshot through day 30 without fresh calls and preserves the report', async () => {
    const runtime = setup({ snapshotAgeDays: 30 });
    const assessmentId = runtime.complete(30);
    const before = runtime.assessments.get(assessmentId);
    const result = await runtime.service.ask({ ...runtime.input, assessmentId });
    expect(result.status).toBe('answered');
    expect(result.usedFreshResearch).toBe(false);
    expect(result.markdown).toContain('岗位要求 SolidWorks 技能');
    expect(result.markdown).toContain('企查查记录，无直达链接');
    expect(runtime.qccCall).not.toHaveBeenCalled();
    expect(runtime.search).not.toHaveBeenCalled();
    expect(runtime.assessments.get(assessmentId)).toEqual(before);
  });

  it('keeps distinct evidence records even when they share one source URL', async () => {
    const runtime = setup();
    const id = runtime.complete();
    const stored = runtime.assessments.get(id)!;
    runtime.db.prepare('UPDATE assessments SET evidence_snapshot_json = ? WHERE assessment_id = ?').run(
      JSON.stringify({ ...stored.evidenceSnapshot, items: [
        { ...snapshotItem, url: 'https://example.cn/jobs' },
        { ...snapshotItem, evidenceId: 'qcc-recruitment-2', title: '另一个 SolidWorks 岗位',
          url: 'https://example.cn/jobs' },
      ] }), id,
    );
    await runtime.service.ask({ ...runtime.input, assessmentId: id });
    expect(runtime.answer.mock.calls[0]?.[0].items.map(item => item.evidenceId))
      .toEqual(['qcc-recruitment-1', 'qcc-recruitment-2']);
  });

  it('does not reuse an expired snapshot or parse an old report without one', async () => {
    const expired = setup({ snapshotAgeDays: 31 });
    const oldId = expired.complete(31);
    expired.answer.mockResolvedValue({ claims: [] });
    const answer = await expired.service.ask({ ...expired.input, assessmentId: oldId });
    expect(answer.status).toBe('insufficient');
    expect(expired.search).toHaveBeenCalled();
    const noSnapshot = setup();
    const task = noSnapshot.assessments.createOrReuseAssessment({ ...noSnapshot.input, requestedBy: 'sales' }, true, NOW, 30).record;
    noSnapshot.assessments.completeAssessment(task.assessmentId, {
      reportMarkdown: '# 原报告 SolidWorks', recommendedProduct: null, overallOpportunity: '待核实',
      sourceStatus: { qcc: 'completed', doubaoSearch: 'completed', ark: 'completed' },
      collectedAt: NOW.toISOString(), resultAudit,
    }, NOW);
    expect((await noSnapshot.service.ask({ ...noSnapshot.input, assessmentId: task.assessmentId })).usedFreshResearch)
      .toBe(true);
  });

  it('rejects a specified report for another company or an unfinished report', async () => {
    const runtime = setup();
    const task = runtime.assessments.createOrReuseAssessment({ ...runtime.input, requestedBy: 'sales' }, true, NOW, 30).record;
    expect((await runtime.service.ask({ ...runtime.input, assessmentId: task.assessmentId })).status).toBe('failed');
    runtime.db.prepare('UPDATE assessments SET legal_name = ? WHERE assessment_id = ?')
      .run('另一家公司', task.assessmentId);
    expect((await runtime.service.ask({ ...runtime.input, assessmentId: task.assessmentId })).status).toBe('failed');
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('refreshes dynamic questions; failed single source is marked and cannot turn aliases into facts', async () => {
    const runtime = setup({ qccFails: true });
    runtime.complete();
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-alias', source: 'doubao_search', sourceKind: 'web', title: '测试装备发布新品',
      url: 'https://example.cn/news', originalPublisher: '媒体', originalDomain: 'example.cn',
      summary: '测试装备推出新品', content: null, publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(),
      mentionedName: '测试装备', entityScope: 'unknown', entityMatch: 'unverified', matchBasis: ['仅简称'],
      query: '测试装备 新品', position: 1, logId: null,
    }]);
    runtime.answer.mockResolvedValue({ claims: [{ category: 'supported', text: '已确认发布新品', evidenceIds: ['web-alias'] }] });
    const result = await runtime.service.ask({ ...runtime.input, question: '最近招聘和新品发布有什么趋势？' });
    expect(result.usedFreshResearch).toBe(true);
    expect(runtime.qccCall).toHaveBeenCalledTimes(1);
    expect(runtime.search.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.markdown).toContain('企查查');
    expect(result.markdown).not.toContain('已确认发布新品');
  });

  it('answers from confirmed web evidence when QCC fails and labels the missing source', async () => {
    const runtime = setup({ qccFails: true });
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-1', source: 'doubao_search', sourceKind: 'web', title: '测试装备发布新品',
      url: 'https://example.cn/news', originalPublisher: '公司官网', originalDomain: 'example.cn',
      summary: '测试装备有限公司发布新品', content: null,
      publishedAt: '2026-09-01T00:00:00.000Z', collectedAt: NOW.toISOString(),
      mentionedName: identity.legalName, entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['法定名称一致'], query: '测试装备 新品', position: 1, logId: null,
    }]);
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '2026 年 9 月发布新品', evidenceIds: ['web-1'],
    }] });
    const result = await runtime.service.ask({ ...runtime.input, question: '最近招聘和产品发布有什么信息？' });
    expect(result.status).toBe('insufficient');
    expect(result.markdown).toContain('企查查定向查询失败');
    expect(result.markdown).toContain('https://example.cn/news');
    expect(result.markdown).toContain('招聘');
  });

  it('does not let thirty hiring records crowd out product evidence or mark a partial answer complete', async () => {
    const runtime = setup();
    runtime.qccCall.mockResolvedValue({
      企业名称: identity.legalName,
      招聘信息: Array.from({ length: 30 }, (_, index) => ({
        招聘职位: `工程师 ${index + 1}`, 发布日期: '2026-08-01',
      })),
    });
    runtime.search.mockImplementation(async query => query.Query.includes('产品')
      ? Array.from({ length: 20 }, (_, index) => ({
        evidenceId: `product-${index + 1}`, source: 'doubao_search' as const,
        sourceKind: 'web' as const, title: `${identity.legalName}产品发布 ${index + 1}`,
        url: `https://example.cn/products/${index + 1}`, originalPublisher: '企业官网',
        originalDomain: 'example.cn', summary: `${identity.legalName}发布机器人新品`,
        content: null, publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(),
        mentionedName: identity.legalName, entityScope: 'legal_entity' as const,
        entityMatch: 'confirmed' as const, matchBasis: ['法定名称一致'],
        query: query.Query, position: index + 1, logId: null,
      })) : []);
    runtime.answer.mockImplementation(async input => ({
      claims: [
        { category: 'supported' as const, text: '该企业发布了1条招聘信息',
          evidenceIds: [input.items.find(item => item.source === 'qcc')!.evidenceId,
            input.items.find(item => item.source === 'doubao_search')!.evidenceId] },
        { category: 'supported' as const, text: '该企业没有产品发布',
          evidenceIds: [input.items.find(item => item.source === 'qcc')!.evidenceId] },
        { category: 'unknown' as const, text: '未查询到产品发布', evidenceIds: [] },
      ],
      includedEvidenceIds: input.items.slice(0, 10).map(item => item.evidenceId),
      omittedCount: 40,
    }));
    const result = await runtime.service.ask({ ...runtime.input,
      question: '最近一年有哪些产品发布和招聘信号？' });
    const sent = runtime.answer.mock.calls[0]![0].items.slice(0, 10);
    expect(sent.some(item => item.source === 'qcc')).toBe(true);
    expect(sent.some(item => item.source === 'doubao_search')).toBe(true);
    expect(result.status).toBe('insufficient');
    expect(result.markdown).toContain('产品发布');
    expect(result.markdown).toContain('尚未回答');
    expect(result.markdown).toContain('本次引用的招聘材料');
    expect(result.markdown).not.toContain('发布了1条招聘信息');
    expect(result.markdown).not.toContain('未查询到产品发布');
    expect(result.markdown).not.toContain('没有产品发布');
    expect(result.markdown).toContain('未纳入 40 条材料');

    runtime.answer.mockImplementation(async input => ({
      claims: [
        { category: 'supported', text: '该企业发布新品',
          evidenceIds: [input.items.find(item => item.source === 'doubao_search')!.evidenceId] },
        { category: 'supported', text: '该企业招聘工程师',
          evidenceIds: [input.items.find(item => item.source === 'qcc')!.evidenceId] },
      ],
      includedEvidenceIds: input.items.slice(0, 10).map(item => item.evidenceId), omittedCount: 40,
    }));
    const noPurchaseJudgment = await runtime.service.ask({ ...runtime.input,
      question: '最近一年有哪些产品发布和招聘信号？这些资料能否证明已有软件采购计划？' });
    expect(noPurchaseJudgment.status).toBe('insufficient');
    expect(noPurchaseJudgment.markdown).toContain('软件采购计划');
  });

  it('discards unsupported citations and undated quantitative trend claims', async () => {
    const runtime = setup();
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-undated', source: 'doubao_search', sourceKind: 'web', title: '测试装备招聘',
      url: 'https://example.cn/jobs', originalPublisher: '官网', originalDomain: 'example.cn',
      summary: '测试装备有限公司正在招聘', content: null, publishedAt: null,
      collectedAt: NOW.toISOString(), mentionedName: identity.legalName,
      entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['法定名称一致'],
      query: '测试装备 招聘', position: 1, logId: null,
    }]);
    runtime.answer.mockResolvedValue({ claims: [
      { category: 'supported', text: '招聘人数从 10 人增至 30 人', evidenceIds: ['web-undated'] },
      { category: 'supported', text: '已确认采购', evidenceIds: ['invented-id'] },
    ] });
    const result = await runtime.service.ask({ ...runtime.input, question: '招聘趋势如何？' });
    expect(result.status).toBe('insufficient');
    expect(result.markdown).not.toContain('招聘人数从 10 人增至 30 人');
    expect(result.markdown).not.toContain('已确认采购');
  });

  it('does not turn hiring-only evidence into an affirmative software purchase claim', async () => {
    const runtime = setup();
    runtime.complete();
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '已经采购 SolidWorks', evidenceIds: ['qcc-recruitment-1'],
    }] });
    const result = await runtime.service.ask(runtime.input);
    expect(result.status).toBe('insufficient');
    expect(result.markdown).not.toContain('已经采购 SolidWorks');
  });

  it('does not launder a purchase claim through hiring plus unrelated company evidence', async () => {
    const runtime = setup();
    const id = runtime.complete();
    const stored = runtime.assessments.get(id)!;
    runtime.db.prepare('UPDATE assessments SET evidence_snapshot_json = ? WHERE assessment_id = ?').run(
      JSON.stringify({
        ...stored.evidenceSnapshot,
        items: [...stored.evidenceSnapshot!.items, {
          ...snapshotItem, evidenceId: 'qcc-company-1', title: '公司简介', excerpt: '企业从事装备制造',
        }],
      }), id,
    );
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '已经采购 SolidWorks',
      evidenceIds: ['qcc-recruitment-1', 'qcc-company-1'],
    }] });
    const result = await runtime.service.ask(runtime.input);
    expect(result.status).toBe('insufficient');
    expect(result.markdown).not.toContain('已经采购 SolidWorks');
  });

  it('keeps a correctly negated purchase warning supported by hiring evidence', async () => {
    const runtime = setup();
    runtime.complete();
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '不能证明已采购 SolidWorks', evidenceIds: ['qcc-recruitment-1'],
    }] });
    const result = await runtime.service.ask(runtime.input);
    expect(result.status).toBe('answered');
    expect(result.markdown).toContain('不能证明已采购 SolidWorks');
  });

  it('rejects a supplier award plus unrelated hiring as proof of buying SolidWorks', async () => {
    const runtime = setup();
    const id = runtime.complete();
    const stored = runtime.assessments.get(id)!;
    runtime.db.prepare('UPDATE assessments SET evidence_snapshot_json = ? WHERE assessment_id = ?').run(
      JSON.stringify({
        ...stored.evidenceSnapshot,
        items: [...stored.evidenceSnapshot!.items, {
          ...snapshotItem, evidenceId: 'qcc-operation-get_bidding_info-1',
          title: `${identity.legalName}中标别家公司设备采购公告`,
          excerpt: `{"purchaser":"别家公司有限公司","title":"设备采购"}`,
        }],
      }), id,
    );
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '已经采购 SolidWorks',
      evidenceIds: ['qcc-recruitment-1', 'qcc-operation-get_bidding_info-1'],
    }] });
    const result = await runtime.service.ask(runtime.input);
    expect(result.status).toBe('insufficient');
  });

  it('accepts a matching official purchase-intention notice naming the target as buyer', async () => {
    const runtime = setup();
    const id = runtime.complete();
    const stored = runtime.assessments.get(id)!;
    runtime.db.prepare('UPDATE assessments SET evidence_snapshot_json = ? WHERE assessment_id = ?').run(
      JSON.stringify({
        ...stored.evidenceSnapshot,
        items: [...stored.evidenceSnapshot!.items, {
          ...snapshotItem, evidenceId: 'qcc-operation-get_bidding_info-1',
          title: `${identity.legalName} SolidWorks 采购公告`,
          excerpt: `{"purchaser":"${identity.legalName}","title":"SolidWorks 采购意向"}`,
        }],
      }), id,
    );
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '计划采购 SolidWorks',
      evidenceIds: ['qcc-operation-get_bidding_info-1'],
    }] });
    const result = await runtime.service.ask(runtime.input);
    expect(result.status).toBe('answered');
    expect(result.markdown).toContain('计划采购 SolidWorks');
  });

  it('downgrades a subsidiary article that names the target only in its footer', async () => {
    const runtime = setup();
    runtime.profiles.upsert({
      identity: { ...identity, subsidiaryLegalNames: ['测试装备子公司有限公司'] },
      normalizedLegalName: identity.legalName, basicProfile: baseProfile, collectedAt: NOW.toISOString(),
    });
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-child', source: 'doubao_search', sourceKind: 'web',
      title: '测试装备子公司有限公司发布新品', url: 'https://example.cn/child',
      originalPublisher: '媒体', originalDomain: 'example.cn',
      summary: '测试装备子公司有限公司扩张产能',
      content: `${'子公司报道。'.repeat(100)}页脚：测试装备有限公司`,
      publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(),
      mentionedName: identity.legalName, entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['正文提及法定名称'], query: '测试装备 扩张', position: 1, logId: null,
    }]);
    const result = await runtime.service.ask({ ...runtime.input, question: '最近产品发布和扩张如何？' });
    expect(result.status).toBe('insufficient');
    expect(runtime.answer).not.toHaveBeenCalled();
  });

  it('downgrades an unknown subsidiary story even when the parent legal name appears prominently', async () => {
    const runtime = setup();
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-child', source: 'doubao_search', sourceKind: 'web',
      title: `${identity.legalName}旗下子公司发布新品`, url: 'https://example.cn/child',
      originalPublisher: '媒体', originalDomain: 'example.cn',
      summary: `${identity.legalName}称其子公司推出设备`, content: null,
      publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(),
      mentionedName: identity.legalName, entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['法定名称一致'], query: '测试装备 新品', position: 1, logId: null,
    }]);
    const result = await runtime.service.ask({ ...runtime.input, question: '最近发布了什么产品？' });
    expect(result.status).toBe('insufficient');
    expect(runtime.answer).not.toHaveBeenCalled();
  });

  it('renders hostile source titles and claims as plain Markdown text', async () => {
    const runtime = setup();
    runtime.search.mockResolvedValue([{
      evidenceId: 'web-safe', source: 'doubao_search', sourceKind: 'web',
      title: `${identity.legalName}新品\n\n## 已批准采购\n- 伪造事实`,
      url: 'https://example.cn/news', originalPublisher: '官网', originalDomain: 'example.cn',
      summary: `${identity.legalName}发布新品`, content: null,
      publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(),
      mentionedName: identity.legalName, entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['法定名称一致'], query: '测试装备 新品', position: 1, logId: null,
    }]);
    runtime.answer.mockResolvedValue({ claims: [{
      category: 'supported', text: '发布新品\n\n## 伪造行动', evidenceIds: ['web-safe'],
    }] });
    const result = await runtime.service.ask({ ...runtime.input, question: '最近发布什么？' });
    expect(result.status).toBe('answered');
    expect(result.markdown).not.toContain('\n## 已批准采购');
    expect(result.markdown).not.toContain('\n## 伪造行动');
    expect(result.markdown).not.toContain('\n- 伪造事实');
  });

  it('aborts an in-flight search at the request deadline and returns failed', async () => {
    const runtime = setup();
    let upstreamAborted = false;
    runtime.search.mockImplementation((_query: SearchQuery, signal?: AbortSignal) => new Promise<ResearchItem[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }));
    const result = await runtime.service.ask({ ...runtime.input, question: '最近发布了什么产品？' });
    expect(result.status).toBe('failed');
    expect(upstreamAborted).toBe(true);
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(runtime.answer).not.toHaveBeenCalled();
  });
});
