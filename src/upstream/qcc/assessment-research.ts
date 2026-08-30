import type { IdentityProfile, ResearchItem, ResearchSourceStatus } from '../../contracts/index.js';
import type { CallBudget } from '../../orchestration/call-budget.js';
import { retryOnce, type RetryResult } from '../../orchestration/retry.js';
import { mapQccToolResult, type MappedQccResult } from './mapper.js';
import type { QccServer } from './tool-allowlist.js';

export interface QccResearchGateway {
  call(server: QccServer, tool: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface SourceCollection {
  items: ResearchItem[];
  sourceStatus: { status: ResearchSourceStatus; error: string | null };
  gaps: string[];
}

interface PlannedCall {
  server: QccServer;
  tool: string;
  failureGap: string;
}

const financingCall: PlannedCall = {
  server: 'operation', tool: 'get_financing_records', failureGap: '融资信息获取失败',
};
const recruitmentCall: PlannedCall = {
  server: 'operation', tool: 'get_recruitment_info', failureGap: '招聘信息获取失败',
};
const coreCalls: PlannedCall[] = [
  { server: 'company', tool: 'get_company_profile', failureGap: '企业简介获取失败' },
  { server: 'risk', tool: 'get_company_risk_scan', failureGap: '企业风险获取失败' },
  { server: 'ipr', tool: 'get_patent_info', failureGap: '专利信息获取失败' },
  { server: 'operation', tool: 'get_annual_reports', failureGap: '年报信息获取失败' },
  { server: 'operation', tool: 'get_bidding_info', failureGap: '招投标信息获取失败' },
];

function selectEighthCall(identity: IdentityProfile, currentItems: ResearchItem[]): PlannedCall {
  if (identity.parentLegalName === null) {
    return { server: 'company', tool: 'get_shareholder_info', failureGap: '股东信息获取失败' };
  }
  if (!currentItems.some(item => item.sourceKind === 'ipr')) {
    return { server: 'ipr', tool: 'get_software_copyright_info', failureGap: '软件著作权信息获取失败' };
  }
  return { server: 'operation', tool: 'get_qualifications', failureGap: '资质信息获取失败' };
}

export class QccResearchCollector {
  constructor(
    private readonly gateway: QccResearchGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collectQccResearch(identity: IdentityProfile, budget: CallBudget): Promise<SourceCollection> {
    const items: ResearchItem[] = [];
    const gaps: string[] = [];
    const errors: string[] = [];
    let successfulCalls = 0;
    let failedCalls = 0;
    let stoppedByBudget = false;
    const input = { credit_code: identity.creditCode, company_name: identity.legalName };

    const start = (call: PlannedCall): Promise<RetryResult<MappedQccResult>> => retryOnce(
      'qcc',
      budget,
      async () => mapQccToolResult(
        call.server,
        call.tool,
        await this.gateway.call(call.server, call.tool, input),
        identity,
        this.now(),
      ),
    );

    const accept = (call: PlannedCall, result: RetryResult<MappedQccResult>): void => {
      if (result.status === 'failed') {
        failedCalls += 1;
        if (result.error.code === 'BUDGET_EXHAUSTED') stoppedByBudget = true;
        gaps.push(call.failureGap);
        errors.push(result.error.message);
        return;
      }
      successfulCalls += 1;
      items.push(...result.value.items);
      gaps.push(...result.value.gaps);
    };

    if (budget.canConsume('qcc', 2)) {
      // Starting both promises back-to-back guarantees both initial attempts consume
      // their reserved slots before either retry continuation can run.
      const financing = start(financingCall);
      const recruitment = start(recruitmentCall);
      const [financingResult, recruitmentResult] = await Promise.all([financing, recruitment]);
      accept(financingCall, financingResult);
      accept(recruitmentCall, recruitmentResult);
    } else if (budget.canConsume('qcc')) {
      // With only one slot left, financing keeps the first priority. Recruitment
      // and ordinary calls must not consume or displace that slot.
      accept(financingCall, await start(financingCall));
      stoppedByBudget = true;
      gaps.push(recruitmentCall.failureGap);
    } else {
      stoppedByBudget = true;
      gaps.push(financingCall.failureGap, recruitmentCall.failureGap);
    }

    for (const call of coreCalls) {
      if (!budget.canConsume('qcc')) {
        stoppedByBudget = true;
        gaps.push(`${call.failureGap}（调用预算已用尽）`);
        break;
      }
      accept(call, await start(call));
    }

    const eighthCall = selectEighthCall(identity, items);
    if (budget.canConsume('qcc')) {
      accept(eighthCall, await start(eighthCall));
    } else if (successfulCalls + failedCalls < 8) {
      stoppedByBudget = true;
      gaps.push(`${eighthCall.failureGap}（调用预算已用尽）`);
    }

    const status: ResearchSourceStatus = items.length === 0
      ? 'failed'
      : failedCalls > 0 || stoppedByBudget ? 'partial' : 'completed';
    return {
      items,
      sourceStatus: {
        status,
        error: status === 'failed' ? errors[0] ?? '企查查未返回可用资料' : errors[0] ?? null,
      },
      gaps: [...new Set(gaps)],
    };
  }
}
