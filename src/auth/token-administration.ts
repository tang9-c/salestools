import type { TokenService } from './token-service.js';
import { CrmCodeSchema, EmailSchema, UserIdSchema, type TokenIdentity } from './token-identity.js';
import type { ZohoCallContext, ZohoClient } from '../upstream/zoho/client.js';

export class TokenAdministration {
  constructor(readonly tokens: TokenService,
    private readonly client: Pick<ZohoClient, 'getOrganization' | 'getUsersPage'>,
    private readonly connections: readonly { id: string; orgId?: string }[]) {}

  private async resolve(email: string, crm: string): Promise<TokenIdentity> {
    email = EmailSchema.parse(email); CrmCodeSchema.parse(crm);
    const connection = this.connections.find(item => item.id === crm);
    if (!connection?.orgId) throw new Error('CRM_ORG_NOT_CONFIGURED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const context: ZohoCallContext = { deadlineAt: Date.now() + 12000, signal: controller.signal };
    try {
      const orgId = await this.client.getOrganization(crm, context);
      if (orgId !== connection.orgId) throw new Error('CRM_ORG_MISMATCH');
      const matches = new Map<string, { id: string; status: string; confirmed: boolean }>();
      for (let page = 1; ; page++) {
        if (controller.signal.aborted || Date.now() >= context.deadlineAt) throw new Error('ZOHO_DEADLINE_EXCEEDED');
        const result = await this.client.getUsersPage(crm, page, context);
        for (const user of result.users) {
          if (user.email?.trim().toLowerCase() === email) matches.set(user.id, user);
        }
        if (matches.size > 1) throw new Error('CRM_EMAIL_AMBIGUOUS');
        if (!result.moreRecords) break;
      }
      const user = [...matches.values()][0];
      if (!user) throw new Error('CRM_USER_NOT_FOUND');
      if (user.status !== 'active' || !user.confirmed) throw new Error('CRM_USER_INACTIVE');
      return { email, crmConnectionId: CrmCodeSchema.parse(crm), crmOrgId: orgId, crmUserId: user.id };
    } finally { clearTimeout(timer); }
  }

  async create(userId: string, email: string, crm: string): Promise<string> {
    UserIdSchema.parse(userId); email = EmailSchema.parse(email); CrmCodeSchema.parse(crm);
    if (this.tokens.get(userId) || this.tokens.emailOwner(email)) throw new Error('TOKEN_IDENTITY_CONFLICT');
    return this.tokens.create(userId, await this.resolve(email, crm));
  }
  async updateIdentity(userId: string, email: string, crm: string): Promise<boolean> {
    UserIdSchema.parse(userId); email = EmailSchema.parse(email); CrmCodeSchema.parse(crm);
    const expected = this.tokens.record(userId);
    if (!expected) throw new Error('TOKEN_USER_NOT_FOUND');
    const owner = this.tokens.emailOwner(email);
    if (owner && owner.userId !== userId) throw new Error('TOKEN_IDENTITY_CONFLICT');
    const identity = await this.resolve(email, crm);
    this.tokens.updateIdentity(expected, identity);
    return true;
  }
  rotate(userId: string): string { UserIdSchema.parse(userId); return this.tokens.rotate(userId); }
  enable(userId: string): boolean { UserIdSchema.parse(userId); return this.tokens.enable(userId); }
  disable(userId: string): boolean { UserIdSchema.parse(userId); return this.tokens.disable(userId); }
  get(userId: string) { return this.tokens.get(userId); }
  list() { return this.tokens.list(); }
  listPage(offset: number, limit: number) { return this.tokens.listPage(offset, limit); }
}
