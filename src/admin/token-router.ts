import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { verifyAdminKey } from '../auth/admin-auth.js';
import type { TokenAdministration } from '../auth/token-administration.js';
import type { TokenMetadata } from '../db/token-repository.js';
import { UserIdSchema, EmailSchema, CrmCodeSchema } from '../auth/token-identity.js';

export interface AdminAudit {
  requestId: string;
  action: 'create' | 'list' | 'disable' | 'enable' | 'rotate' | 'updateIdentity' | 'auth';
  before?: TokenMetadata | null;
  after?: TokenMetadata | null;
  userId?: string;
  outcome: 'success' | 'failed';
  httpStatus: number;
  disabled?: boolean;
  attempts?: number;
}
const bodySchema = z.object({ userId: UserIdSchema }).strict();
const identitySchema = bodySchema.extend({ email: EmailSchema, crm: CrmCodeSchema }).strict();

export function createTokenAdminRouter(options: {
  keyHash: string; publicMcpHost: string;
  service: TokenAdministration;
  audit: (event: AdminAudit) => void; now?: () => number;
}): express.Router {
  const router = express.Router();
  const now = options.now ?? Date.now;
  let windowStart = now(), failedAuth = 0, operations = 0;
  const audit = (event: AdminAudit) => { try { options.audit(event); } catch { /* Writes already committed must stay successful. */ } };
  const fail = (response: Response, status: number, code: string) => {
    response.status(status).json({error:{code},requestId:response.locals.requestId});
  };
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.locals.requestId = randomUUID();
    const time = now();
    if (time - windowStart >= 60000 || time < windowStart) {
      if (failedAuth) audit({requestId:response.locals.requestId,action:'auth',outcome:'failed',httpStatus:401,attempts:failedAuth});
      windowStart = time; failedAuth = 0; operations = 0;
    }
    let validHost = false;
    try {
      const raw = request.get('Host') ?? '';
      validHost = !/[@/\\?#\s]/.test(raw) && new URL(`http://${raw}`).hostname.toLowerCase() === options.publicMcpHost.toLowerCase();
    } catch { /* Invalid Host. */ }
    if (!validHost) { fail(response,403,'ADMIN_HOST_DENIED'); return; }
    const key = request.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1] ?? '';
    if (!verifyAdminKey(key, options.keyHash)) {
      failedAuth = Math.min(failedAuth + 1, 121);
      if (failedAuth > 120) {
        response.set('Retry-After', String(Math.max(1,Math.ceil((60000-(time-windowStart))/1000))));
        fail(response,429,'ADMIN_RATE_LIMITED');
      } else fail(response,401,'ADMIN_UNAUTHORIZED');
      return;
    }
    if (request.get('Origin') !== undefined) { fail(response,403,'ADMIN_ORIGIN_DENIED'); return; }
    if (operations >= 30) {
      response.set('Retry-After',String(Math.max(1,Math.ceil((60000-(time-windowStart))/1000))));
      fail(response,429,'ADMIN_RATE_LIMITED'); return;
    }
    operations += 1;
    next();
  });
  router.get('/v1/tokens', (request, response) => {
    const query = new URL(request.originalUrl, 'http://localhost').searchParams;
    const integer = (key: string, fallback: number) => {
      const raw = query.get(key);return raw === null ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
    };
    const offset = integer('offset',0), limit = integer('limit',100);
    if ([...query.keys()].some(key=>!['offset','limit'].includes(key) || query.getAll(key).length!==1)
      || !Number.isSafeInteger(offset) || offset<0 || offset>Number.MAX_SAFE_INTEGER-100
      || !Number.isSafeInteger(limit) || limit<1 || limit>100) { fail(response,400,'INVALID_ADMIN_REQUEST'); return; }
    try {
      const result=options.service.listPage(offset,limit);
      audit({requestId:response.locals.requestId,action:'list',outcome:'success',httpStatus:200});
      response.json({...result,requestId:response.locals.requestId});
    } catch {
      audit({requestId:response.locals.requestId,action:'list',outcome:'failed',httpStatus:500});
      fail(response,500,'ADMIN_OPERATION_FAILED');
    }
  });
  const contentType: RequestHandler = (request,response,next) => {
    if (!request.is('application/json') || !['identity',undefined].includes(request.get('Content-Encoding'))) {
      fail(response,415,'ADMIN_CONTENT_TYPE_UNSUPPORTED'); return;
    }
    if (new URL(request.originalUrl,'http://localhost').search) { fail(response,400,'INVALID_ADMIN_REQUEST'); return; }
    next();
  };
  const json = express.json({limit:'2kb',inflate:false,strict:true});
  for (const [path, action] of [['/v1/tokens','create'],['/v1/tokens/disable-user','disable'],
    ['/v1/tokens/enable-user','enable'],['/v1/tokens/rotate','rotate'],['/v1/tokens/update-identity','updateIdentity']] as const) {
    router.post(path,contentType,json,async(request,response)=>{
      const parsed=(action==='create' || action==='updateIdentity' ? identitySchema : bodySchema).safeParse(request.body);
      if (!parsed.success) { fail(response,400,'INVALID_ADMIN_REQUEST'); return; }
      const {userId}=parsed.data;
      let before: TokenMetadata | null = null;
      try {
        before=options.service.get(userId);
        const identity=identitySchema.safeParse(request.body);
        let result: Record<string,unknown>;
        if(action==='create' && identity.success) result={token:await options.service.create(userId,identity.data.email,identity.data.crm)};
        else if(action==='updateIdentity' && identity.success) result={updated:await options.service.updateIdentity(userId,identity.data.email,identity.data.crm)};
        else if(action==='rotate') result={token:options.service.rotate(userId)};
        else if(action==='enable') result={enabled:options.service.enable(userId)};
        else result={disabled:options.service.disable(userId)};
        const status=action==='create'?201:200;
        audit({requestId:response.locals.requestId,action,userId,outcome:'success',httpStatus:status,
          before,after:options.service.get(userId)});
        response.status(status).json({userId,...result,requestId:response.locals.requestId});
      } catch(error) {
        const code=error instanceof Error ? error.message : '';
        const status=['TOKEN_IDENTITY_CONFLICT','TOKEN_IDENTITY_CHANGED'].includes(code)?409:
          code==='TOKEN_USER_NOT_FOUND'?404:
          ['CRM_USER_NOT_FOUND','CRM_EMAIL_AMBIGUOUS','CRM_USER_INACTIVE','CRM_ORG_MISMATCH'].includes(code)?422:
          code==='CRM_ORG_NOT_CONFIGURED'?503:code.startsWith('ZOHO_')?502:500;
        audit({requestId:response.locals.requestId,action,userId,outcome:'failed',httpStatus:status});
        const safeCode = ['ZOHO_UNAVAILABLE','ZOHO_DEADLINE_EXCEEDED','ZOHO_PERMISSION_DENIED',
          'ZOHO_AUTH_FAILED','ZOHO_TRANSIENT_ERROR','ZOHO_INVALID_RESPONSE','ZOHO_UPSTREAM_ERROR'].includes(code)
          ? code : status===502?'ZOHO_UPSTREAM_ERROR':status===500?'ADMIN_OPERATION_FAILED':code;
        fail(response,status,safeCode);
      }
    });
  }
  router.use((_request,response)=>fail(response,404,'ADMIN_NOT_FOUND'));
  const errorHandler: ErrorRequestHandler=(error,_request,response,_next)=> {
    if(response.headersSent) { response.destroy(); return; }
    const tooLarge=error?.type==='entity.too.large';
    fail(response,tooLarge?413:400,tooLarge?'ADMIN_BODY_TOO_LARGE':'INVALID_ADMIN_REQUEST');
  };
  router.use(errorHandler);
  return router;
}
