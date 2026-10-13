import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../../src/index.js';
import { loadConfig } from '../../src/config.js';
import type { GraphClient } from '../../src/contacts/graph-client.js';

export const queryConfig = (enabled: boolean) => loadConfig({ PORT: '3000', PUBLIC_MCP_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://example.com', SQLITE_PATH: ':memory:', QCC_MCP_COMPANY_URL: 'https://example.com/company',
  QCC_MCP_RISK_URL: 'https://example.com/risk', QCC_MCP_IPR_URL: 'https://example.com/ipr', QCC_MCP_OPERATION_URL: 'https://example.com/operation',
  QCC_API_KEY: 'fake', DOUBAO_SEARCH_API_URL: 'https://example.com/search', DOUBAO_SEARCH_API_KEY: 'fake',
  ARK_API_URL: 'https://example.com/ark', ARK_MODEL: 'fake', ARK_CREDENTIAL: 'fake',
  CONTACT_GRAPH_ENABLED: String(enabled), CONTACT_GRAPH_BIN: '/synthetic/contact-graph', CONTACT_GRAPH_SQLITE_PATH: '/synthetic/graph.sqlite',
  ZOHO_CONNECTIONS: 'crm_a', ZOHO_CRM_A_NAME: '合成连接', ZOHO_CRM_A_REGION: 'CN',
  ZOHO_CRM_A_CLIENT_ID: 'fake', ZOHO_CRM_A_CLIENT_SECRET: 'fake', ZOHO_CRM_A_REFRESH_TOKEN: 'fake' });

export async function queryRuntime(graph: GraphClient, enabled: boolean) {
  const runtime = createApplication(queryConfig(enabled), { graphClient: graph,
    logSink: { write: () => undefined }, verifyZohoPatch: async () => undefined,
    searchClient: { search: async () => [], searchWeb: async () => [] },
    contactExtractor: { extract: async () => ({ contacts: [], selection: { totalPages: 0, includedPages: 0, textTruncated: false } }) },
    zohoClient: { searchAccountsPage: async () => ({ accounts: [{ account_id: 'a', company_name: '合成公司', account_owner: null }], moreRecords: false }),
      getAccount: async () => ({ account_id: 'a', company_name: '合成公司', account_owner: null }),
      getContactsPage: async () => ({ contacts: [{ record_id: 'p', name: '合成人员', title: '经理', modified_at: null, contact_owner: null }], moreRecords: false, nextPageToken: null }),
      close: async () => undefined } });
  const listener = await runtime.listen(0, '127.0.0.1');
  const client = new Client({ name: 'synthetic-zoho-graph', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  const token = runtime.tokenService.create('sales');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return { runtime, client, query: () => client.callTool({ name: 'discover_contacts', arguments: { query: '合成公司', source: 'zoho' } }) };
}

