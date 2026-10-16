import { expect, it } from 'vitest';
import { annotateZohoOwners } from '../src/contacts/zoho-owner-identity.js';
import type { ZohoContactsOutput } from '../src/contracts/zoho-contact.js';
import { renderZohoContacts } from '../src/contacts/zoho-contact-renderer.js';
const result = (): ZohoContactsOutput => ({status:'completed',complete:true,connections:[],warnings:[],collected_at:'2026-10-16T00:00:00.000Z',companies:[
  {connection_id:'qx',account_id:'1',company_name:'客户',account_owner:{id:'9',name:'甲'},contacts:[
    {record_id:'2',name:'乙',title:null,modified_at:null,contact_owner:{id:'8',name:'乙'}},
    {record_id:'3',name:'丙',title:null,modified_at:null,contact_owner:null}]},
  {connection_id:'st',account_id:'4',company_name:'另一组织',account_owner:{id:'9',name:'同ID'},contacts:[]}]});
it('identifies account/contact owners independently and never matches an ID across organizations',()=>{
  const source=result(),output=annotateZohoOwners(source,{connectionId:'qx',userId:'9'});
  expect(output.companies[0]?.account_owner?.is_current_user).toBe(true);
  expect(output.companies[0]?.contacts[0]?.contact_owner?.is_current_user).toBe(false);
  expect(output.companies[0]?.contacts[1]?.contact_owner).toBeNull();
  expect(output.companies[1]?.account_owner?.is_current_user).toBeNull();
  expect(source.companies[0]?.account_owner).not.toHaveProperty('is_current_user');
  expect(renderZohoContacts(output)).toContain('甲（本人）');
});
it('returns unknown when the local user is unbound or organization verification failed',()=>{
  expect(annotateZohoOwners(result(),null).companies[0]?.account_owner?.is_current_user).toBeNull();
});
