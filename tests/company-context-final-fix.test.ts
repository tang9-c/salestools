import { expect, it, vi } from 'vitest';
import { AT, CODE, PROFILE, createContextFixture } from './fixtures/company-context.js';
import { identityHash } from '../src/companies/company-link.js';
import { createMaterialReadContext, validateContextRefs } from '../src/companies/company-evidence.js';
import type { ContextMaterial } from '../src/companies/company-context-types.js';
import { CompanyAnswerClient } from '../src/upstream/ark/company-answer.js';
import { CompanyQuestionService } from '../src/orchestration/company-question-service.js';

const meta={version:1,created_at:AT,updated_at:AT};
function graphFixture(f:ReturnType<typeof createContextFixture>, quote?:string, target='o1') {
  const project=!quote;
  const relation={relation_id:'r',source_id:project?'j1':'p1',target_id:target,
    relation_type:project?'clientOrganization':'worksFor',properties:project?{}:{role:{'@type':'OrganizationRole',roleName:'工程师'}},
    metadata:{...meta,...(!project?{employment_status:'unknown'}:{})}};
  f.request.mockImplementation(async(op,payload)=>{
    const p=payload as {entity_id?:string;organization_ids?:string[]};
    if(op==='company_organizations') return {items:[f.org],total:1,next_offset:null,complete:true};
    if(op==='company_relations') {
      if(p.organization_ids!.length>50) throw Error('native max 50');
      return {items:p.organization_ids!.includes(target)?[relation]:[],total:1,next_offset:null,complete:true};
    }
    if(op==='get_contact') {
      const owner=p.entity_id===relation.source_id;
      return {entity:{entity_id:p.entity_id,label:owner?(project?'Project':'Person'):'Organization',
        properties:{name:owner?(project?'测试项目':'测试人'):f.org.name},...(!project&&owner?{extensions:{hobbies:[],instantMessaging:[]}}:{}),metadata:meta},
        relations:owner?[relation]:[],evidence:owner?[{evidence_id:'e-r',subject_kind:'relation',subject_id:'r',
          field_path:project?'$relation':'properties.role.roleName',value:project?{relation_type:'clientOrganization'}:'工程师',
          source_type:'manual',locator_status:'not_applicable',collected_at:AT,quote:quote??`测试项目客户为${f.org.name}`}]:[],conflicts:[],version:1};
    }
    throw Error(op);
  });
}
function ark(max=100000) {
  let actual='';
  const fetchFn=vi.fn<typeof fetch>(async(_url,init)=>{actual=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:'{"claims":[]}'}}]}));});
  return {client:new CompanyAnswerClient({url:'https://example.com',model:'test',credential:'test',fetchFn,requestMaxBytes:max}),body:()=>actual};
}
it('reuses a direct client project with no people and no public lookup',async()=>{
  const f=createContextFixture();try {
    graphFixture(f);
    expect((await f.service.overview(CODE)).projects.count).toBe(1);
    const materials=await f.service.materials(CODE,'库内客户项目有哪些？',createMaterialReadContext(AbortSignal.timeout(30000),null));
    expect(materials.items.map(i=>i.predicate)).toContain('clientOrganization');
    const qcc=vi.fn(),search=vi.fn(),a=ark();
    await new CompanyQuestionService({profiles:f.profiles,assessments:f.assessments,companyContext:f.service,now:()=>new Date(AT),profileTtlDays:30,
      qccFactory:()=>({call:qcc,close:async()=>{}}),searchFactory:()=>({search}),answerFactory:()=>a.client})
      .ask({legalName:f.org.name!,creditCode:CODE,question:'库内客户项目有哪些？'});
    expect(a.body()).toContain('测试项目');expect(qcc).not.toHaveBeenCalled();expect(search).not.toHaveBeenCalled();
  }finally{f.db.close();}
});
it('reads 51 confirmed SQLite links in native size batches',async()=>{
  const f=createContextFixture();try {
    graphFixture(f,`测试人任职${f.org.name}工程师`,'o51');
    const orgs=Array.from({length:51},(_,i)=>({...f.org,entity_id:`o${i+1}`}));
    for(const o of orgs.slice(1)) f.links.write({action:'confirm',organization_id:o.entity_id,credit_code:CODE,operation_id:o.entity_id,
      expected_link_version:0,expected_organization_version:1,note:'合成关联'},'test',identityHash(o),AT);
    const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(op,payload,signal)=>op==='company_organizations'
      ? {items:orgs.filter(o=>!(payload as {entity_ids?:string[]}).entity_ids?.length||(payload as {entity_ids:string[]}).entity_ids.includes(o.entity_id)),total:51,next_offset:null,complete:true}
      :original(op,payload,signal));
    const context=createMaterialReadContext(AbortSignal.timeout(30000),null);
    const result=await f.service.materials(CODE,'库内联系人是谁？',context);
    expect(result.items.some(i=>i.predicate==='worksFor')).toBe(true);
    expect(f.request.mock.calls.filter(([op])=>op==='company_relations').every(([,p])=>(p as {organization_ids:string[]}).organization_ids.length<=50)).toBe(true);
    expect(context.contacts.size).toBeLessThanOrEqual(12);expect(result.items.length).toBeLessThanOrEqual(20);expect(context.report_reads).toBe(0);
  }finally{f.db.close();}
});
it.each(['，联系电话13800000000','，邮箱private@example.com'])('keeps a safe verbatim business substring %s',async(tail)=>{
  const f=createContextFixture();try {
    graphFixture(f,`测试人任职${f.org.name}工程师${tail}`);
    const result=await f.service.materials(CODE,'库内联系人是谁？',createMaterialReadContext(AbortSignal.timeout(30000),null));
    const item=result.items.find(i=>i.predicate==='worksFor')!;
    expect(item).toBeDefined();expect(item.citation.quote).toBe(`测试人任职${f.org.name}工程师`);
    expect(item.employment_status).toBe('unknown');expect(item.citation.ref).toBe('contact:e-r');
    const a=ark();await a.client.answer({legalName:f.org.name!,question:'联系人',items:[],facts:[],context:result.items});
    expect(a.body()).not.toMatch(/13800000000|private@example.com/);
    expect(JSON.stringify(validateContextRefs(['contact:e-r'],result.items))).not.toMatch(/13800000000|private@example.com/);
    let sent='';
    const fetchFn=vi.fn<typeof fetch>(async(_url,init)=>{sent=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({claims:[
      {category:'supported',text:item.statement,evidenceIds:[],contextRefs:['contact:e-r']},
    ]})}}]}));});
    const answered=await new CompanyQuestionService({profiles:f.profiles,assessments:f.assessments,companyContext:f.service,now:()=>new Date(AT),profileTtlDays:30,
      qccFactory:()=>({call:async()=>{throw Error('unexpected qcc');},close:async()=>{}}),searchFactory:()=>({search:async()=>{throw Error('unexpected search');}}),
      answerFactory:()=>new CompanyAnswerClient({url:'https://example.com',model:'test',credential:'test',fetchFn})})
      .ask({legalName:f.org.name!,creditCode:CODE,question:'库内联系人是谁？'});
    expect(answered.status).toBe('answered');expect(answered.markdown).toContain('当前状态未知');
    expect(answered.context_citations?.map(c=>c.ref)).toEqual(['contact:e-r']);
    expect(JSON.stringify(answered)+sent).not.toMatch(/13800000000|private@example.com/);
    const raw=await f.request('get_contact',{entity_id:'p1'}) as {evidence:Array<{quote:string}>};
    expect(raw.evidence[0]!.quote).toBe(`测试人任职${f.org.name}工程师${tail}`);

  }finally{f.db.close();}
});
it.each(['测试人未任职测试装备有限公司工程师，联系电话13800000000','测试人计划任职测试装备有限公司工程师，联系电话13800000000',
  '联系电话13800000000否认测试人任职测试装备有限公司工程师'])('does not manufacture an affirmative quote from %s',async(quote)=>{
  const f=createContextFixture();try {graphFixture(f,quote);const result=await f.service.materials(CODE,'联系人',createMaterialReadContext(AbortSignal.timeout(30000),null));
    expect(result.items.filter(i=>i.predicate==='worksFor')).toEqual([]);
  }finally{f.db.close();}
});
it('looks up non ASCII uppercase names using the existing Qcc normalization',async()=>{
  const f=createContextFixture();try {
    f.db.exec('DELETE FROM company_link_operations; DELETE FROM company_links;');f.org.name='ÉCLAIR有限公司';
    f.profiles.upsert({...PROFILE,identity:{...PROFILE.identity,legalName:f.org.name},normalizedLegalName:'Éclair有限公司'});
    expect((await f.service.summaries(['o1'])).get('o1')?.link.state).toBe('candidate');
  }finally{f.db.close();}
});
const material=(ref:string,quote:string,required_context_refs:string[]=[]):ContextMaterial=>({citation:{ref,source_type:'contact',subject_id:'p',quote},statement:ref,source_key:ref,predicate:'memberOf',object:'project',required_context_refs} as ContextMaterial);
it('packs final byte dependencies atomically and rejects missing dependency refs',async()=>{
  const client=material('contact:client','客户'.repeat(6000));const member=material('contact:member','成员',['contact:client']);const independent=material('contact:other','任职');
  const a=ark(2400);const result=await a.client.answer({legalName:'测试',question:'项目',items:[],facts:[],context:[client,member,independent]});
  expect(result.includedContextRefs).toEqual(['contact:other']);expect(a.body()).not.toContain('contact:member');
  expect(()=>validateContextRefs(['contact:member'],[member])).toThrow();
  expect(()=>validateContextRefs(['contact:member'],[member,client])).toThrow();
  expect(validateContextRefs(['contact:member','contact:client'],[member,client])).toHaveLength(2);
});
it('keeps all required snapshot citations in the actual body',async()=>{
  const first=material('assessment:a','short',['assessment:b']);const second=material('assessment:b','long'.repeat(3000),['assessment:a']);const a=ark(2400);
  const result=await a.client.answer({legalName:'测试',question:'业务',items:[],facts:[],context:[first,second,material('profile:other','独立事实')]});
  expect(result.includedContextRefs).toEqual(['profile:other']);
});
it('rejects a client project participation claim after actual byte packing drops the path',async()=>{
  const f=createContextFixture();try {
    f.profiles.upsert({...PROFILE,basicProfile:{...PROFILE.basicProfile,industry:'设备制造'}});
    const client={relation_id:'client',source_id:'j1',target_id:'o1',relation_type:'clientOrganization',properties:{},metadata:meta};
    const member={relation_id:'member',source_id:'p1',target_id:'j1',relation_type:'memberOf',properties:{},metadata:meta};
    const proof=(id:string,quote:string,type:string)=>({evidence_id:id,subject_kind:'relation',subject_id:id,field_path:'$relation',value:{relation_type:type},
      quote,source_type:'manual',locator_status:'not_applicable',collected_at:AT});
    f.request.mockImplementation(async(op,payload)=>{
      if(op==='company_organizations') return {items:[f.org],total:1,next_offset:null,complete:true};
      if(op==='company_relations') return {items:[client,member],total:2,next_offset:null,complete:true};
      const id=(payload as {entity_id:string}).entity_id;
      return {entity:{entity_id:id,label:id==='o1'?'Organization':id==='j1'?'Project':'Person',properties:{name:id==='o1'?f.org.name:id==='j1'?'测试项目':'测试人'},
        ...(id==='p1'?{extensions:{hobbies:[],instantMessaging:[]}}:{}),metadata:meta},relations:id==='j1'?[client]:id==='p1'?[member]:[],
        evidence:id==='j1'?[proof('client',`测试项目客户为${f.org.name}${'业务说明'.repeat(100)}`,'clientOrganization')]:id==='p1'?[proof('member','测试人是测试项目成员','memberOf')]:[],conflicts:[],version:1};
    });
    let sent='';
    const fetchFn=vi.fn<typeof fetch>(async(_url,init)=>{sent=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({claims:[{category:'supported',text:'测试人参与了该企业客户项目',evidenceIds:[],contextRefs:['contact:member']}]})}}]}));});
    const result=await new CompanyQuestionService({profiles:f.profiles,assessments:f.assessments,companyContext:f.service,now:()=>new Date(AT),profileTtlDays:30,
      qccFactory:()=>({call:async()=>({}),close:async()=>{}}),searchFactory:()=>({search:async()=>[]}),
      answerFactory:()=>new CompanyAnswerClient({url:'https://example.com',model:'test',credential:'test',fetchFn,requestMaxBytes:2400})})
      .ask({legalName:f.org.name!,creditCode:CODE,question:'谁参与了客户项目？'});
    expect(sent).toContain('设备制造');expect(sent).not.toContain('contact:member');
    expect(result.markdown).not.toContain('测试人参与了该企业客户项目');expect(result.context_citations??[]).toEqual([]);
  }finally{f.db.close();}
});
it('shares the twenty relation page attempts across calls, including failures',async()=>{
  const f=createContextFixture();try {
    let attempts=0;
    f.request.mockImplementation(async(op)=>{
      if(op==='company_organizations') return {items:[f.org],total:1,next_offset:null,complete:true};
      if(op==='company_relations') {attempts++;throw Error('unavailable');}
      throw Error(op);
    });
    const context=createMaterialReadContext(AbortSignal.timeout(30000),null);
    for(let i=0;i<22;i++) await f.service.materials(CODE,'联系人',context);
    expect(attempts).toBe(20);expect(context.remaining_relation_pages).toBe(0);
    expect((await f.service.materials(CODE,'联系人',context)).warnings).toContain('RELATIONS_INCOMPLETE');
  }finally{f.db.close();}
});
it('omits unsafe saved role values rather than leaking them through statement or fields',async()=>{
  const f=createContextFixture();try {
    graphFixture(f,`测试人任职${f.org.name}工程师13800000000`);
    const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(op,payload,signal)=>{
      const result=await original(op,payload,signal) as {relations?:Array<{properties:{role:{roleName:string}}}>};
      if(op==='get_contact'&&(payload as {entity_id:string}).entity_id==='p1') result.relations![0]!.properties.role.roleName='工程师13800000000';
      return result;
    });
    const result=await f.service.materials(CODE,'联系人',createMaterialReadContext(AbortSignal.timeout(30000),null));
    expect(result.items).toEqual([]);expect(result.warnings).toContain('CONTACT_BUSINESS_EVIDENCE_UNSAFE');
    expect(JSON.stringify(result)).not.toContain('13800000000');
  }finally{f.db.close();}
});
it('preserves actual SQLite snapshot dependencies through final Ark bytes without counting one URL twice',async()=>{
  const f=createContextFixture();try {
    f.profiles.upsert({...PROFILE,basicProfile:{...PROFILE.basicProfile,industry:'设备制造'}});
    const base={title:'装备制造行业',url:'https://example.test/company',originalPublisher:null,originalDomain:null,publishedAt:null,collectedAt:AT,
      mentionedName:f.org.name,entityScope:'legal_entity',entityMatch:'confirmed',matchBasis:[],source:'qcc',sourceKind:'company',excerptTruncated:false};
    const snapshot={collectedAt:AT,items:[{...base,evidenceId:'A',excerpt:'生产设备'},{...base,evidenceId:'B',excerpt:'提供维护'.repeat(150)}],
      facts:[{factId:'compound',statement:'既生产设备也提供维护',kind:'industry',productTags:[],strength:'direct',evidenceIds:['A','B'],entityScope:'legal_entity',entityMatch:'confirmed',matchBasis:[]}]};
    f.db.prepare(`INSERT INTO assessments (assessment_id,cache_key,requested_by,legal_name,credit_code,status,evidence_snapshot_json,created_at,completed_at)
      VALUES ('compound',?,'test',?,?,'completed',?,?,?)`).run(CODE,f.org.name,CODE,JSON.stringify(snapshot),AT,AT);
    const context=createMaterialReadContext(AbortSignal.timeout(30000),'compound');
    const result=await f.service.materials(CODE,'装备制造行业',context);
    const reports=result.items.filter(i=>i.citation.source_type==='assessment');
    expect(reports).toHaveLength(2);expect(new Set(reports.map(i=>i.source_key)).size).toBe(1);
    expect(reports[0]!.required_context_refs).toEqual(['assessment:compound:B']);
    const a=ark(2600);const packed=await a.client.answer({legalName:f.org.name!,question:'装备制造行业',items:[],facts:[],context:result.items});
    expect(packed.includedContextRefs?.some(ref=>ref.startsWith('assessment:'))).toBe(false);
    expect(context.report_reads).toBe(1);expect(result.items.length).toBeLessThanOrEqual(20);
    const full=ark();const fullPacked=await full.client.answer({legalName:f.org.name!,question:'装备制造行业',items:[],facts:[],context:result.items});
    expect(fullPacked.includedContextRefs).toEqual(expect.arrayContaining(['assessment:compound:A','assessment:compound:B']));
    expect(validateContextRefs(['assessment:compound:A','assessment:compound:B'],result.items)).toHaveLength(2);
  }finally{f.db.close();}
});
