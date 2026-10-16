#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const help = `使用方法（Node 24，macOS/Linux）：
  salestools-admin setup --url https://你的服务域名
  salestools-admin token create 用户ID --email 邮箱 --crm qx|st
  salestools-admin token update-identity 用户ID --email 邮箱 --crm qx|st
  salestools-admin token rotate 用户ID
  salestools-admin token enable 用户ID
  salestools-admin token list [--limit 100 --offset 0]
  salestools-admin token disable 用户ID --all
配置：~/.config/salestools/admin.json；每个用户只有一个 Token；重发立即撤销旧 Token。
`;
const validUser = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && value === value.trim() && !/\p{C}/u.test(value);
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function origin(raw) {
  if (typeof raw !== 'string' || /[?#]/.test(raw) || raw !== raw.trim()) throw new Error('config');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || !url.hostname) throw new Error('config');
  return url.origin;
}
function argsFor(args) {
  if (args.length===3 && args[0]==='setup' && args[1]==='--url') return {action:'setup',url:origin(args[2])};
  if (args[0]==='token' && ['create','update-identity'].includes(args[1]) && validUser(args[2])) {
    const values={};
    for(let i=3;i<args.length;i+=2) {
      const key=args[i];if(!['--email','--crm'].includes(key) || values[key]!==undefined || args[i+1]===undefined) throw new Error('args');
      values[key]=args[i+1];
    }
    const email=values['--email']?.trim().toLowerCase(),crm=values['--crm'];
    if(Object.keys(values).length!==2 || !email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['qx','st'].includes(crm)) throw new Error('args');
    return {action:args[1],userId:args[2],email,crm};
  }
  if(args.length===3 && args[0]==='token' && ['rotate','enable'].includes(args[1]) && validUser(args[2])) return {action:args[1],userId:args[2]};
  if (args.length===4 && args[0]==='token' && args[1]==='disable' && validUser(args[2]) && args[3]==='--all') return {action:'disable',userId:args[2]};
  if (args[0]==='token' && args[1]==='list') {
    const values={limit:100,offset:0};const seen=new Set();
    for(let i=2;i<args.length;i+=2) {
      const key=args[i]?.slice(2),raw=args[i+1];
      if(!['--limit','--offset'].includes(args[i]) || seen.has(key) || !raw || !/^\d+$/.test(raw)) throw new Error('args');
      seen.add(key);values[key]=Number(raw);
    }
    if(!Number.isSafeInteger(values.limit) || values.limit<1 || values.limit>100
      || !Number.isSafeInteger(values.offset) || values.offset<0 || values.offset>Number.MAX_SAFE_INTEGER-100) throw new Error('args');
    return {action:'list',...values};
  }
  throw new Error('args');
}
async function directory(path, create, privateMode) {
  if(create) try { await mkdir(path,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST') throw error; }
  const stat=await lstat(path);
  if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid()
     || (privateMode ? (stat.mode&0o777)!==0o700 : (stat.mode&0o022)!==0)) throw new Error('permissions');
}
async function configPath(home, create) {
  if(typeof process.getuid!=='function') throw new Error('platform');
  await directory(home,false,false);
  const parent=join(home,'.config'),folder=join(parent,'salestools');
  await directory(parent,create,false);await directory(folder,create,true);
  return join(folder,'admin.json');
}
async function readConfig(home) {
  const path=await configPath(home,false);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile() || stat.uid!==process.getuid() || (stat.mode&0o777)!==0o600 || stat.size>4096) throw new Error('permissions');
    const data=JSON.parse(await file.readFile('utf8'));
    if(data.version!==1 || !validKey(data.adminKey) || Object.keys(data).sort().join(',')!=='adminKey,url,version') throw new Error('config');
    return {url:origin(data.url),adminKey:data.adminKey};
  } finally {await file.close();}
}
async function setup(home, url) {
  const path=await configPath(home,true);
  // Exclusive creation refuses an existing configuration or symlink.
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const adminKey=randomBytes(32).toString('base64url');
  let complete=false;
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify({version:1,url,adminKey})+'\n');await file.sync();complete=true;
  } finally {
    await file.close();
    if(!complete) await unlink(path).catch(()=>{});
  }
  return createHash('sha256').update(adminKey).digest('hex');
}
async function readResponse(response) {
  if(!response.body) throw new Error('response');
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done) break;
      bytes+=value.length;
      if(bytes>1024*1024) { await reader.cancel();throw new Error('response'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {reader.releaseLock();}
}
function keys(data, expected) {
  return data!==null && typeof data==='object' && !Array.isArray(data)
    && Object.keys(data).sort().join(',')===[...expected].sort().join(',');
}
// Only fixed server codes are printable; upstream messages may contain credentials.
const errorCodes=new Set(['INVALID_ADMIN_REQUEST','ADMIN_HOST_DENIED','ADMIN_UNAUTHORIZED','ADMIN_ORIGIN_DENIED',
  'ADMIN_RATE_LIMITED','ADMIN_CONTENT_TYPE_UNSUPPORTED','ADMIN_BODY_TOO_LARGE','ADMIN_NOT_FOUND','ADMIN_OPERATION_FAILED',
  'TOKEN_IDENTITY_CONFLICT','TOKEN_IDENTITY_CHANGED','TOKEN_USER_NOT_FOUND','CRM_ORG_NOT_CONFIGURED','CRM_ORG_MISMATCH',
  'CRM_USER_NOT_FOUND','CRM_EMAIL_AMBIGUOUS','CRM_USER_INACTIVE','ZOHO_UNAVAILABLE','ZOHO_DEADLINE_EXCEEDED',
  'ZOHO_PERMISSION_DENIED','ZOHO_AUTH_FAILED','ZOHO_TRANSIENT_ERROR','ZOHO_INVALID_RESPONSE','ZOHO_UPSTREAM_ERROR']);
function validated(data, command) {
  if(!validId(data?.requestId)) throw new Error('response');
  if(['create','rotate'].includes(command.action)) {
    if(!keys(data,['userId','token','requestId']) || data.userId!==command.userId || !validKey(data.token)) throw new Error('response');
    return data.token+'\n';
  }
  if(['disable','enable','update-identity'].includes(command.action)) {
    const field=command.action==='disable'?'disabled':command.action==='enable'?'enabled':'updated';
    if(!keys(data,['userId',field,'requestId']) || data.userId!==command.userId || typeof data[field]!=='boolean') throw new Error('response');
    return JSON.stringify({userId:data.userId,[field]:data[field],requestId:data.requestId})+'\n';
  }
  if(!keys(data,['items','nextOffset','requestId']) || !Array.isArray(data.items) || data.items.length>command.limit
    || !(data.nextOffset===null || data.nextOffset===command.offset+command.limit)
    || (data.nextOffset!==null && data.items.length!==command.limit)) throw new Error('response');
  const items=data.items.map(item=> {
    const extended=keys(item,['userId','enabled','createdAt','email','crmConnectionId','crmOrgId','crmUserId','updatedAt']);
    if(!(extended || keys(item,['userId','enabled','createdAt'])) || !validUser(item.userId) || typeof item.enabled!=='boolean'
      || typeof item.createdAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt)
      || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('response');
    if(extended && (!(item.email===null || (typeof item.email==='string' && item.email.length<=254))
      || !(item.crmConnectionId===null || ['qx','st'].includes(item.crmConnectionId))
      || ![item.crmOrgId,item.crmUserId].every(v=>v===null || (typeof v==='string' && /^\d+$/.test(v)))
      || typeof item.updatedAt!=='string' || !Number.isFinite(Date.parse(item.updatedAt)))) throw new Error('response');
    return extended?{userId:item.userId,enabled:item.enabled,createdAt:item.createdAt,email:item.email,
      crmConnectionId:item.crmConnectionId,crmOrgId:item.crmOrgId,crmUserId:item.crmUserId,updatedAt:item.updatedAt}:
      {userId:item.userId,enabled:item.enabled,createdAt:item.createdAt};
  });
  return JSON.stringify({items,nextOffset:data.nextOffset,requestId:data.requestId})+'\n';
}
export async function runAdminCli(args, io) {
  const stderr=async message=> {try {await io.stderr(message);} catch {/* Never expose exception content. */}};
  if(args.length===1 && ['--help','help'].includes(args[0])) {try {await io.stdout(help);return 0;} catch {return 1;}}
  let command;
  try {command=argsFor(args);} catch {
    await stderr('参数错误。禁用用户全部 Token 必须显式带 --all。\n'+help);return 2;
  }
  if(command.action==='setup') {
    try {
      const hash=await setup(io.home,command.url);
      await io.stdout(`配置已保存。请在 Sealos 主服务设置：\nTOKEN_ADMIN_KEY_SHA256=${hash}\n滚动更新完成后运行 token list 验证。管理员明文只保存在本机配置。\n`);return 0;
    } catch {await stderr('配置创建失败：检查目录权限、是否已有配置或存在符号链接；已有密钥不会覆盖。\n');return 2;}
  }
  let config;
  try {config=await readConfig(io.home);} catch {await stderr('配置不可用：先运行 setup；检查目录 0700、文件 0600、所有权与符号链接。\n');return 2;}
  const writing=command.action!=='list';let requestId,httpStatus,errorCode;
  const details=()=>[httpStatus?`HTTP ${httpStatus}`:null,errorCode,requestId?`requestId=${requestId}`:null].filter(Boolean).join(' ');
  try {
    const paths={create:'tokens',list:'tokens',disable:'tokens/disable-user',enable:'tokens/enable-user',rotate:'tokens/rotate','update-identity':'tokens/update-identity'};
    const path=paths[command.action];
    const query=writing?'':`?limit=${command.limit}&offset=${command.offset}`;
    const response=await io.fetch(`${config.url}/admin/v1/${path}${query}`,{
      method:writing?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${config.adminKey}`,...(writing?{'Content-Type':'application/json'}:{})},
      ...(writing?{body:JSON.stringify({userId:command.userId,...(['create','update-identity'].includes(command.action)?{email:command.email,crm:command.crm}:{})})}:{}),
    });
    httpStatus=response.status;
    if(response.status>=400) {
      const delay=response.headers.get('retry-after');
      try {
        const data=await readResponse(response);
        if(validId(data?.requestId)) requestId=data.requestId;
        if(keys(data,['error','requestId']) && keys(data.error,['code']) && validId(data.requestId) && errorCodes.has(data.error.code))
          errorCode=data.error.code;
      } catch {/* Keep status; never print unvalidated HTML, JSON or exception text. */}
      // This fixed application error is raised before CRM lookup or any database write.
      const unconfigured=['create','update-identity'].includes(command.action)
        && httpStatus===503 && errorCode==='CRM_ORG_NOT_CONFIGURED';
      if(response.status<500 || unconfigured) {
        const hint=unconfigured?'所选 CRM 组织未配置，请检查 ZOHO_CONNECTIONS、对应连接的 NAME（QX/ST）和凭证。':'';
        await stderr(`服务拒绝请求（${details()}）。${hint}${response.status===429 && /^\d{1,6}$/.test(delay??'')?`请等待 ${delay} 秒。`:''}\n`);return 1;
      }
      throw new Error('response');
    }
    if(response.status!==(command.action==='create'?201:200)) throw new Error('response');
    const data=await readResponse(response);if(validId(data?.requestId)) requestId=data.requestId;
    const output=validated(data,command);
    await io.stdout(output);
    if(['create','rotate'].includes(command.action)) await stderr('业务 Token 已创建，请保存；明文不能再次查询。\n');
    return 0;
  } catch {
    await stderr(writing?`结果未知：操作可能已完成，请勿盲目重复写入或重发 Token。请用 list 和审计日志核对。${details()?` ${details()}`:''}\n`:`查询失败，请检查网络与服务状态后重试。${details()?` ${details()}`:''}\n`);
    return writing?3:1;
  }
}
function write(stream, text) {
  return new Promise((resolvePromise,reject)=> {
    const error=err=>reject(err);stream.once('error',error);
    stream.write(text,err=> {if(err)reject(err);else {stream.removeListener('error',error);resolvePromise();}});
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode=await runAdminCli(process.argv.slice(2),{home:homedir(),fetch:globalThis.fetch,
    stdout:text=>write(process.stdout,text),stderr:text=>write(process.stderr,text)});
}
