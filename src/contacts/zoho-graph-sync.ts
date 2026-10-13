import { randomUUID } from 'node:crypto';
import { maxGraphFrameBytes, serializeGraphRequest, type GraphClient } from './graph-client.js';
import type { ZohoCompany, ZohoContactsOutput } from '../contracts/zoho-contact.js';

interface SyncSummary { created: number; updated: number; unchanged: number; archived: number; entity_ids: string[] }
type Indexer = { index(id: string, version: number): unknown };

function companyFields(company: ZohoCompany): ZohoCompany {
  return { connection_id: company.connection_id, account_id: company.account_id, company_name: company.company_name,
    account_owner: company.account_owner && { id: company.account_owner.id, name: company.account_owner.name }, contacts: [] };
}

export class ZohoGraphSync {
  constructor(private readonly graph: GraphClient, private readonly indexer?: Indexer) {}

  async sync(result: ZohoContactsOutput, actor: string): Promise<SyncSummary> {
    const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0, archived: 0, entity_ids: [] };
    if (!['completed', 'partial'].includes(result.status) || !result.companies.length) return summary;
    let companies: ZohoCompany[] = [];
    let operationId = randomUUID();
    let failed = 0; let oversized = 0; let committed = 0;
    const payload = (items: ZohoCompany[]) => ({ operation_id: operationId, actor, collected_at: result.collected_at, companies: items });
    // Reserve more bytes than any numeric g_<nextId> can use, including concurrent requests.
    const fits = (items: ZohoCompany[]) => Buffer.byteLength(serializeGraphRequest('g_' + '9'.repeat(32),
      'sync_zoho_contacts', payload(items)), 'utf8') <= maxGraphFrameBytes;
    const flush = async () => {
      if (!companies.length) return;
      try {
        const saved = await this.graph.request<SyncSummary>('sync_zoho_contacts', payload(companies), AbortSignal.timeout(30_000));
        for (const key of ['created', 'updated', 'unchanged', 'archived'] as const) summary[key] += saved[key];
        summary.entity_ids.push(...saved.entity_ids); committed++;
      } catch { failed++; }
      companies = []; operationId = randomUUID();
    };
    for (const source of result.companies) {
      const company = companyFields(source);
      if (!source.contacts.length) {
        if (!fits([...companies, company])) await flush();
        if (fits([company])) companies.push(company); else oversized++;
        continue;
      }
      for (const raw of source.contacts) {
        const contact = { record_id: raw.record_id, name: raw.name, title: raw.title, modified_at: raw.modified_at,
          contact_owner: raw.contact_owner && { id: raw.contact_owner.id, name: raw.contact_owner.name } };
        const last = companies.at(-1);
        const candidate = last?.connection_id === company.connection_id && last.account_id === company.account_id
          ? [...companies.slice(0, -1), { ...last, contacts: [...last.contacts, contact] }]
          : [...companies, { ...company, contacts: [contact] }];
        if (fits(candidate)) { companies = candidate; continue; }
        await flush();
        const single = { ...company, contacts: [contact] };
        if (fits([single])) companies = [single]; else oversized++;
      }
    }
    await flush();
    summary.entity_ids = [...new Set(summary.entity_ids)];
    if (committed) result.warnings.push(`图谱同步：新增 ${summary.created}、更新 ${summary.updated}、未变化 ${summary.unchanged}；任职状态未核实（unknown）。`);
    const code = committed ? 'ZOHO_GRAPH_SYNC_PARTIAL' : 'ZOHO_GRAPH_SYNC_FAILED';
    if (summary.archived) result.warnings.push(`ZOHO_GRAPH_SYNC_PARTIAL：图谱同步 ${summary.archived} 条归档关联部分未同步。`);
    if (oversized) result.warnings.push(`${code}：图谱同步 ${oversized} 条记录请求帧过大，未同步；CRM 查询结果已保留。`);
    if (failed) result.warnings.push(`${code}：图谱同步 ${failed} 批失败或超时，未确认同步；CRM 查询状态和结果已保留，可重新查询。`);
    if (this.indexer) {
      for (const id of summary.entity_ids) {
        try {
          const detail = await this.graph.request<{ entity?: { label?: string }; index_status?: string; index_content_version?: number } | null>(
            'get_contact', { entity_id: id }, AbortSignal.timeout(30_000));
          if (detail?.entity?.label === 'Person' && detail.index_status === 'unindexed' && detail.index_content_version) {
            await this.indexer.index(id, detail.index_content_version);
          }
        } catch { result.warnings.push('图谱同步已提交，向量索引调度失败；关键词查询仍可使用。'); }
      }
    }
    return summary;
  }
}
