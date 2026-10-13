import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, readFile, readdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ZohoClient, OfficialZohoSDKBridge, type ZohoCallContext } from '../src/upstream/zoho/client.js';
import type { ZohoConnection } from '../src/contracts/zoho-contact.js';

const connections: ZohoConnection[] = ['a', 'b'].map(id => ({ id, name: id, region: 'US', clientId: 'same-client', clientSecret: 'fake-secret', refreshToken: `synthetic-refresh-${id}` }));
const context = (ms = 3000): ZohoCallContext => ({ deadlineAt: Date.now() + ms, signal: new AbortController().signal });
class LocalBridge extends OfficialZohoSDKBridge {
  paths: string[] = [];
  constructor(private readonly base: string) { super(); }
  protected override environmentFor() { return { getUrl: () => this.base, getAccountsUrl: () => this.base + '/oauth/v2/token', getFileUploadUrl: () => this.base }; }
  override async initialize(connection: ZohoConnection, path: string, ctx: ZohoCallContext) { this.paths.push(path); await super.initialize(connection, path, ctx); }
}
async function serverFor(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  return { base: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const send = (response: ServerResponse, payload: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
async function makeReadOnly(path: string): Promise<() => Promise<void>> {
  const modes: Array<[string, number]> = [];
  async function visit(target: string) {
    const info = await stat(target); modes.push([target, info.mode & 0o777]);
    if (info.isDirectory()) for (const name of await readdir(target)) await visit(join(target, name));
    await chmod(target, info.isDirectory() ? 0o555 : 0o444);
  }
  try { await visit(path); } catch (error) { for (const [target, mode] of modes) await chmod(target, mode); throw error; }
  return async () => { for (const [target, mode] of modes) await chmod(target, mode); };
}

test('real cold SDK isolates token/fields per connection and reads whitelist with page_token', async () => {
  const calls: string[] = []; let refreshes = 0; const queries: URL[] = [];
  const local = await serverFor((request, response) => {
    const url = new URL(request.url!, 'http://local'); calls.push(url.pathname); queries.push(url);
    if (url.pathname === '/oauth/v2/token') {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        refreshes++; send(response, { access_token: body.includes('synthetic-refresh-a') ? 'access-a' : 'access-b', expires_in: 3600 });
      }); return;
    }
    const id = request.headers.authorization?.endsWith('access-a') ? 'a' : 'b';
    if (url.pathname === '/crm/v8/settings/fields') {
      const module = url.searchParams.get('module');
      send(response, { fields: [
        { api_name: module === 'Accounts' ? 'Account_Name' : 'Full_Name', data_type: 'text', custom_field: false },
        { api_name: `Connection_${id}`, data_type: 'text', custom_field: true },
        { api_name: 'Owner', data_type: 'ownerlookup', custom_field: false },
        { api_name: 'Title', data_type: 'text', custom_field: false },
      ] }); return;
    }
    if (url.pathname === '/crm/v8/settings/related_lists') {
      send(response, { related_lists: [{ api_name: 'Contacts', name: 'Contacts', module: { api_name: 'Contacts' }, href: 'Accounts/{id}/Contacts' }] }); return;
    }
    if (url.pathname.endsWith('/Contacts')) {
      send(response, { data: [{ id: '11', Full_Name: `Contact ${id}`, Title: null, Owner: { id: '9', name: '负责人', email: 'private@example.test' } }], info: { more_records: true, next_page_token: 'next-source&+#' } }); return;
    }
    send(response, { data: [{ id: '1', Account_Name: `Account ${id}`, Owner: { id: '9', name: '负责人', email: 'private@example.test' } }], info: { more_records: false } });
  });
  const bridge = new LocalBridge(local.base); const client = new ZohoClient(connections, bridge);
  try {
    expect((await client.searchAccountsPage('a', 'A&B+#', 1, context())).accounts[0]?.company_name).toBe('Account a');
    expect((await client.searchAccountsPage('b', 'Account', 1, context())).accounts[0]?.company_name).toBe('Account b');
    expect((await client.getAccount('a', '1', context())).company_name).toBe('Account a');
    expect(await client.getContactsPage('a', '1', { pageToken: 'opaque&+#token' }, context())).toEqual({ contacts: [{ record_id: '11', name: 'Contact a', title: null, contact_owner: { id: '9', name: '负责人' }, modified_at: null }], moreRecords: true, nextPageToken: 'next-source&+#' });
    expect(refreshes).toBe(2);
    expect(calls.filter(path => path === '/crm/v8/settings/fields')).toHaveLength(3);
    expect(calls).toContain('/crm/v8/settings/related_lists');
    expect(calls.some(path => path.includes('users') || path.includes('org'))).toBe(false);
    const related = queries.find(url => url.pathname.endsWith('/Contacts'))!;
    expect(related.searchParams.get('page_token')).toBe('opaque&+#token'); expect(related.searchParams.has('page')).toBe(false); expect(related.searchParams.get('per_page')).toBe('200');
    const search = queries.find(url => url.pathname.endsWith('/search'))!;
    expect(search.searchParams.get('criteria')).toBe('(Account_Name:equals:A&B+#)');
    expect([...search.searchParams.keys()].sort()).toEqual(['criteria', 'fields', 'page', 'per_page']);
    for (const [index, id] of ['a', 'b'].entries()) {
      const directory = join(bridge.paths[index]!, 'resources');
      const filenames = await readdir(directory); expect(filenames).toHaveLength(1);
      expect(filenames[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
      const metadata = await readFile(join(directory, filenames[0]!), 'utf8');
      expect(metadata).toContain(`Connection_${id}`); expect(metadata).not.toContain(`Connection_${id === 'a' ? 'b' : 'a'}`);
      expect(metadata).not.toMatch(/synthetic-refresh|access-a|access-b|Contact a|private@example/u);
    }
  } finally { await client.close(); await local.close(); }
  for (const path of bridge.paths) await expect(access(path)).rejects.toThrow();
});

test.each(['crm', 'oauth'])('real %s hanging transport times out without retry', async stage => {
  let attempts = 0;
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token' && stage === 'crm') { send(response, { access_token: 'fake-access', expires_in: 3600 }); return; }
    attempts++;
    // Leave the socket open. The SDK's actual got request must terminate it.
  });
  const client = new ZohoClient(connections, new LocalBridge(local.base)); const started = Date.now();
  try {
    await expect(client.getAccount('a', '1', context(150))).rejects.toThrow('ZOHO_DEADLINE_EXCEEDED');
    await client.close();
    expect(Date.now() - started).toBeLessThan(1000); expect(attempts).toBe(1);
  } finally { await client.close(); await local.close(); }
});

test('real OAuth revocation does not retry or cycle refresh', async () => {
  let attempts = 0;
  const local = await serverFor((_request, response) => { attempts++; send(response, { error: 'invalid_code' }, 400); });
  const client = new ZohoClient(connections, new LocalBridge(local.base));
  try { await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_AUTH_FAILED'); expect(attempts).toBe(1); }
  finally { await client.close(); await local.close(); }
});

test('real metadata permission rejection is explicit and never retries CRM', async () => {
  let fields = 0; let accounts = 0;
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token') send(response, { access_token: 'fake-access', expires_in: 3600 });
    else if (request.url?.startsWith('/crm/v8/settings/fields')) { fields++; send(response, { code: 'OAUTH_SCOPE_MISMATCH', status: 'error', message: 'Synthetic scope missing' }, 403); }
    else { accounts++; send(response, {}, 500); }
  });
  const client = new ZohoClient(connections, new LocalBridge(local.base));
  try { await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_PERMISSION_DENIED'); expect(fields).toBe(1); expect(accounts).toBe(0); }
  finally { await client.close(); await local.close(); }
});

test('cold startup works with the real SDK installation read-only', async () => {
  const installation = join(process.cwd(), 'node_modules/@zohocrm/nodejs-sdk-8.0');
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token') send(response, { access_token: 'fake-access', expires_in: 3600 });
    else if (request.url?.startsWith('/crm/v8/settings/fields')) send(response, { fields: [{ api_name: 'Account_Name', data_type: 'text', custom_field: false }] });
    else send(response, { data: [{ id: '1', Account_Name: 'Read only install' }], info: { more_records: false } });
  });
  const client = new ZohoClient(connections, new LocalBridge(local.base));
  const restore = await makeReadOnly(installation);
  try { expect((await client.getAccount('a', '1', context())).company_name).toBe('Read only install'); }
  finally { await restore(); await client.close(); await local.close(); }
});

test('SDK refreshes expired access once and restarts from configured refresh token', async () => {
  let refreshes = 0; const used: string[] = [];
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token') { refreshes++; send(response, { access_token: `fake-access-${refreshes}`, expires_in: 3600 }); }
    else if (request.url?.startsWith('/crm/v8/settings/fields')) send(response, { fields: [{ api_name: 'Account_Name', data_type: 'text', custom_field: false }] });
    else { used.push(request.headers.authorization!); send(response, { data: [{ id: '1', Account_Name: 'A' }], info: { more_records: false } }); }
  });
  const first = new ZohoClient(connections, new LocalBridge(local.base));
  try {
    await first.getAccount('a', '1', context()); await first.getAccount('a', '1', context());
    expect(refreshes).toBe(1);
    const initializerPath = '@zohocrm/nodejs-sdk-8.0/lib/routes/initializer.js';
    const { Initializer } = await import(initializerPath);
    (await Initializer.getInitializer()).getToken().setExpiresIn(String(Date.now() - 1));
    await first.getAccount('a', '1', context()); expect(refreshes).toBe(2);
    expect(used).toEqual(['Zoho-oauthtoken fake-access-1', 'Zoho-oauthtoken fake-access-1', 'Zoho-oauthtoken fake-access-2']);
    await first.close();
    const restarted = new ZohoClient(connections, new LocalBridge(local.base));
    try { await restarted.getAccount('a', '1', context()); expect(refreshes).toBe(3); } finally { await restarted.close(); }
  } finally { await first.close(); await local.close(); }
});

test('cold metadata consumed deadline prevents the next CRM request from starting', async () => {
  let accountCalls = 0;
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token') send(response, { access_token: 'fake-access', expires_in: 3600 });
    else if (request.url?.startsWith('/crm/v8/settings/fields')) setTimeout(() => send(response, { fields: [{ api_name: 'Account_Name', data_type: 'text', custom_field: false }] }), 90);
    else { accountCalls++; /* hang */ }
  });
  const client = new ZohoClient(connections, new LocalBridge(local.base)); const start = Date.now();
  try {
    await expect(client.getAccount('a', '1', context(120))).rejects.toThrow('ZOHO_DEADLINE_EXCEEDED');
    await client.close(); expect(Date.now() - start).toBeLessThan(180); expect(accountCalls).toBeLessThanOrEqual(1);
  } finally { await client.close(); await local.close(); }
});

test('real CRM transient error has exactly one business retry with cached access token', async () => {
  let attempts = 0; let refreshes = 0;
  const local = await serverFor((request, response) => {
    if (request.url === '/oauth/v2/token') { refreshes++; send(response, { access_token: 'fake-access', expires_in: 3600 }); }
    else if (request.url?.startsWith('/crm/v8/settings/fields')) send(response, { fields: [{ api_name: 'Account_Name', data_type: 'text', custom_field: false }] });
    else { attempts++; send(response, { code: 'INTERNAL_ERROR', status: 'error', message: 'Synthetic unavailable' }, 503); }
  });
  const client = new ZohoClient(connections, new LocalBridge(local.base));
  try { await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_TRANSIENT_ERROR'); expect(attempts).toBe(2); expect(refreshes).toBe(1); }
  finally { await client.close(); await local.close(); }
});
