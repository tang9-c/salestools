import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZohoConnection, ZohoAccountCandidate, ZohoContact, ZohoOwner } from '../../contracts/zoho-contact.js';

export type ZohoAccount = ZohoAccountCandidate;
export type ZohoCallContext = { deadlineAt: number; signal: AbortSignal };
export type ZohoCursor = { page: number } | { pageToken: string };
export type ZohoSDKPage = { records: unknown[]; moreRecords: boolean; nextPageToken: string | null };
export type ZohoUser = { id: string; email: string | null; status: string; confirmed: boolean };
export interface ZohoSDKBridge {
  initialize(connection: ZohoConnection, resourcePath: string, context: ZohoCallContext): Promise<void>;
  searchAccounts(criteria: string, page: number): Promise<ZohoSDKPage>;
  getAccount(accountId: string): Promise<ZohoSDKPage>;
  getContacts(accountId: string, cursor: ZohoCursor): Promise<ZohoSDKPage>;
  getOrganization?(): Promise<ZohoSDKPage>;
  getUsers?(page: number): Promise<ZohoSDKPage>;
}

// SDK state is process-global: even separate client instances share this chain.
let tail: Promise<void> = Promise.resolve();
const fail = (code: string): never => { throw new Error(code); };
function remaining(context: ZohoCallContext): number {
  const ms = context.deadlineAt - Date.now();
  if (context.signal.aborted || ms <= 0) return fail('ZOHO_DEADLINE_EXCEEDED');
  return Math.min(15000, ms);
}
const value = (record: unknown, key: string): unknown => {
  if (!record || typeof record !== 'object') return null;
  const sdk = record as { getKeyValue?: (key: string) => unknown };
  return sdk.getKeyValue ? sdk.getKeyValue(key) : (record as Record<string, unknown>)[key];
};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'bigint' ? v.toString() : null;
function owner(v: unknown): ZohoOwner | null {
  if (!v || typeof v !== 'object') return null;
  const sdk = v as { getId?: () => unknown; getName?: () => unknown };
  return { id: text(sdk.getId ? sdk.getId() : value(v, 'id')), name: text(sdk.getName ? sdk.getName() : value(v, 'name')) };
}
function account(record: unknown): ZohoAccount {
  return { account_id: text(value(record, 'id')) ?? fail('ZOHO_INVALID_RESPONSE'), company_name: text(value(record, 'Account_Name')) ?? fail('ZOHO_INVALID_RESPONSE'), account_owner: owner(value(record, 'Owner')) };
}
function contact(record: unknown): ZohoContact {
  const modified = value(record, 'Modified_Time');
  return {
    record_id: text(value(record, 'id')) ?? fail('ZOHO_INVALID_RESPONSE'),
    name: text(value(record, 'Full_Name')) ?? ([text(value(record, 'First_Name')), text(value(record, 'Last_Name'))].filter(Boolean).join(' ') || '姓名未提供'),
    title: text(value(record, 'Title')), contact_owner: owner(value(record, 'Owner')),
    modified_at: modified instanceof Date && Number.isFinite(modified.getTime()) ? modified.toISOString() : text(modified),
  };
}
function pageValid(page: unknown) { if (!Number.isInteger(page) || Number(page) < 1) fail('ZOHO_INVALID_INPUT'); }

export class ZohoClient {
  private readonly connections: Map<string, ZohoConnection>;
  private root: string | undefined;
  private closed = false;
  private readonly paths = new Map<string, string>();
  constructor(connections: readonly ZohoConnection[], private readonly sdk: ZohoSDKBridge = new OfficialZohoSDKBridge()) {
    this.connections = new Map(connections.map(connection => [connection.id, connection]));
  }
  private run<T>(id: string, context: ZohoCallContext, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ZOHO_UNAVAILABLE'));
    const run = tail.then(async () => {
      remaining(context);
      const connection = this.connections.get(id) ?? fail('ZOHO_UNKNOWN_CONNECTION');
      let path = this.paths.get(id);
      if (!path) {
        try {
          this.root ??= await mkdtemp(join(tmpdir(), 'salestools-zoho-'));
          await chmod(this.root, 0o700);
          path = join(this.root, id);
          await mkdir(path, { mode: 0o700 });
          this.paths.set(id, path);
        } catch { return fail('ZOHO_UNAVAILABLE'); }
      }
      for (let attempt = 0; ; attempt++) {
        remaining(context);
        try {
          await this.sdk.initialize(connection, path, context);
          remaining(context);
          return await operation();
        } catch (error) {
          if (attempt || !(error instanceof Error) || error.message !== 'ZOHO_TRANSIENT_ERROR') throw error;
        }
      }
    });
    tail = run.then(() => undefined, () => undefined);
    // Caller cancellation releases only its wait; SDK ownership stays with actual run.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('ZOHO_DEADLINE_EXCEEDED')); };
      const timer = setTimeout(abort, Math.max(0, context.deadlineAt - Date.now()));
      const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); };
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
      run.then(result => {
        if (context.signal.aborted || Date.now() >= context.deadlineAt) abort();
        else { cleanup(); resolve(result); }
      }, error => { cleanup(); reject(error); });
    });
  }
  async searchAccountsPage(id: string, query: string, page: number, context: ZohoCallContext) {
    pageValid(page);
    if (!query.trim()) fail('ZOHO_INVALID_INPUT');
    const criteria = `(Account_Name:equals:${query.replace(/[\\(),:]/gu, '\\$&')})`;
    return this.run(id, context, async () => { const result = await this.sdk.searchAccounts(criteria, page); return { accounts: result.records.map(account), moreRecords: result.moreRecords }; });
  }
  async getAccount(id: string, accountId: string, context: ZohoCallContext): Promise<ZohoAccount> {
    if (!/^\d+$/u.test(accountId)) fail('ZOHO_INVALID_INPUT');
    return this.run(id, context, async () => { const result = await this.sdk.getAccount(accountId); return account(result.records[0] ?? fail('ZOHO_RECORD_NOT_FOUND')); });
  }
  async getContactsPage(id: string, accountId: string, cursor: ZohoCursor, context: ZohoCallContext) {
    if (!/^\d+$/u.test(accountId) || ('page' in cursor) === ('pageToken' in cursor)) fail('ZOHO_INVALID_INPUT');
    if ('page' in cursor) pageValid(cursor.page); else if (!cursor.pageToken.trim()) fail('ZOHO_INVALID_INPUT');
    return this.run(id, context, async () => { const result = await this.sdk.getContacts(accountId, cursor); return { contacts: result.records.map(contact), moreRecords: result.moreRecords, nextPageToken: result.nextPageToken }; });
  }
  async close(): Promise<void> {
    this.closed = true;
    await tail;
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
  async getOrganization(id: string, context: ZohoCallContext): Promise<string> {
    return this.run(id, context, async () => {
      const result = await this.sdk.getOrganization?.() ?? fail('ZOHO_UNAVAILABLE');
      if (result.records.length !== 1) return fail('ZOHO_INVALID_RESPONSE');
      const orgId = text(userValue(result.records[0], 'id', 'getId'));
      return orgId && /^\d+$/u.test(orgId) ? orgId : fail('ZOHO_INVALID_RESPONSE');
    });
  }
  async getUsersPage(id: string, page: number, context: ZohoCallContext): Promise<{ users: ZohoUser[]; moreRecords: boolean }> {
    pageValid(page);
    return this.run(id, context, async () => {
      const result = await this.sdk.getUsers?.(page) ?? fail('ZOHO_UNAVAILABLE');
      return { users: result.records.map(record => ({
        id: numericUserId(record),
        email: text(userValue(record, 'email', 'getEmail')),
        status: text(userValue(record, 'status', 'getStatus')) ?? '',
        confirmed: userValue(record, 'confirm', 'getConfirm') === true,
      })), moreRecords: result.moreRecords };
    });
  }
}

function userValue(record: unknown, key: string, getter: string): unknown {
  if (!record || typeof record !== 'object') return null;
  const method = (record as Record<string, unknown>)[getter];
  return typeof method === 'function' ? method.call(record) : value(record, key);
}
function numericUserId(record: unknown): string {
  const id = text(userValue(record, 'id', 'getId'));
  return id && /^\d+$/u.test(id) ? id : fail('ZOHO_INVALID_RESPONSE');
}

/** One store per connection; identity never falls back to client ID. */
export class MemoryZohoTokenStore {
  private token: any = null;
  async findToken(_token: unknown) { return this.token; }
  async findTokenById(id: string) { return this.token?.getId() === id ? this.token : null; }
  async saveToken(token: any) { this.token = token; }
  async deleteToken(id: string) { if (this.token?.getId() === id) this.token = null; }
  async getTokens() { return this.token ? [this.token] : []; }
  async deleteTokens() { this.token = null; }
}

/** Startup gate for Task 4: check installed bytes only; no SDK import or network. */
export async function verifyZohoSDKPatch(): Promise<void> {
  try {
    const patchPath = new URL('../../../scripts/patch-zoho-sdk.mjs', import.meta.url).href;
    await (await import(patchPath)).checkZohoSDK();
  } catch (error) { throw normalizeError(error); }
}

// Upstream publishes JS without declarations. Keep its untyped surface inside this bridge.
export class OfficialZohoSDKBridge implements ZohoSDKBridge {
  private states = new Map<string, { token: any; store: MemoryZohoTokenStore }>();
  private context!: ZohoCallContext;
  private sdk: any;
  private verified = false;
  async initialize(connection: ZohoConnection, path: string, context: ZohoCallContext) {
    this.context = context;
    if (!this.verified) {
      await verifyZohoSDKPatch();
      this.verified = true;
    }
    if (!this.sdk) {
      // Public entry orders the SDK's cyclic ESM graph correctly. Parallel deep
      // imports can evaluate JSONConverter before its Converter base class.
      const packageName = '@zohocrm/nodejs-sdk-8.0';
      const sdk = await import(packageName);
      this.sdk = { ...sdk, ...sdk.Record, ...sdk.RelatedRecords };
    }
    const sdk = this.sdk;
    let state = this.states.get(connection.id);
    if (!state) {
      const token = new sdk.OAuthToken(connection.clientId, connection.clientSecret, null, connection.refreshToken, null, null, null, null, false);
      const original = token.getResponse.bind(token);
      token.getResponse = (url: string, details: unknown) => original(url, { ...(details as object), timeout: { request: remaining(this.context) }, retry: { limit: 0 } });
      state = { token, store: new MemoryZohoTokenStore() };
      this.states.set(connection.id, state);
    }
    const environment = this.environmentFor(connection.region);
    const config = new sdk.SDKConfigBuilder().autoRefreshFields(false).pickListValidation(false).updateAPIDomain(false).timeout(remaining(context)).build();
    // The same SDK operation may perform metadata then records; recompute each
    // transport's timeout from the shared absolute deadline, without global patches.
    config.getTimeout = () => remaining(context);
    try {
      // switchUser inherits paths/stores, so initialize is required for account isolation.
      await sdk.Initializer.initialize(environment, state.token, state.store, config, path + '/', sdk.Logger.getInstance(sdk.Levels.OFF, null));
    } catch (error) { throw normalizeError(error); }
  }
  protected environmentFor(region: ZohoConnection['region']): unknown {
    return this.sdk[`${region}DataCenter`].PRODUCTION();
  }
  private async parameters(entries: Array<[any, unknown]>) {
    const params = new this.sdk.ParameterMap();
    for (const [key, v] of entries) await params.add(key, v);
    return params;
  }
  private async response(request: () => Promise<any>, collection: 'data' | 'users' | 'org' = 'data'): Promise<ZohoSDKPage> {
    remaining(this.context);
    try {
      const response = await request();
      if (!response) return fail('ZOHO_INVALID_RESPONSE');
      const status = response.getStatusCode();
      if (status === 204) return { records: [], moreRecords: false, nextPageToken: null };
      if (status >= 500 || status === 429) return fail('ZOHO_TRANSIENT_ERROR');
      if (status === 401) return fail('ZOHO_AUTH_FAILED');
      if (status === 403) return fail('ZOHO_PERMISSION_DENIED');
      if (status === 404) return fail('ZOHO_RECORD_NOT_FOUND');
      if (status >= 400) return fail('ZOHO_UPSTREAM_ERROR');
      const parsed = response.getObject();
      const records = collection === 'users' ? parsed?.getUsers?.() : collection === 'org' ? parsed?.getOrg?.() : parsed?.getData?.();
      if (!Array.isArray(records)) return fail('ZOHO_INVALID_RESPONSE');
      const raw = response.getResponseJSON();
      const info = typeof raw === 'string' ? JSON.parse(raw)?.info : raw?.info;
      if (collection === 'users' && typeof info?.more_records !== 'boolean') return fail('ZOHO_INVALID_RESPONSE');
      return { records, moreRecords: info?.more_records === true, nextPageToken: text(info?.next_page_token) };
    } catch (error) { throw normalizeError(error); }
  }
  async searchAccounts(criteria: string, page: number) {
    const p = this.sdk.SearchRecordsParam;
    const params = await this.parameters([[p.CRITERIA, criteria], [p.PAGE, page], [p.PER_PAGE, 200], [p.FIELDS, 'id,Account_Name,Owner']]);
    return this.response(() => new this.sdk.RecordOperations('Accounts').searchRecords(params));
  }
  async getOrganization() {
    return this.response(() => new this.sdk.Org.OrgOperations().getOrganization(), 'org');
  }
  async getUsers(page: number) {
    const p = this.sdk.Users.GetUsersParam;
    const params = await this.parameters([[p.TYPE, 'AllUsers'], [p.PAGE, page], [p.PER_PAGE, 200]]);
    return this.response(() => new this.sdk.Users.UsersOperations().getUsers(params), 'users');
  }
  async getAccount(accountId: string) {
    const params = await this.parameters([[this.sdk.GetRecordParam.FIELDS, 'id,Account_Name,Owner']]);
    return this.response(() => new this.sdk.RecordOperations('Accounts').getRecord(BigInt(accountId), params));
  }
  async getContacts(accountId: string, cursor: ZohoCursor) {
    const p = this.sdk.GetRelatedRecordsParam;
    // SDK Param explicitly supports unclassified parameters; v4 omits PAGE_TOKEN constant.
    const params = await this.parameters([[p.FIELDS, 'id,Full_Name,First_Name,Last_Name,Title,Account_Name,Owner,Modified_Time'], [p.PER_PAGE, 200], ['page' in cursor ? p.PAGE : new this.sdk.Param('page_token'), 'page' in cursor ? cursor.page : cursor.pageToken]]);
    return this.response(() => new this.sdk.RelatedRecordsOperations('Contacts', 'Accounts').getRelatedRecords(BigInt(accountId), params));
  }
}
function normalizeError(error: unknown): Error {
  const e = error as { message?: string; code?: string; details?: { code?: string }; cause?: unknown };
  if (e?.message?.startsWith('ZOHO_')) return new Error(e.message);
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ERR_ABORTED') return new Error('ZOHO_DEADLINE_EXCEEDED');
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(e?.code ?? '')) return new Error('ZOHO_TRANSIENT_ERROR');
  if (e?.code === 'INVALID TOKEN ERROR') return new Error('ZOHO_AUTH_FAILED');
  if (['OAUTH_SCOPE_MISMATCH', 'NO_PERMISSION', 'AUTHORIZATION_FAILED'].includes(e?.details?.code ?? '')) return new Error('ZOHO_PERMISSION_DENIED');
  if (e?.details?.code === 'INVALID_TOKEN') return new Error('ZOHO_AUTH_FAILED');
  if (e?.cause) return normalizeError(e.cause);
  return new Error('ZOHO_UPSTREAM_ERROR');
}
