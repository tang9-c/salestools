import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IdentityProfile } from '../src/contracts/index.js';
import { CallBudget } from '../src/orchestration/call-budget.js';
import {
  QccGateway,
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
});
