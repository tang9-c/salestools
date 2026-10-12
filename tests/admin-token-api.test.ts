import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import { createTokenAdminRouter } from '../src/admin/token-router.js';
import { TokenRepository } from '../src/db/token-repository.js';
import { TokenService } from '../src/auth/token-service.js';
import { SCHEMA_SQL } from '../src/db/schema.js';

const key='A'.repeat(43), hash=createHash('sha256').update(key).digest('hex');
let server: Server, db: DatabaseSync | undefined;
let closeHandler: (()=>Promise<void>) | undefined;
afterEach(async () => { if(server) await new Promise<void>(resolve=>server.close(()=>resolve())); if(closeHandler) await closeHandler();closeHandler=undefined;db?.close(); db=undefined; });
async function start(audit: (event: unknown)=>void = ()=>{}, now?: ()=>number) {
  db=new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); const service=new TokenService(new TokenRepository(db));
  const app=createHttpApp({publicMcpHost:'127.0.0.1',allowedOriginUrls:new Set(),allowedOriginHostnames:new Set()},
    token=>service.verify(token),()=>{throw new Error('not used');},undefined,undefined,
    createTokenAdminRouter({keyHash:hash,publicMcpHost:'127.0.0.1',service,audit,now}));
  closeHandler=()=>app.closeMcpHandler();
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1`;
  const call=(path:string, body?:unknown, headers:Record<string,string>={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${key}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {service,call,url};
}
it('creates, lists and disables every token of a user without logging secrets',async()=>{
  const events:unknown[]=[];const {service,call}=await start(e=>events.push(e));
  const response=await call('/tokens',{userId:'sales'});expect(response.status).toBe(201);expect(response.headers.get('cache-control')).toBe('no-store');
  const result=await response.json();expect(service.verify(result.token)).toEqual({userId:'sales'});
  const second=service.create('sales');const listing=await (await call('/tokens?limit=1')).json();expect(listing.items).toHaveLength(1);expect(listing.nextOffset).toBe(1);
  expect(JSON.stringify(listing)).not.toContain(result.token);
  expect(await (await call('/tokens/disable-user',{userId:'sales'})).json()).toMatchObject({disabled:true});
  expect(service.verify(result.token)).toBeNull();expect(service.verify(second)).toBeNull();
  expect(await (await call('/tokens/disable-user',{userId:'sales'})).json()).toMatchObject({disabled:false});
  expect(JSON.stringify(events)).not.toContain(result.token);expect(JSON.stringify(events)).not.toContain(key);expect(JSON.stringify(events)).not.toContain(hash);
});
it('rejects business credentials, origins and bad hosts',async()=>{
  const {service,call,url}=await start();const business=service.create('sales');
  expect((await call('/tokens',undefined,{Authorization:`Bearer ${business}`})).status).toBe(401);
  expect(service.verify(key)).toBeNull();
  expect((await fetch(url.replace('/admin/v1','/mcp'),{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
  expect((await call('/tokens',undefined,{Origin:'https://example.com'})).status).toBe(403);
  const badHost = await new Promise<number>(resolve => { const req=httpRequest(url+'/tokens', {headers:{Host:'evil.example',Authorization:`Bearer ${key}`}}, response=>{response.resume();response.once('end',()=>resolve(response.statusCode!));});req.end(); });
  expect(badHost).toBe(403);
  expect((await call('/tokens',undefined,{Authorization:'',Cookie:`admin=${key}`})).status).toBe(401);
});
it.each([{userId:''},{userId:' x'},{userId:'a\n'},{userId:'x',extra:'secret'},[],{userId:'a'.repeat(129)}])('rejects invalid body %j',async body=>{
  const {call}=await start();expect((await call('/tokens',body)).status).toBe(400);
});
it.each(['?limit=0','?limit=101','?offset=-1','?offset=1.1','?limit=1&limit=2','?secret=x'])('rejects bad pagination %s',async query=>{
  const {call}=await start();expect((await call('/tokens'+query)).status).toBe(400);
});
it('limits JSON and returns fixed errors rather than parser messages',async()=>{
  const {url,call}=await start();
  expect((await call('/tokens',{userId:'x'},{'Content-Type':'text/plain'})).status).toBe(415);
  expect((await call('/tokens',{userId:'x'},{'Content-Encoding':'gzip'})).status).toBe(415);
  const r=await fetch(url+'/tokens',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:'{"private-secret":'});
  expect(r.status).toBe(400);expect(await r.text()).not.toContain('private-secret');
  expect((await call('/tokens',{userId:'x'.repeat(3000)})).status).toBe(413);
});
it('limits invalid auth separately from valid operations and resets the window',async()=>{
  let now=0;const {call}=await start(()=>{},()=>now);
  for(let i=0;i<120;i++) expect((await call('/tokens',undefined,{Authorization:'Bearer invalid'})).status).toBe(401);
  expect((await call('/tokens',undefined,{Authorization:'Bearer invalid'})).status).toBe(429);
  expect((await call('/tokens')).status).toBe(200);
  for(let i=1;i<30;i++) await call('/tokens');
  const limited=await call('/tokens');expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).toBe('60');
  now=60000;expect((await call('/tokens')).status).toBe(200);
});
it('audit errors cannot turn a successful creation into an unknown write',async()=>{
  const {call}=await start(()=>{throw new Error('private');});expect((await call('/tokens',{userId:'sales'})).status).toBe(201);
});

it('preserves revoked source-token checks in upload sessions',async()=>{
  const { UploadSessions }=await import('../src/contacts/upload-session.js');
  const {service,call}=await start();const token=service.create('sales');
  const sessions=new UploadSessions((hash,actor)=>service.isEnabledHash(hash,actor));
  const created=sessions.create('sales',service.hash(token));
  expect(sessions.authorize(created.sessionId,created.bearer)).not.toBeNull();
  await call('/tokens/disable-user',{userId:'sales'});
  expect(sessions.authorize(created.sessionId,created.bearer)).toBeNull();
});
it('returns generic errors and a failed audit when token storage fails',async()=>{
  const events:unknown[]=[];const {call,service}=await start(e=>events.push(e));
  service.create=()=>{throw new Error('private-database-path');};
  const r=await call('/tokens',{userId:'sales'});expect(r.status).toBe(500);
  expect(await r.text()).not.toContain('private-database-path');
  expect(events).toEqual([expect.objectContaining({action:'create',outcome:'failed',httpStatus:500})]);
});
it('mounts on the real HTTP app and stays disabled without admin config',async()=>{
  const {createHttpApp}=await import('../src/mcp/http-app.js');
  const config={publicMcpHost:'127.0.0.1',allowedOriginUrls:new Set<string>(),allowedOriginHostnames:new Set<string>()};
  const app=createHttpApp(config,()=>null,()=>{throw new Error('unauthorized');});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {expect((await fetch(base+'/admin/v1/tokens')).status).toBe(404);expect((await fetch(base+'/healthz')).status).toBe(200);}
  finally {await app.closeMcpHandler();}
});

it('serializes audit through the logger with an explicit field allowlist',async()=>{
  const {JsonlLogger}=await import('../src/logging/logger.js');const lines:string[]=[];
  const logger=new JsonlLogger({write:line=>lines.push(line)});
  const {call}=await start(event=>logger.logAdminTokenOperation(event as import('../src/admin/token-router.js').AdminAudit));
  await call('/tokens',{userId:'audit-user'});
  const log=JSON.parse(lines[0]);expect(log).toMatchObject({event:'admin_token_operation',actor:'token-admin',action:'create',userId:'audit-user'});
  logger.logAdminTokenOperation({...log,token:'private-token',credential:'private-credential'});
  expect(lines.join('')).not.toContain('private-');
});
