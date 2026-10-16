import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { TokenRepository } from '../src/db/token-repository.js';
import { TokenService } from '../src/auth/token-service.js';
import { TokenAdministration } from '../src/auth/token-administration.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = initializeDatabase(new DatabaseSync(':memory:')); dbs.push(db);
  const repository = new TokenRepository(db);
  const tokens = new TokenService(repository);
  let org = '100';
  let pages = [[{ id: '999999999999999999', email: ' SALES@example.com ', status: 'active', confirmed: true }]];
  const calls: string[] = [];
  const client = {
    getOrganization: async (id: string) => { calls.push(id); return org; },
    getUsersPage: async (_id: string, page: number) => ({ users: pages[page - 1] ?? [], moreRecords: page < pages.length }),
  };
  const admin = new TokenAdministration(tokens, client, [{ id: 'qx', name: 'QX' }, { id: 'st', name: 'ST' }]);
  return { tokens, admin, repository, calls, setOrg: (v: string) => { org = v; }, setPages: (v: typeof pages) => { pages = v; } };
}
it('creates with a confirmed unique email match across every page of only the selected CRM', async () => {
  const f = fixture(); f.setPages([[], [{ id: '999999999999999999', email: 'sales@example.com', status: 'active', confirmed: true }]]);
  const token = await f.admin.create('sales', 'Sales@Example.com', 'qx');
  expect(f.tokens.verify(token)).toEqual({ userId: 'sales' });
  expect(f.tokens.get('sales')).toMatchObject({ email: 'sales@example.com', crmConnectionId: 'qx', crmOrgId: '100', crmUserId: '999999999999999999' });
  expect(f.calls).toEqual(['qx']);
});
it.each(['missing', 'ambiguous', 'inactive', 'unconfirmed'])('does not create anything for %s', async reason => {
  const f = fixture();
  const user = { id: '1', email: 'sales@example.com', status: 'active', confirmed: true };
  if (reason === 'missing') f.setPages([[]]);
  if (reason === 'ambiguous') f.setPages([[user], [{ ...user, id: '2' }]]);
  if (reason === 'inactive') f.setPages([[{ ...user, status: 'inactive' }]]);
  if (reason === 'unconfirmed') f.setPages([[{ ...user, confirmed: false }]]);
  await expect(f.admin.create('sales', 'sales@example.com', 'qx')).rejects.toThrow();
  expect(f.tokens.list()).toEqual([]);
});
it('preserves the token and old identity on failed updates, then atomically changes organization', async () => {
  const f = fixture(); const token = await f.admin.create('sales', 'sales@example.com', 'qx');
  await expect(f.admin.updateIdentity('sales', 'new@example.com', 'qx')).rejects.toThrow('CRM_USER_NOT_FOUND');
  expect(f.tokens.get('sales')).toMatchObject({ email: 'sales@example.com', crmOrgId: '100' });
  f.setOrg('200'); f.setPages([[{ id: '2', email: 'new@example.com', status: 'active', confirmed: true }]]);
  await f.admin.updateIdentity('sales', 'new@example.com', 'st');
  expect(f.tokens.get('sales')).toMatchObject({ email: 'new@example.com', crmConnectionId: 'st', crmOrgId: '200', crmUserId: '2' });
  expect(f.tokens.verify(token)).toEqual({ userId: 'sales' });
});

it('does not overwrite an identity changed while a CRM lookup was in flight', async () => {
  const f=fixture();await f.admin.create('sales','sales@example.com','qx');
  let release!: ()=>void;
  const client={getOrganization:async()=>{await new Promise<void>(resolve=>{release=resolve;});return '100';},
    getUsersPage:async()=>({users:[{id:'2',email:'new@example.com',status:'active',confirmed:true}],moreRecords:false})};
  const delayed=new TokenAdministration(f.tokens,client,[{id:'qx',name:'QX'}]);
  const pending=delayed.updateIdentity('sales','new@example.com','qx');
  f.tokens.rotate('sales');release();
  await expect(pending).rejects.toThrow('TOKEN_IDENTITY_CHANGED');
  expect(f.tokens.get('sales')).toMatchObject({email:'sales@example.com'});
});

it('does not fall back to another organization or write after upstream rejection',async()=>{
  const f=fixture();
  const broken=new TokenAdministration(f.tokens,{
    getOrganization:async()=>{throw new Error('ZOHO_PERMISSION_DENIED');},
    getUsersPage:async()=>{throw new Error('should not run');},
  },[{id:'qx',name:'QX'},{id:'st',name:'ST'}]);
  await expect(broken.create('sales','sales@example.com','qx')).rejects.toThrow('ZOHO_PERMISSION_DENIED');
  expect(f.tokens.list()).toEqual([]);
});

it('matches normalized connection names without renaming the existing CRM source connection',async()=>{
  const f=fixture(),calls:string[]=[];
  const admin=new TokenAdministration(f.tokens,{
    getOrganization:async id=>{calls.push(id);return '100';},
    getUsersPage:async id=>{calls.push(id);return {users:[{id:'9',email:'sales@example.com',status:'active',confirmed:true}],moreRecords:false};},
  },[{id:'crm_a',name:' Qx '},{id:'crm_b',name:' sT '}]);
  await admin.create('sales','sales@example.com','qx');
  expect(calls).toEqual(['crm_a','crm_a']);
  expect(f.tokens.get('sales')).toMatchObject({crmConnectionId:'qx',crmOrgId:'100',crmUserId:'9'});
});

it('does not fall back to the connection ID when the configured name does not match',async()=>{
  const f=fixture();
  const admin=new TokenAdministration(f.tokens,{
    getOrganization:async()=>{throw new Error('must not query');},
    getUsersPage:async()=>{throw new Error('must not query');},
  },[{id:'qx',name:'Other CRM'}]);
  await expect(admin.create('sales','sales@example.com','qx')).rejects.toThrow('CRM_ORG_NOT_CONFIGURED');
  expect(f.tokens.list()).toEqual([]);
});

it('learns the actual organization ID on first binding without a configured ID',async()=>{
  const f=fixture();f.setOrg('300');
  await f.admin.create('sales','sales@example.com','qx');
  expect(f.tokens.get('sales')).toMatchObject({crmConnectionId:'qx',crmOrgId:'300'});
});

it('rejects an organization change for an existing binding and preserves its token and identity',async()=>{
  const f=fixture();const token=await f.admin.create('sales','sales@example.com','qx');
  f.setOrg('200');
  await expect(f.admin.updateIdentity('sales','sales@example.com','qx')).rejects.toThrow('CRM_ORG_MISMATCH');
  expect(f.tokens.get('sales')).toMatchObject({crmConnectionId:'qx',crmOrgId:'100',crmUserId:'999999999999999999'});
  expect(f.tokens.verify(token)).toEqual({userId:'sales'});
});

it('binds a legacy user with no saved organization ID without replacing its token',async()=>{
  const f=fixture(),token='A'.repeat(43);
  f.repository.insert({userId:'legacy',tokenHash:f.tokens.hash(token),enabled:true,createdAt:'2026-10-01T00:00:00.000Z'});
  expect(f.tokens.get('legacy')).toMatchObject({crmConnectionId:null,crmOrgId:null});
  await f.admin.updateIdentity('legacy','sales@example.com','qx');
  expect(f.tokens.get('legacy')).toMatchObject({crmConnectionId:'qx',crmOrgId:'100',crmUserId:'999999999999999999'});
  expect(f.tokens.verify(token)).toEqual({userId:'legacy'});
});
