import type { ZohoContactsOutput } from '../contracts/zoho-contact.js';

function safe(value: string | null | undefined): string {
  if (!value) return '未提供';
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/[\\`*_{}\[\]()#+.!|<>~-]/gu, '\\$&').trim() || '未提供';
}

function confirmationCode(connectionId: string, accountId: string): string {
  const json = JSON.stringify({ connection_id: connectionId, account_id: accountId });
  const longest = Math.max(0, ...[...json.matchAll(/`+/gu)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${json}${fence}`;
}

/** Deterministic, complete display; record IDs appear only where confirmation needs them. */
export function renderZohoContacts(result: ZohoContactsOutput): string {
  const lines = ['## Zoho CRM 联系人',
    `来源：Zoho CRM 实时只读记录；完整性：${result.complete ? '已完成选定连接的全部分页' : '未完成或需要确认' }。CRM 负责人仅表示系统内记录归属，联系人任职未另行核实。`];
  if (result.status === 'failed') lines.push('查询失败或 Zoho 不可用。');
  else if (result.status === 'partial') lines.push('仅返回已取得的部分结果，不能视为全部联系人。');
  else if (result.status === 'needs_confirmation') lines.push('需要确认客户记录后重新查询；本次未开始联系人全量获取。',
    '请将所有要保留的客户记录（包括已唯一匹配的记录）一并放入 zoho_account_records；后续仅查询显式选择的记录及连接。completed 表示该连接搜索已完成，本次尚未读取联系人。');
  for (const state of result.connections) {
    if (result.status === 'needs_confirmation') lines.push(`连接 ${safe(state.name)}：${state.status}；搜索${state.search_complete ? '已完成' : '未完成'}。`);
    if (state.error_code) lines.push(`连接 ${safe(state.name)}：${safe(state.error_code)}。`);
    if (state.candidates.length && (result.status === 'needs_confirmation' || state.status === 'needs_confirmation' || !state.search_complete)) {
      lines.push(`### ${safe(state.name)} 的客户候选`,
        '请确认后将对应确认参数放入 zoho_account_records：');
      for (const item of state.candidates) lines.push(`- 客户：${safe(item.company_name)}；客户负责人：${safe(item.account_owner?.name)}`,
        `  确认参数：${confirmationCode(state.connection_id, item.account_id)}`);
    }
  }
  if (!result.companies.length && result.status === 'completed') lines.push('未找到匹配客户或关联联系人。');
  for (const company of result.companies) {
    lines.push(`### ${safe(company.company_name)}（${safe(result.connections.find(state => state.connection_id === company.connection_id)?.name ?? company.connection_id)}）`,
      `客户负责人：${safe(company.account_owner?.name)}`, `${result.complete ? '关联联系人' : '已获取联系人'}：${company.contacts.length} 人`);
    if (!company.contacts.length) {
      lines.push(result.complete ? '该客户没有关联联系人。' : '本次未获取到联系人，不能确认该客户没有联系人。');
      continue;
    }
    lines.push('| 姓名 | 职位 | 联系人负责人 |', '| --- | --- | --- |');
    for (const contact of company.contacts) lines.push(`| ${safe(contact.name)} | ${safe(contact.title)} | ${safe(contact.contact_owner?.name)} |`);
  }
  if (result.warnings.length) lines.push(`警告：${result.warnings.map(safe).join('、')}`);
  return lines.join('\n');
}
