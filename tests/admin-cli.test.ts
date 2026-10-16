import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
// Single-file CLI deliberately ships without TypeScript or node_modules.
// @ts-expect-error No declaration file for standalone mjs.
import { runAdminCli } from '../tools/salestools-admin.mjs';
const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
async function fixture() {
  const home=await mkdtemp(join(tmpdir(),'admin-cli-'));homes.push(home);
  const out:string[]=[],err:string[]=[];const fetch=vi.fn();
  const io={home,fetch,stdout:(v:string)=>out.push(v),stderr:(v:string)=>err.push(v)};
  const run=(args:string[])=>runAdminCli(args,io);
  const config=join(home,'.config/salestools/admin.json');
  return {home,out,err,fetch,run,config,io};
}
const requestId='00000000-0000-4000-8000-000000000001';
it('setup saves a private secret without displaying it or overwriting it',async()=>{
  const f=await fixture();expect(await f.run(['setup','--url','https://example.com'])).toBe(0);
  const raw=await readFile(f.config,'utf8'),c=JSON.parse(raw);
  expect((await lstat(f.config)).mode&0o777).toBe(0o600);
  expect((await lstat(join(f.home,'.config/salestools'))).mode&0o777).toBe(0o700);
  expect(f.out.join('')).toContain(createHash('sha256').update(c.adminKey).digest('hex'));
  expect(f.out.join('')+f.err.join('')).not.toContain(c.adminKey);
  expect(await f.run(['setup','--url','https://example.com'])).toBe(2);
  expect(await readFile(f.config,'utf8')).toBe(raw);expect(f.fetch).not.toHaveBeenCalled();
});
it.each([['token','disable','sales'],['setup','--url','http://example.com'],['setup','--url','https://user:password@example.com'],['token','list','--limit','0'],['token','create',' sales']].map(args=>[args]))('rejects invalid arguments without requests %j',async args=>{
  const f=await fixture();expect(await f.run(args)).toBe(2);expect(f.fetch).not.toHaveBeenCalled();
});
it('refuses loose config permissions and symlinks',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);await chmod(f.config,0o644);
  expect(await f.run(['token','list'])).toBe(2);await chmod(f.config,0o600);
  const raw=await readFile(f.config);await rm(f.config);const other=join(f.home,'other');
  await import('node:fs/promises').then(fs=>fs.writeFile(other,raw,{mode:0o600}));await symlink(other,f.config);
  expect(await f.run(['token','list'])).toBe(2);expect(f.fetch).not.toHaveBeenCalled();
});
it('outputs only the business token and rejects redirects without retry',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',token:'B'.repeat(43),requestId}),{status:201}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(0);expect(f.out.join('')).toBe('B'.repeat(43)+'\n');
  expect(f.fetch.mock.calls[0][0]).toBe('https://example.com/admin/v1/tokens');expect(f.fetch.mock.calls[0][1].redirect).toBe('error');
  expect(f.err.join('')).not.toContain('B'.repeat(43));
});
it.each(['network','server','malformed','redirect'])('marks an ambiguous write as unknown: %s',async failure=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  if(failure==='network')f.fetch.mockRejectedValue(new Error('private-key'));
  else f.fetch.mockResolvedValue(new Response('private-key',{status:failure==='server'?500:failure==='redirect'?302:201}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(3);expect(f.fetch).toHaveBeenCalledTimes(1);expect(f.err.join('')).toContain('结果未知');expect(f.err.join('')).not.toContain('private-key');expect(f.out).toHaveLength(0);
});
it('reports rejection safely and writes metadata only for list/disable',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;
  f.fetch.mockResolvedValue(new Response('private',{status:429,headers:{'retry-after':'30'}}));
  expect(await f.run(['token','list'])).toBe(1);expect(f.err.join('')).toContain('30');
  f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',disabled:true,requestId}),{status:200}));
  expect(await f.run(['token','disable','sales','--all'])).toBe(0);expect(JSON.parse(f.out[0])).toEqual({userId:'sales',disabled:true,requestId});
});
it('does not claim success when stdout fails after creating the token',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',token:'B'.repeat(43),requestId}),{status:201}));
  expect(await runAdminCli(['token','create','sales','--email','sales@example.com','--crm','qx'],{...f.io,stdout:()=>{throw new Error('write failed');}})).toBe(3);
});

it('rejects oversized or extra-field success payloads without leaking them',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;
  f.fetch.mockResolvedValue(new Response('s'.repeat(1024*1024+1),{status:201}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(3);
  f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',token:'B'.repeat(43),requestId,private:'secret'}),{status:201}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(3);expect(f.out).toHaveLength(0);expect(f.err.join('')).not.toContain('secret');
});
it('accepts a validated paginated list',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({items:[{userId:'sales',enabled:false,createdAt:'2026-10-11T00:00:00.000Z'}],nextOffset:null,requestId}),{status:200}));
  expect(await f.run(['token','list','--limit','1','--offset','1'])).toBe(0);
  expect(f.fetch.mock.calls[0][0]).toContain('?limit=1&offset=1');expect(JSON.parse(f.out[0]).items[0].enabled).toBe(false);
});

it('refuses a symlink in the configuration directory',async()=>{
  const f=await fixture();const target=join(f.home,'config-target');
  const fs=await import('node:fs/promises');await fs.mkdir(target,{mode:0o700});await symlink(target,join(f.home,'.config'));
  expect(await f.run(['setup','--url','https://example.com'])).toBe(2);expect(f.fetch).not.toHaveBeenCalled();
  expect(await fs.readdir(target)).toEqual([]);
});
it('saves no config if setup URL carries query/fragment or a non-root path',async()=>{
  const f=await fixture();for(const url of ['https://example.com/path','https://example.com?secret=x','https://example.com#secret']) {
    expect(await f.run(['setup','--url',url])).toBe(2);
  }
  expect(f.fetch).not.toHaveBeenCalled();
});

it('sends the selected organization and email, and supports token rotation',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',token:'B'.repeat(43),requestId}),{status:201}));
  expect(await f.run(['token','create','sales','--email','Sales@Example.com','--crm','st'])).toBe(0);
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({userId:'sales',email:'sales@example.com',crm:'st'});
  f.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'sales',token:'C'.repeat(43),requestId}),{status:200}));
  expect(await f.run(['token','rotate','sales'])).toBe(0);
  expect(f.fetch.mock.calls[1][0]).toContain('/tokens/rotate');
});
it('requires identity for create and update, rejects unsupported organizations',async()=>{
  const f=await fixture();
  for(const args of [['token','create','sales'],['token','update-identity','sales'],['token','create','sales','--email','sales@example.com','--crm','other']])
    expect(await f.run(args)).toBe(2);
  expect(f.fetch).not.toHaveBeenCalled();
});

it('validates and displays the extended identity metadata, rejecting hidden token fields',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;
  const item={userId:'sales',enabled:true,createdAt:'2026-10-16T00:00:00.000Z',email:'sales@example.com',
    crmConnectionId:'qx',crmOrgId:'100',crmUserId:'9',updatedAt:'2026-10-16T00:00:00.000Z'};
  f.fetch.mockResolvedValue(new Response(JSON.stringify({items:[item],nextOffset:null,requestId}),{status:200}));
  expect(await f.run(['token','list'])).toBe(0);expect(JSON.parse(f.out[0]).items[0]).toEqual(item);
  f.out.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({items:[{...item,tokenHash:'secret'}],nextOffset:null,requestId}),{status:200}));
  expect(await f.run(['token','list'])).toBe(1);expect(f.out).toHaveLength(0);
});

it('reports a known pre-write CRM configuration rejection instead of an ambiguous write',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({error:{code:'CRM_ORG_NOT_CONFIGURED'},requestId}),{status:503}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(1);
  expect(f.err.join('')).toContain('HTTP 503');expect(f.err.join('')).toContain('CRM_ORG_NOT_CONFIGURED');
  expect(f.err.join('')).toContain(requestId);expect(f.err.join('')).not.toContain('结果未知');
  expect(f.fetch).toHaveBeenCalledTimes(1);expect(f.out).toEqual([]);
});

it('retains status and request ID for an unknown server failure without reflecting private payloads',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({error:{code:'ADMIN_OPERATION_FAILED'},requestId}),{status:500}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(3);
  expect(f.err.join('')).toContain('HTTP 500');expect(f.err.join('')).toContain('ADMIN_OPERATION_FAILED');expect(f.err.join('')).toContain(requestId);
  expect(f.err.join('')).toContain('结果未知');
});

it.each(['CRM_ORG_NOT_CONFIGURED-private-secret','PRIVATE_SECRET'])('never prints arbitrary upstream error codes: %s',async code=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({error:{code},requestId}),{status:503}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(3);
  expect(f.err.join('')).not.toContain(code);expect(f.err.join('')).toContain('HTTP 503');expect(f.out).toEqual([]);
});

it('shows actionable structured 4xx errors, without retrying or exposing unknown response fields',async()=>{
  const f=await fixture();await f.run(['setup','--url','https://example.com']);f.out.length=0;f.err.length=0;
  f.fetch.mockResolvedValue(new Response(JSON.stringify({error:{code:'CRM_USER_NOT_FOUND'},requestId}),{status:422}));
  expect(await f.run(['token','create','sales','--email','sales@example.com','--crm','qx'])).toBe(1);
  expect(f.err.join('')).toContain('CRM_USER_NOT_FOUND');expect(f.err.join('')).toContain(requestId);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
