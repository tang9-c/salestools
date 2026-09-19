import { describe, it, expect } from 'vitest';
import { mapCompanyDetails, validateQccPayload } from '../src/upstream/qcc/mapper.js';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CompanyProfileService } from '../src/upstream/qcc/profile-service.js';
import { UpstreamError } from '../src/orchestration/retry.js';

const subject = { legalName: '测试机器人有限公司', creditCode: '91310000TEST000001', status: null, registeredAddress: null, matchReason: '精确匹配' };
const registration = { 企业名称: subject.legalName, 统一社会信用代码: subject.creditCode, 登记状态: '存续', 国标行业: { 门类: '制造业', 大类: '', 中类: '', 小类: '' } };

describe('QCC optional profile fields', () => {
  it('reports format failures without presenting them as temporary connectivity failures', async () => {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    try {
      const service = new CompanyProfileService({ call: async () => { throw new UpstreamError('qcc', 'INVALID_RESPONSE', 'sensitive raw upstream body'); } }, new ProfileRepository(database), { profileCacheTtlDays: 30, maxQccCalls: 8, maxTotalCalls: 32 });
      const result = await service.get(subject.legalName);
      expect(result).toMatchObject({ sourceStatus: 'failed', message: '企查查返回的数据格式暂不兼容，请检查适配器' });
      expect(JSON.stringify(result)).not.toContain('sensitive');
    } finally { database.close(); }
  });
  it.each([registration.国标行业, '', null, { 新分类: ['装备'] }])('accepts auxiliary industry representation %j without losing the subject', industry => {
    const mapped = mapCompanyDetails(subject,
      { ...registration, 国标行业: industry, 注册资本: null, 人员规模: '' },
      { 企业名称: subject.legalName, 简介: '研发机器人', 企查查行业: null },
      { Data: { Website: 'https://example.cn' } },
      { Data: { Summary: '未发现明显经营异常' } }, new Date('2026-09-19T00:00:00Z'));
    expect(mapped.identity.legalName).toBe(subject.legalName);
    expect(mapped.basicProfile.industry).toBe(industry === registration.国标行业 ? '制造业' : null);
    expect(mapped.basicProfile.registered_capital).toBeNull();
  });

  it('still rejects another credit code despite compatible auxiliary fields', () => {
    expect(() => validateQccPayload('get_company_registration_info', {
      ...registration, 统一社会信用代码: '91310000TEST000002',
    }, subject)).toThrow(/credit code|subject/i);
  });
});
