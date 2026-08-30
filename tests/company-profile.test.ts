import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CompanyProfileService, normalizeLegalName } from '../src/upstream/qcc/profile-service.js';

const now = new Date('2026-08-29T12:00:00.000Z');
const candidate = {
  Name: '测试制造有限公司', CreditCode: '91310000TEST000001', Status: '存续',
  Address: '上海市浦东新区测试路1号', MatchReason: '名称完全匹配',
};
const identity = {
  legalName: candidate.Name, creditCode: candidate.CreditCode, formerNames: [], aliases: [], englishNames: [],
  brands: [], officialDomains: [], registeredAddress: candidate.Address, parentLegalName: null,
  subsidiaryLegalNames: [],
};
const cachedProfile = {
  industry: '专用设备制造业', region: '上海', company_type: '有限责任公司', founded_year: 2020,
  registered_capital: '5000万元人民币', legal_representative: '张三', website: 'https://www.example.cn',
  employee_range: '100-499', risk_summary: null, collected_at: now.toISOString(),
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('CompanyProfileService', () => {
  let database: DatabaseSync;
  let profiles: ProfileRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    profiles = new ProfileRepository(database);
  });

  afterEach(() => database.close());

  it('normalizes only NFKC, whitespace and ASCII case without stripping legal suffixes', () => {
    expect(normalizeLegalName('  ＡB c 制造 有限公司  ')).toBe('abc制造有限公司');
    expect(normalizeLegalName('测试制造有限公司')).not.toBe(normalizeLegalName('测试制造'));
  });

  it('returns a unique fresh cached profile without calling QCC', async () => {
    profiles.upsert({ identity, normalizedLegalName: normalizeLegalName(identity.legalName), basicProfile: cachedProfile, collectedAt: now.toISOString() });
    let calls = 0;
    const service = new CompanyProfileService({ call: async () => { calls += 1; throw new Error('network'); } }, profiles, {
      profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now,
    });

    const result = await service.get(' 测试制造有限公司 ');

    expect(result).toMatchObject({ sourceStatus: 'completed', cacheHit: true, basicProfile: { industry: '专用设备制造业' } });
    expect(result.candidates).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('uses regionHint to select one of multiple fresh same-name cache entries', async () => {
    profiles.upsert({ identity, normalizedLegalName: normalizeLegalName(identity.legalName), basicProfile: cachedProfile, collectedAt: now.toISOString() });
    profiles.upsert({
      identity: { ...identity, creditCode: '91310000TEST000002', registeredAddress: '北京市海淀区测试路2号' },
      normalizedLegalName: normalizeLegalName(identity.legalName),
      basicProfile: { ...cachedProfile, region: '北京' },
      collectedAt: now.toISOString(),
    });
    let calls = 0;
    const service = new CompanyProfileService({ call: async () => { calls += 1; throw new Error('network'); } }, profiles, {
      profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now,
    });

    const result = await service.get(identity.legalName, '北京');

    expect(result).toMatchObject({
      sourceStatus: 'completed', cacheHit: true,
      candidates: [{ creditCode: '91310000TEST000002' }],
      basicProfile: { region: '北京' },
    });
    expect(result.candidates[0].matchReason).not.toMatch(/30/);
    expect(calls).toBe(0);
  });

  it('returns multiple candidates without fetching or guessing a profile', async () => {
    let calls = 0;
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        calls += 1;
        expect(tool).toBe('get_company_by_query');
        return { Data: [candidate, { ...candidate, Name: '测试制造科技有限公司', CreditCode: '91310000TEST000002' }] };
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get('测试制造');

    expect(result).toMatchObject({ sourceStatus: 'completed', cacheHit: false, basicProfile: null });
    expect(result.candidates).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it('does not generate a profile for one non-exact legal-name candidate', async () => {
    let calls = 0;
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        calls += 1;
        expect(tool).toBe('get_company_by_query');
        return { Data: [candidate] };
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get('测试制造');

    expect(result).toMatchObject({ sourceStatus: 'completed', basicProfile: null, cacheHit: false });
    expect(result.candidates).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('returns a failed business result after exactly two outer attempts', async () => {
    let calls = 0;
    const service = new CompanyProfileService({ call: async () => { calls += 1; throw new Error('unavailable'); } }, profiles, {
      profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now,
    });

    const result = await service.get('测试制造有限公司');

    expect(result).toEqual({
      sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
      message: '企查查暂不可用，请稍后重试',
    });
    expect(calls).toBe(2);
  });

  it('maps, caches and then reuses a unique QCC profile', async () => {
    let calls = 0;
    const inputs: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const gateway = {
      call: async (_server: string, tool: string, input: Record<string, unknown>) => {
        calls += 1;
        inputs.push({ tool, input });
        if (tool === 'get_company_by_query') return { Data: [candidate] };
        if (tool === 'get_company_registration_info') return { Data: {
          ...candidate, Province: '上海', EconKind: '有限责任公司', StartDate: '2020-03-04',
          RegistCapi: '5000万元人民币', OperName: '张三', Industry: '专用设备制造业',
          FormerNames: [], EnglishNames: [], ParentLegalName: null, SubsidiaryLegalNames: [],
        } };
        if (tool === 'get_company_profile') return { Data: {
          Name: candidate.Name, ShortNames: ['测试制造'], Brands: ['测试牌'], Industry: '专用设备制造业',
          EmployeeRange: '100-499', Website: 'https://www.example.cn',
        } };
        if (tool === 'get_contact_info') return { Data: { Website: 'https://www.example.cn' } };
        if (tool === 'get_company_risk_scan') return { Data: { Summary: '未发现明显经营异常' } };
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const service = new CompanyProfileService(gateway, profiles, {
      profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now,
    });

    const first = await service.get(candidate.Name, '上海');
    const callsAfterFirst = calls;
    const second = await service.get(candidate.Name, '上海');

    expect(first).toMatchObject({
      sourceStatus: 'completed', cacheHit: false,
      candidates: [{ legalName: candidate.Name, creditCode: candidate.CreditCode }],
      basicProfile: { foundedYear: 2020, website: 'https://www.example.cn', riskSummary: '未发现明显经营异常' },
    });
    expect(second).toMatchObject({ sourceStatus: 'completed', cacheHit: true });
    expect(calls).toBe(callsAfterFirst);
    expect(inputs).toEqual([
      { tool: 'get_company_by_query', input: { searchKey: candidate.Name } },
      { tool: 'get_company_registration_info', input: { searchKey: candidate.CreditCode } },
      { tool: 'get_company_profile', input: { searchKey: candidate.CreditCode } },
      { tool: 'get_contact_info', input: { searchKey: candidate.CreditCode } },
      { tool: 'get_company_risk_scan', input: { searchKey: candidate.CreditCode } },
    ]);
  });

  it('returns a failed business result when a required mapped detail has an unsupported shape', async () => {
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        if (tool === 'get_company_by_query') return { Data: [candidate] };
        if (tool === 'get_company_registration_info') return { changed: true };
        return { Data: {} };
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    await expect(service.get(candidate.Name)).resolves.toEqual({
      sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
      message: '企查查暂不可用，请稍后重试',
    });
  });

  it('maps the real QCC Chinese response shape without retaining raw payloads', async () => {
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        if (tool === 'get_company_by_query') return {
          企业信息: { 企业名称: candidate.Name, 统一社会信用代码: candidate.CreditCode },
          匹配结果: '精确匹配',
          摘要: '查询摘要',
          检索关键字: candidate.Name,
        };
        if (tool === 'get_company_registration_info') return {
          企业名称: candidate.Name,
          统一社会信用代码: candidate.CreditCode,
          登记状态: '存续',
          注册地址: candidate.Address,
          所属地区: '上海',
          企业类型: '有限责任公司',
          成立日期: '2020-03-04',
          注册资本: '5000万元人民币',
          法定代表人: '张三',
          国标行业: '专用设备制造业',
        };
        if (tool === 'get_company_profile') return {
          企业名称: candidate.Name,
          企查查行业: '专用设备制造业',
          简介: '测试简介',
        };
        if (tool === 'get_contact_info') return {
          企业名称: candidate.Name,
          联系方式信息: { 网址: [{ 网址: 'https://www.example.cn', 是否是官网: '是' }] },
        };
        if (tool === 'get_company_risk_scan') return {
          企业名称: candidate.Name,
          摘要: '未发现明显经营异常',
          有记录因子数: 0,
          无记录因子数: 35,
        };
        throw new Error(`unexpected tool ${tool}`);
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get(candidate.Name, '上海');

    expect(result).toMatchObject({
      sourceStatus: 'completed',
      candidates: [{ legalName: candidate.Name, creditCode: candidate.CreditCode, matchReason: '精确匹配' }],
      basicProfile: {
        industry: '专用设备制造业', region: '上海', companyType: '有限责任公司', foundedYear: 2020,
        website: 'https://www.example.cn', riskSummary: '未发现明显经营异常',
      },
    });
  });

  it.each([
    ['qcc-real-company-registration-mismatch.json', 'get_company_registration_info'],
    ['qcc-real-company-registration-identity-only.json', 'get_company_registration_info'],
    ['qcc-real-company-profile-explanation.json', 'get_company_profile'],
    ['qcc-real-contact-explanation.json', 'get_contact_info'],
    ['qcc-real-risk-explanation.json', 'get_company_risk_scan'],
    ['qcc-real-risk-item-explanation.json', 'get_company_risk_scan'],
  ] as const)('fails without caching when %s violates the %s contract', async (invalidFile, invalidTool) => {
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        if (tool === 'get_company_by_query') return fixture('qcc-real-company-search.json');
        if (tool === invalidTool) return fixture(invalidFile);
        if (tool === 'get_company_registration_info') return fixture('qcc-real-company-registration.json');
        if (tool === 'get_company_profile') return fixture('qcc-real-company-profile.json');
        if (tool === 'get_contact_info') return { Data: { Website: 'https://www.example.cn' } };
        if (tool === 'get_company_risk_scan') return { Data: { Summary: '未发现明显经营异常' } };
        throw new Error(`unexpected tool ${tool}`);
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get(candidate.Name);

    expect(result).toMatchObject({ sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false });
    expect(profiles.findFreshByNormalizedName(normalizeLegalName(candidate.Name), now, 30)).toEqual([]);
  });

  it('maps and caches a substantive Chinese risk factor instead of treating its presence as evidence', async () => {
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        if (tool === 'get_company_by_query') return fixture('qcc-real-company-search.json');
        if (tool === 'get_company_registration_info') return fixture('qcc-real-company-registration.json');
        if (tool === 'get_company_profile') return fixture('qcc-real-company-profile.json');
        if (tool === 'get_contact_info') return { Data: { Website: 'https://www.example.cn' } };
        if (tool === 'get_company_risk_scan') return fixture('qcc-real-risk-valid.json');
        throw new Error(`unexpected tool ${tool}`);
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get(candidate.Name);

    expect(result).toMatchObject({
      sourceStatus: 'completed',
      basicProfile: { riskSummary: expect.stringContaining('脱敏风险项') },
    });
    expect(profiles.findFreshByNormalizedName(normalizeLegalName(candidate.Name), now, 30)).toHaveLength(1);
  });

  it('maps and caches the sanitized real QCC risk-factor field combination', async () => {
    const service = new CompanyProfileService({
      call: async (_server: string, tool: string) => {
        if (tool === 'get_company_by_query') return fixture('qcc-real-company-search.json');
        if (tool === 'get_company_registration_info') return fixture('qcc-real-company-registration.json');
        if (tool === 'get_company_profile') return fixture('qcc-real-company-profile.json');
        if (tool === 'get_contact_info') return { Data: { Website: 'https://www.example.cn' } };
        if (tool === 'get_company_risk_scan') return fixture('qcc-real-risk-factor-valid.json');
        throw new Error(`unexpected tool ${tool}`);
      },
    }, profiles, { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 18, now: () => now });

    const result = await service.get(candidate.Name);

    expect(result).toMatchObject({
      sourceStatus: 'completed',
      basicProfile: { riskSummary: expect.stringContaining('经营异常') },
    });
    expect(profiles.findFreshByNormalizedName(normalizeLegalName(candidate.Name), now, 30)).toHaveLength(1);
  });
});
