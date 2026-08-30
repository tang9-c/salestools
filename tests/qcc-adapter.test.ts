import { readFileSync } from 'node:fs';
import {
  InsufficientScopeError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { IdentityProfile } from '../src/contracts/index.js';
import { CallBudget } from '../src/orchestration/call-budget.js';
import { UpstreamError } from '../src/orchestration/retry.js';
import {
  QccGateway,
  classifyQccSdkError,
  type QccConnection,
  type QccConnectionFactory,
} from '../src/upstream/qcc/client.js';
import { mapQccToolResult } from '../src/upstream/qcc/mapper.js';
import { QccResearchCollector } from '../src/upstream/qcc/assessment-research.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const config = {
  urls: {
    company: 'https://agent.qcc.com/mcp/company/stream',
    risk: 'https://agent.qcc.com/mcp/risk/stream',
    ipr: 'https://agent.qcc.com/mcp/ipr/stream',
    operation: 'https://agent.qcc.com/mcp/operation/stream',
  },
  apiKey: 'test-qcc-key',
};

const identity: IdentityProfile = {
  legalName: '测试制造有限公司', creditCode: '91310000TEST000001', formerNames: [], aliases: [],
  englishNames: [], brands: [], officialDomains: [], registeredAddress: null, parentLegalName: null,
  subsidiaryLegalNames: [],
};

describe('QccGateway', () => {
  it('classifies SDK authentication, scope and HTTP handshake errors as typed remote errors', () => {
    expect(classifyQccSdkError(new UnauthorizedError('missing token'))).toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });
    expect(classifyQccSdkError(new InsufficientScopeError({ requiredScope: 'qcc.read' }))).toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });
    expect(classifyQccSdkError(new SdkHttpError(
      SdkErrorCode.ClientHttpAuthentication,
      'handshake rejected',
      { status: 401 },
    ))).toMatchObject({ code: 'REMOTE_HTTP_ERROR' });
    expect(classifyQccSdkError(new Error('socket reset'))).toBeNull();
  });

  it('removes a rejected handshake promise so a later call can rebuild the connection', async () => {
    let created = 0;
    const factory: QccConnectionFactory = {
      create: async () => {
        created += 1;
        if (created === 1) throw new UpstreamError('qcc', 'AUTHENTICATION_ERROR', 'handshake rejected');
        return { callTool: async () => ({ Data: [] }), close: async () => undefined };
      },
    };
    const gateway = new QccGateway(config, factory);

    await expect(gateway.call('company', 'get_company_by_query', {}))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    await expect(gateway.call('company', 'get_company_by_query', {})).resolves.toEqual({ Data: [] });
    expect(created).toBe(2);
    await gateway.close();
  });

  it('rejects non-allowlisted server/tool pairs before creating a network connection', async () => {
    let connections = 0;
    const factory: QccConnectionFactory = { create: async () => { connections += 1; throw new Error('network'); } };
    const gateway = new QccGateway(config, factory);

    await expect(gateway.call('history' as never, 'get_history', {})).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    await expect(gateway.call('__proto__' as never, 'get_history', {})).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    await expect(gateway.call('company', 'get_financing_records', {})).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    expect(connections).toBe(0);
  });

  it('performs exactly one callTool per call and clears a failed connection for the next outer attempt', async () => {
    let created = 0;
    let calls = 0;
    let closes = 0;
    const factory: QccConnectionFactory = {
      create: async () => {
        created += 1;
        const connection: QccConnection = {
          callTool: async () => {
            calls += 1;
            if (created === 1) throw new Error('transport down');
            return { Data: [] };
          },
          close: async () => { closes += 1; },
        };
        return connection;
      },
    };
    const gateway = new QccGateway(config, factory);

    await expect(gateway.call('operation', 'get_financing_records', { creditCode: identity.creditCode }))
      .rejects.toMatchObject({ code: 'TRANSPORT' });
    expect({ created, calls, closes }).toEqual({ created: 1, calls: 1, closes: 1 });

    await expect(gateway.call('operation', 'get_financing_records', { creditCode: identity.creditCode }))
      .resolves.toEqual({ Data: [] });
    expect({ created, calls }).toEqual({ created: 2, calls: 2 });
    await gateway.close();
  });

  it('keeps a shared operation connection open when one concurrent call returns a business error', async () => {
    let created = 0;
    let closes = 0;
    let releaseRecruitment!: () => void;
    const recruitmentMayFinish = new Promise<void>(resolve => { releaseRecruitment = resolve; });
    const factory: QccConnectionFactory = {
      create: async () => {
        created += 1;
        let closed = false;
        return {
          callTool: async tool => {
            if (tool === 'get_financing_records') {
              throw new UpstreamError('qcc', 'REMOTE_TOOL_ERROR', 'invalid company parameter');
            }
            await recruitmentMayFinish;
            if (closed) throw new Error('shared connection was closed');
            return { Data: [{ JobName: '研发工程师' }] };
          },
          close: async () => { closes += 1; closed = true; },
        };
      },
    };
    const gateway = new QccGateway(config, factory);

    const financing = gateway.call('operation', 'get_financing_records', {});
    const recruitment = gateway.call('operation', 'get_recruitment_info', {});
    await expect(financing).rejects.toMatchObject({ code: 'REMOTE_TOOL_ERROR' });
    releaseRecruitment();
    await expect(recruitment).resolves.toEqual({ Data: [{ JobName: '研发工程师' }] });
    await expect(gateway.call('operation', 'get_annual_reports', {})).resolves.toEqual({ Data: [{ JobName: '研发工程师' }] });
    expect({ created, closes }).toEqual({ created: 1, closes: 0 });
    await gateway.close();
  });
});

describe('QCC mapping and formal collection', () => {
  it('preserves sanitized financing and recruitment fields without inventing optional values', () => {
    const now = new Date('2026-08-29T12:00:00.000Z');
    const financing = mapQccToolResult('operation', 'get_financing_records', fixture('qcc-financing.json'), identity, now);
    const recruitment = mapQccToolResult('operation', 'get_recruitment_info', fixture('qcc-recruitment.json'), identity, now);

    expect(JSON.parse(financing.items[0].content ?? '{}')).toEqual({
      occurredAt: '2026-06-15T00:00:00.000Z', typeOrRound: 'A轮', disclosedAmount: null,
      investors: ['示例创投', '产业基金'],
    });
    expect(JSON.parse(financing.items[1].content ?? '{}')).toEqual({
      occurredAt: null, typeOrRound: '定向增发', disclosedAmount: null, investors: [],
    });
    expect(JSON.parse(recruitment.items[0].content ?? '{}')).toMatchObject({
      publishedAt: '2026-07-01T00:00:00.000Z', jobName: 'Creo机械设计工程师', location: '上海',
    });
    expect(financing.gaps).toEqual([]);
  });

  it.each([
    ['risk', 'get_company_risk_scan', 'qcc-risk.json', {
      riskCount: 3, exceptionCount: 1, penaltyCount: 1, judicialCount: 1,
      summary: '存在一条已移出的经营异常记录',
    }],
    ['ipr', 'get_patent_info', 'qcc-patent.json', {
      patentName: '一种精密传动装置', patentType: '发明专利', applicationNumber: 'CN202610000001.0',
      applicationDate: '2026-02-03T00:00:00.000Z', status: '实质审查',
    }],
    ['operation', 'get_annual_reports', 'qcc-annual-report.json', {
      year: '2025', employeeCount: 286, totalAssets: '8.2亿元', revenue: null,
    }],
    ['operation', 'get_bidding_info', 'qcc-bidding.json', {
      title: '研发数据管理平台采购项目', publishedAt: '2026-07-20T00:00:00.000Z', role: '采购方',
      amount: null, purchaser: '测试制造有限公司',
    }],
    ['company', 'get_shareholder_info', 'qcc-shareholder.json', {
      shareholderName: '测试控股有限公司', shareholdingRatio: '62.5%',
      subscribedCapital: '3125万元人民币', shareholderType: '企业法人',
    }],
    ['ipr', 'get_software_copyright_info', 'qcc-software-copyright.json', {
      softwareName: '研发协同管理系统', shortName: '研发协同', registrationNumber: '2026SR000001',
      registrationDate: '2026-04-08T00:00:00.000Z', version: 'V1.0',
    }],
    ['operation', 'get_qualifications', 'qcc-qualification.json', {
      qualificationName: 'IATF 16949质量管理体系认证', certificateNumber: 'IATF-TEST-001',
      issuedAt: '2025-09-01T00:00:00.000Z', expiresAt: '2028-08-31T00:00:00.000Z', issuer: '示例认证机构',
    }],
  ] as const)('validates and maps %s/%s with its tool-level contract', (server, tool, file, expected) => {
    const mapped = mapQccToolResult(server, tool, fixture(file), identity, new Date('2026-08-29T12:00:00.000Z'));
    expect(mapped.items).toHaveLength(1);
    expect(JSON.parse(mapped.items[0].content ?? '{}')).toEqual(expected);
    expect(mapped.items[0].url).toMatch(/^https:\/\//);
  });

  it.each([
    ['operation', 'get_financing_records', {
      Data: [{ Date: 'not-a-date', Round: '   ', Type: '', Amount: ' ', Investors: ['   '] }],
    }],
    ['operation', 'get_financing_records', {
      Data: [{ Date: '2026-02-30', Round: null, Type: null, Amount: null, Investors: [] }],
    }],
    ['risk', 'get_company_risk_scan', {
      Data: [{ RiskCount: null, ExceptionCount: null, PenaltyCount: null, JudicialCount: null, Summary: '   ' }],
    }],
    ['ipr', 'get_patent_info', {
      Data: [{ PatentName: ' ', ApplicationNumber: '', ApplicationDate: '2026-99-99' }],
    }],
  ] as const)('rejects blank or invalid key fields for %s/%s', (server, tool, payload) => {
    expect(() => mapQccToolResult(server, tool, payload, identity, new Date('2026-08-29T12:00:00.000Z')))
      .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('starts financing first and recruitment second before any other call or retry', async () => {
    const events: string[] = [];
    const attempts = new Map<string, number>();
    const gateway = {
      call: async (_server: string, tool: string) => {
        events.push(tool);
        const count = (attempts.get(tool) ?? 0) + 1;
        attempts.set(tool, count);
        if ((tool === 'get_financing_records' || tool === 'get_recruitment_info') && count === 1) {
          throw new Error(`${tool} temporary failure`);
        }
        return { Data: [{ Name: identity.legalName }] };
      },
    };
    const collector = new QccResearchCollector(gateway, () => new Date('2026-08-29T12:00:00.000Z'));
    const budget = new CallBudget({ qcc: 8, doubaoSearch: 1, ark: 1, total: 8 });

    await collector.collectQccResearch(identity, budget);

    expect(events.slice(0, 2)).toEqual(['get_financing_records', 'get_recruitment_info']);
    expect(events).toHaveLength(8);
    expect(events.filter(event => event === 'get_financing_records')).toHaveLength(2);
    expect(events.filter(event => event === 'get_recruitment_info')).toHaveLength(2);
  });

  it('marks financing failure as a gap and QCC partial when other calls remain usable', async () => {
    const gateway = {
      call: async (_server: string, tool: string) => {
        if (tool === 'get_financing_records') throw new Error('financing unavailable');
        return tool === 'get_recruitment_info' ? fixture('qcc-recruitment.json') : { Data: [{ Name: identity.legalName }] };
      },
    };
    const collector = new QccResearchCollector(gateway, () => new Date('2026-08-29T12:00:00.000Z'));
    const result = await collector.collectQccResearch(
      identity,
      new CallBudget({ qcc: 8, doubaoSearch: 1, ark: 1, total: 8 }),
    );

    expect(result.sourceStatus.status).toBe('partial');
    expect(result.gaps).toContain('融资信息获取失败');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('financingStatus');
  });

  it('limits a later QCC profile request to two outer attempts', async () => {
    const attempts = new Map<string, number>();
    const collector = new QccResearchCollector({
      call: async (_server, tool) => {
        attempts.set(tool, (attempts.get(tool) ?? 0) + 1);
        if (tool === 'get_financing_records') return fixture('qcc-financing.json');
        if (tool === 'get_recruitment_info') return fixture('qcc-recruitment.json');
        if (tool === 'get_company_profile') throw new Error('raw profile response');
        return { Data: [] };
      },
    }, () => new Date('2026-08-29T12:00:00.000Z'));

    await collector.collectQccResearch(
      identity,
      new CallBudget({ qcc: 8, doubaoSearch: 1, ark: 1, total: 8 }),
    );

    expect(attempts.get('get_company_profile')).toBe(2);
  });

  it('marks QCC failed when every successful response contains no usable items', async () => {
    const events: string[] = [];
    const collector = new QccResearchCollector({
      call: async (_server, tool) => { events.push(tool); return { Data: [] }; },
    }, () => new Date('2026-08-29T12:00:00.000Z'));

    const result = await collector.collectQccResearch(
      identity,
      new CallBudget({ qcc: 8, doubaoSearch: 1, ark: 1, total: 8 }),
    );

    expect(events).toHaveLength(8);
    expect(result.items).toEqual([]);
    expect(result.sourceStatus.status).toBe('failed');
    expect(result.sourceStatus.error).toBe('企查查未返回可用资料');
  });

  it('uses the only remaining QCC call for financing and does not let ordinary calls consume it', async () => {
    const events: string[] = [];
    const collector = new QccResearchCollector({
      call: async (_server, tool) => {
        events.push(tool);
        return tool === 'get_financing_records' ? fixture('qcc-financing.json') : { Data: [] };
      },
    }, () => new Date('2026-08-29T12:00:00.000Z'));

    const result = await collector.collectQccResearch(
      identity,
      new CallBudget({ qcc: 1, doubaoSearch: 1, ark: 1, total: 1 }),
    );

    expect(events).toEqual(['get_financing_records']);
    expect(result.items).toHaveLength(2);
    expect(result.sourceStatus.status).toBe('partial');
    expect(result.gaps).toContain('招聘信息获取失败');
  });
});
