import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const gateway = {
      call: async (_server: string, tool: string) => {
        calls += 1;
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
});
