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
  const tokens = new TokenService(new TokenRepository(db));
  let org = '100';
  let pages = [[{ id: '999999999999999999', email: ' SALES@example.com ', status: 'active', confirmed: true }]];
  const calls: string[] = [];
  const client = {
    getOrganization: async (id: string) => { calls.push(id); return org; },
    getUsersPage: async (_id: string, page: number) => ({ users: pages[page - 1] ?? [], moreRecords: page < pages.length }),
  };
  const admin = new TokenAdministration(tokens, client, [{ id: 'qx', orgId: '100' }, { id: 'st', orgId: '200' }]);
  return { tokens, admin, calls, setOrg: (v: string) => { org = v; }, setPages: (v: typeof pages) => { pages = v; } };
}
it('creates with a confirmed unique email match across every page of only the selected CRM', async () => {
  const f = fixture(); f.setPages([[], [{ id: '999999999999999999', email: 'sales@example.com', status: 'active', confirmed: true }]]);
  const token = await f.admin.create('sales', 'Sales@Example.com', 'qx');
  expect(f.tokens.verify(token)).toEqual({ userId: 'sales' });
  expect(f.tokens.get('sales')).toMatchObject({ email: 'sales@example.com', crmConnectionId: 'qx', crmOrgId: '100', crmUserId: '999999999999999999' });
  expect(f.calls).toEqual(['qx']);
});
it.each(['missing', 'ambiguous', 'inactive', 'unconfirmed', 'wrong-org'])('does not create anything for %s', async reason => {
  const f = fixture();
  const user = { id: '1', email: 'sales@example.com', status: 'active', confirmed: true };
  if (reason === 'missing') f.setPages([[]]);
  if (reason === 'ambiguous') f.setPages([[user], [{ ...user, id: '2' }]]);
  if (reason === 'inactive') f.setPages([[{ ...user, status: 'inactive' }]]);
  if (reason === 'unconfirmed') f.setPages([[{ ...user, confirmed: false }]]);
  if (reason === 'wrong-org') f.setOrg('200');
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
  const delayed=new TokenAdministration(f.tokens,client,[{id:'qx',orgId:'100'}]);
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
  },[{id:'qx',orgId:'100'},{id:'st',orgId:'200'}]);
  await expect(broken.create('sales','sales@example.com','qx')).rejects.toThrow('ZOHO_PERMISSION_DENIED');
  expect(f.tokens.list()).toEqual([]);
});
