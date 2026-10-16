import { createHash } from 'node:crypto';
import type { TokenService } from '../../src/auth/token-service.js';

/** Synthetic confirmed identity; never contacts a live CRM. */
export function createTestToken(service: TokenService, userId: string): string {
  return service.create(userId, { email: `${userId}@example.test`, crmConnectionId: 'qx', crmOrgId: '100',
    crmUserId: BigInt('0x' + createHash('sha256').update(userId).digest('hex').slice(0,16)).toString() });
}
