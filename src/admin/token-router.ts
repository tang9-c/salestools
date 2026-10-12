import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { verifyAdminKey } from '../auth/admin-auth.js';
import type { TokenService } from '../auth/token-service.js';

export interface AdminAudit {
  requestId: string;
  action: 'create' | 'list' | 'disable' | 'auth';
  userId?: string;
  outcome: 'success' | 'failed';
  httpStatus: number;
  disabled?: boolean;
  attempts?: number;
}
const bodySchema = z.object({ userId: z.string().min(1).max(128)
  .refine(value => value === value.trim() && !/\p{C}/u.test(value)) }).strict();

export function createTokenAdminRouter(options: {
  keyHash: string; publicMcpHost: string;
  service: Pick<TokenService, 'create' | 'disable' | 'listPage'>;
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
  for (const [path, action] of [['/v1/tokens','create'],['/v1/tokens/disable-user','disable']] as const) {
    router.post(path,contentType,json,(request,response)=>{
      const parsed=bodySchema.safeParse(request.body);
      if (!parsed.success) { fail(response,400,'INVALID_ADMIN_REQUEST'); return; }
      const {userId}=parsed.data;
      try {
        const result=action==='create' ? {token:options.service.create(userId)} : {disabled:options.service.disable(userId)};
        const status=action==='create'?201:200;
        audit({requestId:response.locals.requestId,action,userId,outcome:'success',httpStatus:status,...('disabled' in result?{disabled:result.disabled}:{})});
        response.status(status).json({userId,...result,requestId:response.locals.requestId});
      } catch {
        audit({requestId:response.locals.requestId,action,userId,outcome:'failed',httpStatus:500});
        fail(response,500,'ADMIN_OPERATION_FAILED');
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
