import { createTestToken } from './helpers/token.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/index.js';
import { buildMcpServer, type McpServices } from '../src/mcp/tools.js';
import type { ZohoContactsOutput } from '../src/contracts/zoho-contact.js';
import { ZohoContactService } from '../src/contacts/zoho-contact-service.js';

const at = '2026-10-12T00:00:00.000Z';
const web = { companies: [{ companyName: '网页公司', contacts: [{ name: '网页人员', title: '经理', sourceUrl: 'https://example.com', publishedAt: null }], historicalContacts: [] }], warnings: [], collectedAt: at };
const zoho: ZohoContactsOutput = { status: 'completed', complete: true,
  connections: [{ connection_id: 'crm_a', name: '业务A', status: 'completed', search_complete: true, candidates: [], error_code: null }],
  companies: [{ connection_id: 'crm_a', account_id: '123', company_name: 'CRM公司', account_owner: { id: '9', name: '客户负责人' },
    contacts: [{ record_id: '456', name: 'CRM人员', title: '总监', contact_owner: { id: '10', name: '联系人负责人' }, modified_at: null }] }],
  warnings: [], collected_at: at };
const services = (extra: Partial<McpServices> = {}): McpServices => ({
  getCompanyProfile: async () => ({ sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false, message: 'x' }),
  submitAssessment: async () => ({ assessmentId: 'x', status: 'processing', estimatedMinutes: '5-40', cacheHit: false }),
  getAssessmentStatus: async () => ({ assessmentId: 'x', status: 'failed', message: 'x' }),
  getAssessmentReport: async () => ({ assessmentId: 'x', status: 'failed', message: 'x' }),
  getContacts: async () => web,
  askCompany: async () => ({ status: 'failed', legalName: 'x', markdown: '', usedFreshResearch: false, collectedAt: null, sources: [] }),
  ...extra,
});
async function call(s: McpServices, args: Record<string, unknown>) {
  const server = buildMcpServer(s);
  const client = new Client({ name: 'zoho-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { return await client.callTool({ name: 'discover_contacts', arguments: args }); }
  finally { await client.close(); await server.close(); }
}

it('keeps structured web output and renders readable text', async () => {
  const result = await call(services(), { query: '网页公司' });
  expect(result.structuredContent).toEqual({ companies: [{ company_name: '网页公司', contacts: [{ name: '网页人员', title: '经理', source_url: 'https://example.com', published_at: null }], historical_contacts: [] }], warnings: [], collected_at: at });
  expect(result.content[0]).toEqual({ type: 'text', text: [
    '## 公开网页联系人',
    '来源：公开网页；历史证据不代表已离职。',
    '### 网页公司',
    '- 网页人员：经理（来源 https://example\\.com；日期 未知）',
  ].join('\n') });
});

it('returns Zoho only with empty web base and full structured IDs', async () => {
  const result = await call(services({ zohoContacts: { get: async () => zoho, connectionIds: ['crm_a'] } }), { query: 'CRM公司', source: 'zoho', zoho_accounts: ['crm_a'], zoho_account_records: [{ connection_id: 'crm_a', account_id: '123' }] });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ companies: [], zoho: { companies: [{ account_id: '123', contacts: [{ record_id: '456' }] }] } });
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('CRM人员') });
  expect(JSON.stringify(result.content)).not.toContain('456');
});

it('reuses exact candidate IDs copied from text in a successful second tool call', async () => {
  const candidate: ZohoContactsOutput = { ...zoho, status: 'needs_confirmation', complete: false,
    connections: [{ ...zoho.connections[0]!, status: 'needs_confirmation',
      candidates: [{ account_id: '123', company_name: 'CRM公司', account_owner: null }] }], companies: [] };
  const s = services({ zohoContacts: { connectionIds: ['crm_a'],
    get: async input => input.accountRecords?.[0]?.connectionId === 'crm_a'
      && input.accountRecords[0]?.accountId === '123' ? zoho : candidate } });
  const first = await call(s, { query: 'CRM公司', source: 'zoho' });
  const text = first.content[0]?.type === 'text' ? first.content[0].text : '';
  const raw = text.match(/确认参数：`(\{"connection_id":"[^"]+","account_id":"[^"]+"\})`/u)?.[1];
  expect(raw).toBeDefined();
  const chosen = JSON.parse(raw!) as { connection_id: string; account_id: string };
  expect(chosen).toEqual({ connection_id: 'crm_a', account_id: '123' });
  const second = await call(s, { query: 'CRM公司', source: 'zoho',
    zoho_accounts: [chosen.connection_id], zoho_account_records: [chosen] });
  expect(second.isError).not.toBe(true);
  expect(second.structuredContent).toMatchObject({ zoho: { status: 'completed',
    companies: [{ contacts: [{ name: 'CRM人员' }] }] } });
});

it('carries an exact match and an ambiguous connection from rendered confirmation into a real tool retry', async () => {
  const account = (id: string, name: string) => ({ account_id: id, company_name: name, account_owner: null });
  const records = { a: [account('1', 'Acme')], b: [account('2', 'Acme Holdings'), account('3', 'Acme Manufacturing')] };
  const reads: string[] = [];
  const service = new ZohoContactService({
    searchAccountsPage: async id => ({ accounts: records[id as keyof typeof records], moreRecords: false }),
    getAccount: async (id, recordId) => records[id as keyof typeof records].find(record => record.account_id === recordId)!,
    getContactsPage: async (id, recordId) => {
      reads.push(`${id}:${recordId}`);
      return { contacts: [{ record_id: '99', name: `Person ${id}`, title: null, contact_owner: null, modified_at: null }], moreRecords: false, nextPageToken: null };
    },
  }, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const s = services({ zohoContacts: { connectionIds: ['a', 'b'], get: input => service.get(input) } });
  const first = await call(s, { query: 'Acme', source: 'zoho' });
  expect(reads).toEqual([]);
  const text = first.content[0]?.type === 'text' ? first.content[0].text : '';
  const choices = [...text.matchAll(/确认参数：`(\{"connection_id":"[^"]+","account_id":"[^"]+"\})`/gu)].map(match => JSON.parse(match[1]!));
  expect(choices).toEqual([{ connection_id: 'a', account_id: '1' }, { connection_id: 'b', account_id: '2' }, { connection_id: 'b', account_id: '3' }]);
  expect(text).toContain('连接 A：completed');
  expect(text).toContain('连接 B：needs_confirmation');
  expect(text).toContain('后续仅查询显式选择的记录及连接');
  const second = await call(s, { query: 'Acme', source: 'zoho', zoho_account_records: choices.filter(choice => choice.account_id !== '3') });
  expect(second.structuredContent).toMatchObject({ zoho: { status: 'completed', complete: true,
    companies: [{ connection_id: 'a', contacts: [{ name: 'Person a' }] }, { connection_id: 'b', contacts: [{ name: 'Person b' }] }] } });
  expect(reads).toEqual(['a:1', 'b:2']);
});

it('preserves web result when Zoho fails and rejects unknown connection', async () => {
  const s = services({ zohoContacts: { get: async () => { throw new Error('secret token'); }, connectionIds: ['crm_a'] } });
  const combined = await call(s, { query: '公司', source: 'all' });
  expect(combined.structuredContent).toMatchObject({ companies: [{ company_name: '网页公司' }], zoho: { status: 'failed', complete: false } });
  expect(JSON.stringify(combined)).not.toContain('secret token');
  const unknown = await call(s, { query: '公司', source: 'zoho', zoho_accounts: ['other'] });
  expect(unknown.isError).toBe(true);
});

it('preserves Zoho when the public web source fails', async () => {
  const result = await call(services({ getContacts: async () => { throw new Error('web private details'); },
    zohoContacts: { get: async () => zoho, connectionIds: ['crm_a'] } }), { query: 'CRM公司', source: 'all' });
  expect(result.structuredContent).toMatchObject({ companies: [], warnings: ['WEB_SOURCE_FAILED'],
    zoho: { complete: true, companies: [{ contacts: [{ name: 'CRM人员' }] }] } });
  expect(JSON.stringify(result)).not.toContain('web private details');
});

it('includes historical web evidence in all-source text', async () => {
  const history = { name: '历史人员', title: '技术经理', sourceUrl: 'https://example.com/old',
    publishedAt: null, firstSeenAt: '2025-01-01T00:00:00.000Z', lastSeenAt: '2025-02-01T00:00:00.000Z',
    status: 'historical_evidence' as const };
  const result = await call(services({ getContacts: async () => ({ ...web, companies: [{ ...web.companies[0]!, historicalContacts: [history] }] }),
    zohoContacts: { get: async () => zoho, connectionIds: ['crm_a'] } }), { query: '公司', source: 'all' });
  expect(result.structuredContent).toMatchObject({ companies: [{ historical_contacts: [{ name: '历史人员' }] }] });
  expect(JSON.stringify(result.content)).toContain('历史人员');
});

it('reports Zoho unavailable without configuration, while web still works', async () => {
  const result = await call(services(), { query: '公司', source: 'zoho' });
  expect(result.structuredContent).toMatchObject({ companies: [], zoho: { status: 'failed', complete: false, warnings: ['ZOHO_UNAVAILABLE'] } });
  expect((await call(services(), { query: '公司' })).structuredContent).not.toHaveProperty('zoho');
});

it('uses the authenticated HTTP MCP path, waits for patch check, and closes the adapter', async () => {
  const config = loadConfig({ PORT: '3000', PUBLIC_MCP_HOST: '127.0.0.1', ALLOWED_ORIGINS: 'https://example.com',
    SQLITE_PATH: ':memory:', QCC_MCP_COMPANY_URL: 'https://example.com/qcc/company',
    QCC_MCP_RISK_URL: 'https://example.com/qcc/risk', QCC_MCP_IPR_URL: 'https://example.com/qcc/ipr',
    QCC_MCP_OPERATION_URL: 'https://example.com/qcc/operation', QCC_API_KEY: 'fake',
    DOUBAO_SEARCH_API_URL: 'https://example.com/search', DOUBAO_SEARCH_API_KEY: 'fake',
    ARK_API_URL: 'https://example.com/ark', ARK_MODEL: 'fake', ARK_CREDENTIAL: 'fake',
    ZOHO_CONNECTIONS: 'crm_a', ZOHO_CRM_A_NAME: '业务A', ZOHO_CRM_A_REGION: 'CN',
    ZOHO_CRM_A_CLIENT_ID: 'fake', ZOHO_CRM_A_CLIENT_SECRET: 'fake', ZOHO_CRM_A_REFRESH_TOKEN: 'fake',
  });
  let checked = false; let closed = false;
  const runtime = createApplication(config, {
    now: () => new Date('2020-01-01T00:00:00.000Z'),
    logSink: { write: () => undefined },
    searchClient: { search: async () => [], searchWeb: async () => [] },
    contactExtractor: { extract: async () => ({ contacts: [], selection: { totalPages: 0, includedPages: 0, textTruncated: false } }) },
    verifyZohoPatch: async () => { checked = true; },
    zohoClient: {
      searchAccountsPage: async () => { expect(checked).toBe(true); return { accounts: [{ account_id: '123', company_name: 'CRM公司', account_owner: null }], moreRecords: false }; },
      getAccount: async () => ({ account_id: '123', company_name: 'CRM公司', account_owner: null }),
      getContactsPage: async () => ({ contacts: [{ record_id: '456', name: 'CRM人员', title: '总监', contact_owner: null, modified_at: null }], moreRecords: false, nextPageToken: null }),
      close: async () => { closed = true; },
    },
  });
  let client: Client | undefined;
  try {
    const listener = await runtime.listen(0, '127.0.0.1');
    const token = createTestToken(runtime.tokenService, 'sales');
    client = new Client({ name: 'zoho-http-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const response = await client.callTool({ name: 'discover_contacts', arguments: { query: 'CRM公司', source: 'zoho' } });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ companies: [], zoho: { complete: true, companies: [{ contacts: [{ name: 'CRM人员' }] }] } });
  } finally {
    await client?.close(); await runtime.close();
  }
  expect(closed).toBe(true);
  const degraded = createApplication(config, {
    logSink: { write: () => undefined },
    searchClient: { search: async () => [], searchWeb: async () => [] },
    contactExtractor: { extract: async () => ({ contacts: [], selection: { totalPages: 0, includedPages: 0, textTruncated: false } }) },
    verifyZohoPatch: async () => { throw new Error('private patch diagnostics'); },
  });
  let second: Client | undefined;
  try {
    const listener = await degraded.listen(0, '127.0.0.1');
    const token = createTestToken(degraded.tokenService, 'sales');
    second = new Client({ name: 'zoho-degraded-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await second.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const webResult = await second.callTool({ name: 'discover_contacts', arguments: { query: 'CRM公司' } });
    expect(webResult.isError).not.toBe(true);
    expect(webResult.structuredContent).not.toHaveProperty('zoho');
    const zohoResult = await second.callTool({ name: 'discover_contacts', arguments: { query: 'CRM公司', source: 'zoho' } });
    expect(zohoResult.structuredContent).toMatchObject({ zoho: { status: 'failed', warnings: ['ZOHO_UNAVAILABLE'] } });
    expect(JSON.stringify(zohoResult)).not.toContain('private patch diagnostics');
  } finally { await second?.close(); await degraded.close(); }
});

it('creates a bound user through the real admin route and projects owner identity per authenticated MCP request',async()=>{
  const {createHash}=await import('node:crypto');const key='A'.repeat(43);
  const config=loadConfig({PUBLIC_MCP_HOST:'127.0.0.1',ALLOWED_ORIGINS:'https://example.com',SQLITE_PATH:':memory:',
    TOKEN_ADMIN_KEY_SHA256:createHash('sha256').update(key).digest('hex'),
    QCC_MCP_COMPANY_URL:'https://example.com/company',QCC_MCP_RISK_URL:'https://example.com/risk',
    QCC_MCP_IPR_URL:'https://example.com/ipr',QCC_MCP_OPERATION_URL:'https://example.com/operation',QCC_API_KEY:'fake',
    DOUBAO_SEARCH_API_URL:'https://example.com/search',DOUBAO_SEARCH_API_KEY:'fake',
    ARK_API_URL:'https://example.com/ark',ARK_MODEL:'fake',ARK_CREDENTIAL:'fake',
    ZOHO_CONNECTIONS:'qx',ZOHO_QX_NAME:'QX',ZOHO_QX_REGION:'CN',ZOHO_QX_ORG_ID:'100',
    ZOHO_QX_CLIENT_ID:'fake',ZOHO_QX_CLIENT_SECRET:'fake',ZOHO_QX_REFRESH_TOKEN:'fake'});
  let actualOrg='100';const logs:string[]=[];
  const runtime=createApplication(config,{logSink:{write:line=>logs.push(line)},verifyZohoPatch:async()=>{},
    searchClient:{search:async()=>[],searchWeb:async()=>[]},
    zohoClient:{getOrganization:async()=>actualOrg,
      getUsersPage:async()=>({users:[{id:'9',email:'sales@example.com',status:'active',confirmed:true}],moreRecords:false}),
      searchAccountsPage:async()=>({accounts:[{account_id:'1',company_name:'CRM公司',account_owner:{id:'9',name:'甲'}}],moreRecords:false}),
      getAccount:async()=>({account_id:'1',company_name:'CRM公司',account_owner:{id:'9',name:'甲'}}),
      getContactsPage:async()=>({contacts:[{record_id:'2',name:'乙',title:null,modified_at:null,contact_owner:{id:'8',name:'乙'}}],moreRecords:false,nextPageToken:null}),
      close:async()=>{}}});
  let client:Client|undefined;
  try {
    const listener=await runtime.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const response=await fetch(base+'/admin/v1/tokens',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({userId:'sales',email:'Sales@Example.com',crm:'qx'})});
    expect(response.status).toBe(201);const {token}=await response.json();
    client=new Client({name:'identity-integration',version:'1'},{versionNegotiation:{mode:'auto'}});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const args={query:'CRM公司',source:'zoho'};
    const first=await client.callTool({name:'discover_contacts',arguments:args});
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({zoho:{companies:[{account_owner:{is_current_user:true},contacts:[{contact_owner:{is_current_user:false}}]}]}});
    actualOrg='200';
    const second=await client.callTool({name:'discover_contacts',arguments:args});
    expect(second.structuredContent).toMatchObject({zoho:{complete:true,companies:[{account_owner:{is_current_user:null}}],warnings:expect.arrayContaining([expect.stringContaining('CRM_IDENTITY_UNVERIFIED')])}});
    expect(logs.join('')).not.toContain(token);
  } finally {await client?.close();await runtime.close();}
});
