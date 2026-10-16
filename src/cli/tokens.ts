import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config as loadDotEnv } from 'dotenv';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { TokenRepository } from '../db/token-repository.js';
import { TokenService } from '../auth/token-service.js';
import { TokenAdministration } from '../auth/token-administration.js';
import { UserIdSchema, EmailSchema, CrmCodeSchema } from '../auth/token-identity.js';
import { ZohoClient } from '../upstream/zoho/client.js';
import { JsonlLogger } from '../logging/logger.js';
import type { AdminAudit } from '../admin/token-router.js';

type TokenCliService = Pick<TokenAdministration, 'create' | 'updateIdentity' | 'rotate' | 'enable' | 'disable' | 'get' | 'list'>;
type Write = (value: string) => void;
export async function runTokenCli(args: string[], service: TokenCliService, write: Write,
  audit: (event: AdminAudit) => void = () => {}): Promise<number> {
  if (args.length===1 && args[0]==='tokens:list') { write(`${JSON.stringify(service.list())}\n`); return 0; }
  const action = args[0]?.slice(7);
  if (!args[0]?.startsWith('tokens:') || !['create','update-identity','rotate','enable','disable'].includes(action)) return 2;
  const values: Record<string,string> = {};
  for (let index=1;index<args.length;index+=2) {
    const key=args[index];
    if (!['--user','--email','--crm'].includes(key) || values[key]!==undefined || args[index+1]===undefined) return 2;
    values[key]=args[index+1];
  }
  const identity = action==='create' || action==='update-identity';
  const user=UserIdSchema.safeParse(values['--user']);
  const email=EmailSchema.safeParse(values['--email']);
  const crm=CrmCodeSchema.safeParse(values['--crm']);
  if (!user.success || (identity ? !email.success || !crm.success || Object.keys(values).length!==3 : Object.keys(values).length!==1)) return 2;
  const userId=user.data,requestId=randomUUID();
  let before: ReturnType<TokenCliService['get']> = null;
  let committed=false;
  const record=(event: AdminAudit)=>{try {audit(event);} catch {/* Never repeat a completed mutation because logging failed. */}};
  const auditAction=action==='update-identity'?'updateIdentity':action as AdminAudit['action'];
  try {
    before=service.get(userId);
    let result: string | boolean;
    if (action==='create' && email.success && crm.success) result=await service.create(userId,email.data,crm.data);
    else if(action==='update-identity' && email.success && crm.success) result=await service.updateIdentity(userId,email.data,crm.data);
    else if(action==='rotate') result=service.rotate(userId);
    else if(action==='enable') result=service.enable(userId);
    else result=service.disable(userId);
    committed=true;
    record({requestId,action:auditAction,userId,before,after:service.get(userId),outcome:'success',httpStatus:action==='create'?201:200});
    write(typeof result==='string'?`${result}\n`:`${JSON.stringify({userId,[action==='update-identity'?'updated':action==='enable'?'enabled':'disabled']:result})}\n`);
    return 0;
  } catch(error) {
    if(!committed) record({requestId,action:auditAction,userId,outcome:'failed',httpStatus:500});
    throw error;
  }
}

export async function runConfiguredTokenCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  write: Write = value => process.stdout.write(value)): Promise<number> {
  const config=loadConfig(env),database=openDatabase(config.sqlitePath);
  const client=new ZohoClient(config.zohoConnections);
  const service=new TokenAdministration(new TokenService(new TokenRepository(database)),client,config.zohoConnections);
  const logger=new JsonlLogger({write:line=>process.stderr.write(line)});
  try { return await runTokenCli(args,service,write,event=>logger.logAdminTokenOperation(event)); }
  finally { await client.close(); database.close(); }
}
if(process.argv[1]!==undefined && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.env.NODE_ENV!=='production') loadDotEnv({quiet:true});
  try { process.exitCode=await runConfiguredTokenCli(process.argv.slice(2)); }
  catch(error) {
    const code=error instanceof Error ? error.message : '';
    // Fixed codes only; never print SDK responses, paths, credentials or validation payloads.
    process.stderr.write(`${/^(TOKEN_|CRM_|ZOHO_)[A-Z_]+$/.test(code)?code:'TOKEN_OPERATION_FAILED'}\n`);
    process.exitCode=1;
  }
}
