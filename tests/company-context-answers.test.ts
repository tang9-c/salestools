import { expect, it, vi } from 'vitest';
import { ContactAnswerService } from '../src/contacts/contact-answer.js';
import { CompanyQuestionService } from '../src/orchestration/company-question-service.js';
import { CompanyAnswerClient } from '../src/upstream/ark/company-answer.js';
import { identityHash } from '../src/companies/company-link.js';
import { AT, CODE, PROFILE, createContextFixture } from './fixtures/company-context.js';

const meta = {version:1,created_at:AT,updated_at:AT};
const works = (id:string,target:string) => ({relation_id:id,source_id:'p1',target_id:target,relation_type:'worksFor',
  properties:{role:{'@type':'OrganizationRole',roleName:'工程师'}},metadata:{...meta,employment_status:'unknown'}});
const evidence = (id:string,targetName:string) => ({evidence_id:`e-${id}`,subject_kind:'relation',subject_id:id,
  field_path:'$relation',value:{relation_type:'worksFor'},source_type:'manual',quote:`张某任职${targetName}工程师`,
  locator_status:'not_applicable',collected_at:AT});

it.each([false,true])('shares real contacts and the newest single report without falling back when missing=%s',async(missing)=>{
  const f=createContextFixture();
  try {
    const code2='91310000123456790R';
    const org2={...f.org,entity_id:'o2',name:'第二装备有限公司'};
    f.profiles.upsert({...PROFILE,identity:{...PROFILE.identity,creditCode:code2,legalName:org2.name},
      normalizedLegalName:org2.name,basicProfile:{...PROFILE.basicProfile,industry:'第二行业'}});
    f.profiles.upsert({...PROFILE,basicProfile:{...PROFILE.basicProfile,industry:'第一行业'}});
    f.links.write({action:'confirm',organization_id:'o2',credit_code:code2,operation_id:'second-link',
      expected_link_version:0,expected_organization_version:1,note:'合成关联'},'test',identityHash(org2),AT);
    for (const [id,code,at,name] of [['old',CODE,'2026-10-10T00:00:00.000Z',f.org.name!],['new',code2,AT,org2.name]]) {
      f.db.prepare(`INSERT INTO assessments (assessment_id,cache_key,requested_by,legal_name,credit_code,status,created_at,completed_at,collected_at) VALUES (?,?,'test',?,?,'completed',?,?,?)`).run(id,code,name,code,at,at,at);
    }
    const snapshot={collectedAt:AT,items:[{evidenceId:'company2-evidence',title:'任职公司背景',url:null,originalPublisher:null,originalDomain:null,publishedAt:null,collectedAt:AT,mentionedName:org2.name,entityScope:'legal_entity',entityMatch:'confirmed',matchBasis:[],source:'qcc',sourceKind:'company',excerpt:'第二装备公司的业务事实',excerptTruncated:false}],facts:[{factId:'f2',statement:'第二装备公司的业务事实',kind:'industry',productTags:[],strength:'direct',evidenceIds:['company2-evidence'],entityScope:'legal_entity',entityMatch:'confirmed',matchBasis:[]}]};
    f.db.prepare("UPDATE assessments SET evidence_snapshot_json=? WHERE assessment_id='new'").run(JSON.stringify(snapshot));
    const relations=[works('r1','o1'),works('r2','o2')];
    f.request.mockImplementation(async(op,payload)=>{
      const p=payload as {entity_id?:string;entity_ids?:string[];credit_codes?:string[];organization_ids?:string[]};
      if(op==='company_organizations') {
        const orgs=[f.org,org2].filter(o=>!p.entity_ids?.length || p.entity_ids.includes(o.entity_id));
        const items=orgs.filter(o=>!p.credit_codes?.length || p.credit_codes.includes(o.entity_id==='o1'?CODE:code2));
        return {items,total:items.length,next_offset:null,complete:true};
      }
      if(op==='company_relations') return {items:relations.filter(r=>!p.organization_ids?.length || p.organization_ids.includes(r.target_id)),total:2,next_offset:null,complete:true};
      if(op==='get_contact') return p.entity_id==='p1' ? {entity:{entity_id:'p1',label:'Person',properties:{name:'张某'},extensions:{hobbies:[],instantMessaging:[]},metadata:meta},
        relations,evidence:[evidence('r1',f.org.name!),evidence('r2',org2.name)],conflicts:[],version:1}
        : {entity:{entity_id:p.entity_id,label:'Organization',properties:{name:p.entity_id==='o1'?f.org.name:org2.name},metadata:meta},relations:[],evidence:[],conflicts:[],version:1};
      throw Error(op);
    });
    const load=f.assessments.get.bind(f.assessments);
    const get=vi.spyOn(f.assessments,'get');
    if (missing) get.mockImplementation(id=>id==='new'?null:load(id));
    const materials=vi.spyOn(f.service,'materials');
    const answer=new ContactAnswerService({graph:f.graph,resolvePeople:async()=>[],companyContext:f.service});
    const result=await answer.ask({entity_id:'p1',question:'张某的任职公司背景是什么？'});
    expect(result.status).toBe('answered');
    expect(result.answer).toContain('第一行业');expect(result.answer).toContain('第二行业');
    for (const citation of result.context_citations ?? []) expect(result.answer).toContain(`[${citation.ref}]`);
    expect(result.facts).toHaveLength(2);expect(result.citations).toHaveLength(2);
    expect(materials).toHaveBeenCalledTimes(2);
    expect(materials.mock.calls[0][2]).toBe(materials.mock.calls[1][2]);
    expect(materials.mock.calls[0][2].contacts.size).toBe(3);
    expect(f.request.mock.calls.filter(([op])=>op==='get_contact')).toHaveLength(3);
    expect(get).toHaveBeenCalledOnce();expect(get).toHaveBeenCalledWith('new');
    const reports=result.context_citations?.filter(c=>c.source_type==='assessment') ?? [];
    expect(reports.map(c=>c.subject_id)).toEqual(missing?[]:[code2]);
    expect(result.context_citations?.filter(c=>c.source_type==='profile').map(c=>c.subject_id)).toEqual([CODE,code2]);
  } finally {f.db.close();}
});

it('never queries company context for a name or study question',async()=>{
  const f=createContextFixture();try {
    const school={relation_id:'school',source_id:'p1',target_id:'u1',relation_type:'alumniOf',properties:{},metadata:meta};
    const proofBase={source_type:'manual',locator_status:'not_applicable',collected_at:AT};
    f.request.mockImplementation(async(_op,payload)=>{
      const id=(payload as {entity_id:string}).entity_id;
      return id==='p1' ? {entity:{entity_id:id,label:'Person',properties:{name:'张某'},extensions:{hobbies:[],instantMessaging:[]},metadata:meta},
        relations:[school,works('r1','o1')],evidence:[
          {...proofBase,evidence_id:'name',subject_kind:'entity',subject_id:id,field_path:'properties.name',value:'张某',quote:'姓名张某'},
          {...proofBase,evidence_id:'study',subject_kind:'relation',subject_id:'school',field_path:'$relation',value:{relation_type:'alumniOf'},quote:'张某毕业于测试大学'},
          evidence('r1',f.org.name!),
        ],conflicts:[]}
        : {entity:{entity_id:id,label:'Organization',properties:{name:id==='u1'?'测试大学':f.org.name},metadata:meta},relations:[],evidence:[],conflicts:[]};
    });
    const summaries=vi.spyOn(f.service,'summaries'),materials=vi.spyOn(f.service,'materials');
    const answer=new ContactAnswerService({graph:f.graph,resolvePeople:async()=>[],companyContext:f.service});
    for(const question of ['姓名是什么？','就读哪里？','毕业哪里？','在哪里工作？']) {
      const result=await answer.ask({entity_id:'p1',question});
      expect(result.status).toBe('answered');expect(result.citations).toHaveLength(1);
    }
    expect(summaries).not.toHaveBeenCalled();expect(materials).not.toHaveBeenCalled();
  }finally{f.db.close();}
});

it('reports only context that actually fit inside the Ark request',async()=>{
  let supplied:string[]=[];
  const fetchFn=vi.fn<typeof fetch>(async(_url,init)=>{
    const body=String(init?.body);expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2300);
    supplied=JSON.parse(JSON.parse(body).messages[1].content).context.map((c:{citation:{ref:string}})=>c.citation.ref);
    return new Response(JSON.stringify({choices:[{message:{content:'{"claims":[]}'}}]}));
  });
  const answer=await new CompanyAnswerClient({url:'https://example.com',model:'test',credential:'test',fetchFn,requestMaxBytes:2300}).answer({legalName:'测试公司',question:'联系人',items:[],facts:[],context:Array.from({length:20},(_,i)=>({citation:{ref:`contact:${i}`,source_type:'contact' as const,subject_id:'p1',quote:'工程师任职记录'.repeat(20)},statement:'联系人任职记录',source_key:`file:${i}`,predicate:'worksFor',object:'测试公司'}))});
  expect(supplied.length).toBeGreaterThan(0);expect(supplied.length).toBeLessThan(20);
  expect(answer.includedContextRefs).toEqual(supplied);expect(answer.omittedCount).toBe(20-supplied.length);
});

it.each(['company','contact'])('propagates cancellation of the actual shared graph query at the %s entry point',async(entry)=>{
  const f=createContextFixture(),controller=new AbortController();
  const search=vi.fn(async()=>[]),qccCall=vi.fn(async()=>({}));
  try {
    f.request.mockImplementation(async(op,payload,signal)=>{
      if(op==='get_contact') {
        const id=(payload as {entity_id:string}).entity_id;
        return id==='p1'?{entity:{entity_id:id,label:'Person',properties:{name:'张某'},extensions:{hobbies:[],instantMessaging:[]},metadata:meta},relations:[works('r1','o1')],evidence:[evidence('r1',f.org.name!)],conflicts:[],version:1}
          :{entity:{entity_id:id,label:'Organization',properties:{name:f.org.name},metadata:meta},relations:[],evidence:[],conflicts:[],version:1};
      }
      expect(op).toBe('company_organizations');
      controller.abort(new Error('stop shared query'));
      expect(signal?.aborted).toBe(true);
      return {items:[f.org],total:2,next_offset:1,complete:false};
    });
    const result=entry==='company'
      ? await new CompanyQuestionService({profiles:f.profiles,assessments:f.assessments,profileTtlDays:30,now:()=>new Date(AT),companyContext:f.service,qccFactory:()=>({call:qccCall,close:async()=>{}}),searchFactory:()=>({search}),answerFactory:()=>({answer:async()=>({claims:[]})})}).ask({legalName:f.org.name!,creditCode:CODE,question:'库内联系人是谁？'},controller.signal)
      : await new ContactAnswerService({graph:f.graph,resolvePeople:async()=>[],companyContext:f.service}).ask({entity_id:'p1',question:'张某的任职公司背景是什么？'},controller.signal);
    expect(result.status).toBe('failed');
    expect('markdown' in result?result.markdown:result.answer).toContain('取消');
    expect(f.request.mock.calls.filter(([op])=>op==='company_organizations')).toHaveLength(1);
    expect(search).not.toHaveBeenCalled();expect(qccCall).not.toHaveBeenCalled();
  } finally {f.db.close();}
});
