import { describe, expect, it } from 'vitest';
import * as contracts from '../src/contracts/zoho-contact.js';
import { GetContactsInputSchema, GetContactsOutputSchema } from '../src/mcp/tool-schemas.js';

const contact = { record_id: '1', name: '张三', title: null, contact_owner: null, modified_at: null };
const company = { connection_id: 'crm_a', account_id: 'a1', company_name: '公司', account_owner: null,
  contacts: Array.from({ length: 11 }, (_, i) => ({ ...contact, record_id: String(i) })) };

describe('Zoho contracts', () => {
  it('retains more than ten contacts and nullable owner fields', () => {
    const result = contracts.ZohoContactsOutputSchema.parse({ status: 'completed', complete: true,
      connections: [{ connection_id: 'crm_a', name: '团队', status: 'completed', search_complete: true, candidates: [], error_code: null }],
      companies: [company], warnings: [], collected_at: '2026-10-12T00:00:00Z' });
    expect(result.companies[0].contacts).toHaveLength(11);
  });
  it.each(['email', 'phone'])('rejects contact %s and owner extra fields', field => {
    expect(contracts.ZohoContactSchema.safeParse({ ...contact, [field]: 'private' }).success).toBe(false);
    expect(contracts.ZohoContactSchema.safeParse({ ...contact, contact_owner: { id: 'u', name: '负责人', [field]: 'private' } }).success).toBe(false);
  });
  it('retains the web contract without a ten-person ceiling', () => {
    const webContact = { name: '张三', title: '经理', source_url: 'https://example.com/team', published_at: null };
    const web = { companies: [{ company_name: '公司', contacts: Array.from({ length: 10 }, () => webContact), historical_contacts: [] }],
      warnings: [], collected_at: '2026-10-12T00:00:00.000Z' };
    expect(GetContactsOutputSchema.safeParse(web).success).toBe(true);
    expect(GetContactsOutputSchema.safeParse({ ...web, companies: [{ ...web.companies[0], contacts: [...web.companies[0].contacts, webContact] }] }).success).toBe(true);
  });
  it('defaults web input while allowing explicit Zoho selection', () => {
    expect(GetContactsInputSchema.parse({ query: ' 公司 ', region_hint: ' 中国 ' })).toEqual({ query: '公司', region_hint: '中国', source: 'web' });
    expect(GetContactsInputSchema.safeParse({ query: '公司', source: 'zoho', zoho_accounts: ['crm_a'],
      zoho_account_records: [{ connection_id: 'crm_a', account_id: 'a' }] }).success).toBe(true);
  });
  it.each([
    { zoho_accounts: ['crm_a'] },
    { source: 'zoho', zoho_accounts: ['crm_a', 'crm_a'] },
    { source: 'all', zoho_accounts: ['crm_a'], zoho_account_records: [{ connection_id: 'crm_b', account_id: 'a' }] },
    { source: 'zoho', zoho_account_records: [{ connection_id: 'crm_a', account_id: 'a' }, { connection_id: 'crm_a', account_id: 'a' }] },
    { source: 'zoho', zoho_accounts: ['CRM_A'] },
  ])('rejects invalid selection %j', selection => {
    expect(GetContactsInputSchema.safeParse({ query: '公司', ...selection }).success).toBe(false);
  });
});
