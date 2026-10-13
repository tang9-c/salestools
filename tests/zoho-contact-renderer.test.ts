import { describe, expect, it } from 'vitest';
import { renderZohoContacts } from '../src/contacts/zoho-contact-renderer.js';
import type { ZohoContactsOutput } from '../src/contracts/zoho-contact.js';

const base: ZohoContactsOutput = { status: 'completed', complete: true,
  connections: [{ connection_id: 'crm_a', name: '业务A', status: 'completed', search_complete: true, candidates: [], error_code: null }],
  companies: [], warnings: [], collected_at: '2026-10-12T00:00:00.000Z' };

describe('Zoho contact Markdown', () => {
  it('shows every contact including the 201st and each owner without internal IDs', () => {
    const result: ZohoContactsOutput = { ...base, companies: [{ connection_id: 'crm_a', account_id: '10001',
      company_name: '测试制造', account_owner: { id: '900', name: '客户经理' },
      contacts: Array.from({ length: 201 }, (_, index) => ({ record_id: String(index + 1),
        name: `姓名${index + 1}`, title: index ? null : '研发总监',
        contact_owner: { id: '901', name: '联系人经理' }, modified_at: null })) }] };
    const text = renderZohoContacts(result);
    expect(text).toContain('客户负责人：客户经理');
    expect(text).toContain('姓名201');
    expect(text).toContain('联系人经理');
    expect((text.match(/\| 姓名\d+ \|/gu) ?? [])).toHaveLength(201);
    expect(text).not.toMatch(/10001|record_id|account_id|\| 900 \|/u);
  });

  it('renders empty, candidate, partial and failed states truthfully', () => {
    expect(renderZohoContacts(base)).toContain('未找到');
    const candidate = { ...base, status: 'needs_confirmation' as const, complete: false,
      connections: [{ ...base.connections[0]!, status: 'needs_confirmation' as const,
        candidates: [{ account_id: '123', company_name: '测试制造', account_owner: null }] }] };
    expect(renderZohoContacts(candidate)).toMatch(/crm\\_a.*123/su);
    expect(renderZohoContacts({ ...base, status: 'partial', complete: false, warnings: ['ZOHO_DEADLINE_EXCEEDED'] })).toMatch(/部分|未完成/u);
    expect(renderZohoContacts({ ...base, status: 'failed', complete: false, warnings: ['ZOHO_UNAVAILABLE'] })).toMatch(/失败|不可用/u);
  });

  it('escapes pipes, line breaks and Markdown links in untrusted fields', () => {
    const text = renderZohoContacts({ ...base, companies: [{ connection_id: 'crm_a', account_id: '1',
      company_name: '[伪链接](https://bad.example)\n下一行', account_owner: { id: null, name: '甲|乙' },
      contacts: [{ record_id: '2', name: '张|三', title: '[点击](https://bad.example)\n总监',
        contact_owner: null, modified_at: null }] }] });
    expect(text).toContain('张\\|三');
    expect(text).toContain('甲\\|乙');
    expect(text).not.toContain('[点击](https://bad.example)');
    expect(text).not.toContain('\n总监');
  });
});
