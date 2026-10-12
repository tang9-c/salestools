import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { AssessmentService } from '../src/orchestration/assessment-service.js';
import type { AssessmentRepository, AssessmentRecord } from '../src/db/assessment-repository.js';
import { buildMcpServer, type McpServices } from '../src/mcp/tools.js';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { registerContactTools } from '../src/mcp/contact-tools.js';
import { registerContactSearchTools } from '../src/mcp/contact-search-tools.js';
import { registerCompanyLinkTools } from '../src/mcp/company-link-tools.js';
import type { ContactSearch } from '../src/contacts/contact-search.js';
import { CODE as VALID_CODE, PROFILE } from './fixtures/company-context.js';
import type { CompanyDetail } from '../src/companies/company-context-types.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
const AT = '2026-10-12T00:00:00.000Z', CODE = '91310000MA1FL8XQ30';
async function connected(server: McpServer, run: (client: Client) => Promise<void>, actor?: string) {
  const client = new Client({ name: 'context-test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  if (actor) {
    const onmessage = b.onmessage!;
    b.onmessage = (message, extra) => onmessage(message, { ...extra, authInfo: { token: 'synthetic', clientId: actor, scopes: [] } });
  }
  await client.connect(a);
  try { await run(client); } finally { await client.close(); await server.close(); }
}
it('routes opt-in report updates using stored identity and time while retaining historical text', async () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const record = { assessmentId:id, status:'completed', creditCode:CODE, legalName:'测试装备有限公司',
    reportMarkdown:'# 原报告', overallOpportunity:'中', recommendedProduct:null,
    sourceStatus:{qcc:'completed',doubaoSearch:'completed',ark:'completed'},collectedAt:AT,completedAt:AT
  } as AssessmentRecord;
  const relatedUpdates = vi.fn(async () => ({ state:'partial' as const, warnings:['GRAPH_UNAVAILABLE'],
    since:AT,scope:['profile'],truncated:false,items:[{kind:'profile' as const,id:CODE,recorded_at:AT,label:'画像更新'}] }));
  const service = new AssessmentService({assessments:{get:()=>record} as unknown as AssessmentRepository,
    queue:{enqueue:()=>false},assessmentCacheTtlDays:30,now:()=>new Date(AT)});
  await connected(buildMcpServer({getAssessmentReport:input=>service.reportWithUpdates(input,{relatedUpdates})} as McpServices), async client => {
    const base = await client.callTool({name:'get_assessment_report',arguments:{assessment_id:id}});
    expect(base.isError).not.toBe(true); expect((base.structuredContent as Record<string,unknown> | undefined)?.generated_at).toBe(AT);
    expect(relatedUpdates).not.toHaveBeenCalled();
    const loaded = await client.callTool({name:'get_assessment_report',arguments:{assessment_id:id,include_related_updates:true}});
    expect(loaded.isError).not.toBe(true); expect(relatedUpdates).toHaveBeenCalledWith(CODE,AT,undefined);
    expect((loaded.structuredContent as Record<string,unknown> | undefined)?.related_updates).toEqual(await relatedUpdates());
    expect((loaded.structuredContent as Record<string,unknown> | undefined)?.markdown).toBe((base.structuredContent as Record<string,unknown> | undefined)?.markdown);
    relatedUpdates.mockRejectedValueOnce(new Error('unavailable'));
    const failedSource = await client.callTool({name:'get_assessment_report',arguments:{assessment_id:id,include_related_updates:true}});
    expect(failedSource.isError).not.toBe(true);
    expect((failedSource.structuredContent as Record<string,unknown> | undefined)?.related_updates).toMatchObject({state:'unavailable',items:[]});
    expect((failedSource.structuredContent as Record<string,unknown> | undefined)?.markdown).toBe((base.structuredContent as Record<string,unknown> | undefined)?.markdown);
    for (const status of ['processing','failed'] as const) {
      record.status=status; relatedUpdates.mockClear();
      const pending=await client.callTool({name:'get_assessment_report',arguments:{assessment_id:id,include_related_updates:true}});
      expect((pending.structuredContent as Record<string,unknown> | undefined)?.status).toBe(status);
      expect(pending.structuredContent).not.toHaveProperty('generated_at');
      expect(pending.structuredContent).not.toHaveProperty('related_updates');
      expect(relatedUpdates).not.toHaveBeenCalled();
    }
    expect(record.reportMarkdown).toBe('# 原报告');
  });
  record.status='completed';
  const abort = new AbortController(); abort.abort();
  await expect(service.reportWithUpdates({assessmentId:id,includeRelatedUpdates:true},{relatedUpdates},abort.signal)).rejects.toBeDefined();
});
it('keeps context pagination out of graph payload and defaults to no additional query', async () => {
  const request = vi.fn(async () => ({entity:{label:'Organization'},entity_id:'o1'}));
  const detail = vi.fn(async (): Promise<CompanyDetail> => ({state:'ok',warnings:[],link:{state:'unlinked',organization_id:'o1',credit_code:null,basis:null,version:0,candidates:[],warnings:[]},has_profile:false,report_count:null,latest_report_at:null,profile:null,latest_report:null,reports:{items:[],total:0,next_offset:null,complete:true}}));
  const server = new McpServer({name:'detail-test',version:'1'});
  registerContactTools(server,new ContactLibraryService({request} as unknown as GraphClient),{detail});
  await connected(server,async client=>{
    expect((await client.callTool({name:'get_contact',arguments:{entity_id:'o1'}})).isError).not.toBe(true);
    expect(detail).not.toHaveBeenCalled();
    const response=await client.callTool({name:'get_contact',arguments:{entity_id:'o1',evidence_offset:2,include_company_context:true,report_offset:10,report_limit:10}});
    expect(response.isError).not.toBe(true); expect((response.structuredContent as Record<string,unknown> | undefined)?.company_context).toMatchObject({link:{state:'unlinked'}});
    expect(request).toHaveBeenLastCalledWith('get_contact',{entity_id:'o1',evidence_offset:2});
    expect(detail).toHaveBeenCalledWith('o1',10,10);
  });
});

it('link_company enforces authenticated context and schemas, forwarding stable IDs for replay', async () => {
  const saved = {organization_id:'o1',credit_code:VALID_CODE,state:'confirmed' as const,version:1,
    identity_hash:'hash',organization_version:1,note:'人工确认',actor:'sales-a',updated_at:AT};
  const change = vi.fn(async () => saved);
  const input = {action:'confirm',organization_id:'o1',credit_code:VALID_CODE,operation_id:'retry-1',
    expected_link_version:0,expected_organization_version:1,note:'人工确认'};
  const server = new McpServer({name:'link-test',version:'1'}); registerCompanyLinkTools(server,{change});
  await connected(server,async client=>{
    expect((await client.callTool({name:'link_company',arguments:input})).isError).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
  const authenticated=new McpServer({name:'link-auth-test',version:'1'}); registerCompanyLinkTools(authenticated,{change});
  await connected(authenticated,async client=>{
    const first=await client.callTool({name:'link_company',arguments:input});
    expect(first.isError).not.toBe(true);
    const replay=await client.callTool({name:'link_company',arguments:input});
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect(change).toHaveBeenCalledWith(input,'sales-a');
    for(const invalid of [{...input,actor:'forged'},{...input,credit_code:'INVALID'},
      {...input,expected_organization_version:0},{...input,expected_link_version:-1},
      {...input,note:''},{...input,note:'字'.repeat(501)}]) {
      expect((await client.callTool({name:'link_company',arguments:invalid})).isError).toBe(true);
    }
    expect(change).toHaveBeenCalledTimes(2);
  },'sales-a');
});
for (const app of [undefined,{html:async()=>'<html>graph</html>'}]) it(`search enrichment preserves result on source failure (App=${!!app})`,async()=>{
  const output={items:[{entity_id:'o1',label:'Organization',name:'测试组织',reasons:['name_match']},
    {entity_id:'p1',label:'Person'}],total:12,mode_used:'keyword' as const,warnings:['original_warning']};
  const search=vi.fn(async()=>output),summaries=vi.fn(async()=>{throw new Error('offline');});
  const server=new McpServer({name:'search-context-test',version:'1'});
  registerContactSearchTools(server,{search} as unknown as ContactSearch,undefined,app,{summaries});
  await connected(server,async client=>{
    expect((await client.callTool({name:'search_contacts',arguments:{}})).structuredContent).toEqual(output);
    expect(summaries).not.toHaveBeenCalled();
    const result=await client.callTool({name:'search_contacts',arguments:{include_company_context:true}});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({total:12,mode_used:'keyword',warnings:['original_warning'],
      items:[{entity_id:'o1',reasons:['name_match'],company_context:{state:'unavailable'}},{entity_id:'p1'}]});
    expect(summaries).toHaveBeenCalledWith(['o1']);
    expect(search).toHaveBeenLastCalledWith({mode:'keyword',offset:0,limit:10});
  });
});
it('company profile overview needs opt-in and one successful subject, graph disabled retains six tools',async()=>{
  const basicProfile={industry:null,region:null,companyType:null,foundedYear:null,registeredCapital:null,
    legalRepresentative:null,website:null,employeeRange:null,riskSummary:null,collectedAt:AT};
  const candidate={legalName:'测试公司',creditCode:VALID_CODE,status:null,registeredAddress:null,matchReason:'exact'};
  const getCompanyProfile=vi.fn(async()=>({sourceStatus:'completed' as const,candidates:[candidate],basicProfile,cacheHit:false}));
  const overview=vi.fn(async()=>{throw new Error('offline');});
  await connected(buildMcpServer({getCompanyProfile,companyContext:{overview}} as unknown as McpServices),async client=>{
    expect((await client.callTool({name:'get_company_profile',arguments:{query:'测试'}})).isError).not.toBe(true);
    expect(overview).not.toHaveBeenCalled();
    expect((await client.callTool({name:'get_company_profile',arguments:{query:'测试',include_company_context:true}})).structuredContent).toMatchObject({company_context:{state:'unavailable'}});
    getCompanyProfile.mockResolvedValueOnce({sourceStatus:'completed',candidates:[candidate,candidate],basicProfile:null as unknown as typeof basicProfile,cacheHit:false});
    const ambiguous=await client.callTool({name:'get_company_profile',arguments:{query:'测试',include_company_context:true}});
    expect(ambiguous.isError).not.toBe(true); expect(ambiguous.structuredContent).not.toHaveProperty('company_context');
    expect(overview).toHaveBeenCalledTimes(1);
  });
  await connected(buildMcpServer({getCompanyProfile} as unknown as McpServices),async client=>{
    const names=(await client.listTools()).tools.map(t=>t.name);
    expect(names).toHaveLength(6); expect(names).not.toContain('link_company');
    const result=await client.callTool({name:'get_company_profile',arguments:{query:'测试',include_company_context:true}});
    expect(result.structuredContent).toMatchObject({company_context:{state:'not_applicable'}});
  });
});
it('maps stored profiles to public detail with configured freshness and no internal fields',async()=>{
  const detail=vi.fn(async():Promise<CompanyDetail>=>({state:'ok',warnings:[],link:{state:'confirmed',organization_id:'o1',credit_code:VALID_CODE,basis:'manual',version:1,candidates:[],warnings:[]},has_profile:true,report_count:0,latest_report_at:null,profile:PROFILE,latest_report:null,reports:{items:[],total:0,next_offset:null,complete:true}}));
  const server=new McpServer({name:'stored-profile-test',version:'1'});
  registerContactTools(server,new ContactLibraryService({request:async()=>({entity:{label:'Organization'}})} as unknown as GraphClient),{detail},{now:()=>new Date('2026-12-12T00:00:00.000Z'),ttlDays:30});
  await connected(server,async client=>{
    const result=await client.callTool({name:'get_contact',arguments:{entity_id:'o1',include_company_context:true}});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({company_context:{profile:{legal_name:PROFILE.identity.legalName,credit_code:VALID_CODE,basic_profile:PROFILE.basicProfile,collected_at:AT,stale:true}}});
    expect(JSON.stringify(result.structuredContent)).not.toContain('normalizedLegalName');
    expect(JSON.stringify(result.structuredContent)).not.toContain('formerNames');
  });
});

it('base read failures remain tool errors and do not become context source failures',async()=>{
  const summaries=vi.fn(async()=>new Map());
  const server=new McpServer({name:'base-error-test',version:'1'});
  registerContactSearchTools(server,{search:async()=>{throw new Error('BASE_SEARCH_FAILURE');}} as unknown as ContactSearch,undefined,undefined,{summaries});
  await connected(server,async client=>{
    const result=await client.callTool({name:'search_contacts',arguments:{include_company_context:true}});
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('BASE_SEARCH_FAILURE');
    expect(summaries).not.toHaveBeenCalled();
  });
});
it('report graph-off and cancellation during related query retain distinct behavior',async()=>{
  const id='10000000-0000-4000-8000-000000000002';
  const record={assessmentId:id,status:'completed',creditCode:VALID_CODE,legalName:'测试公司',
    reportMarkdown:'# 历史',overallOpportunity:'中',recommendedProduct:null,
    sourceStatus:{qcc:'completed',doubaoSearch:'completed',ark:'completed'},collectedAt:AT,completedAt:AT} as AssessmentRecord;
  const service=new AssessmentService({assessments:{get:()=>record} as unknown as AssessmentRepository,
    queue:{enqueue:()=>false},assessmentCacheTtlDays:30,now:()=>new Date(AT)});
  const output=await service.reportWithUpdates({assessmentId:id,includeRelatedUpdates:true});
  expect(output).toMatchObject({relatedUpdates:{state:'not_applicable',items:[],since:AT}});
  const controller=new AbortController();
  const relatedUpdates=vi.fn(async()=>{controller.abort(new Error('caller cancelled'));throw new Error('source unavailable');});
  await expect(service.reportWithUpdates({assessmentId:id,includeRelatedUpdates:true},{relatedUpdates},controller.signal)).rejects.toThrow('caller cancelled');
  expect(record.reportMarkdown).toBe('# 历史');
});
