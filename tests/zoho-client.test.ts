import { expect, test, vi } from 'vitest';
import { stat, readdir, access } from 'node:fs/promises';
import { ZohoClient, MemoryZohoTokenStore, type ZohoSDKBridge, type ZohoCallContext } from '../src/upstream/zoho/client.js';
import type { ZohoConnection } from '../src/contracts/zoho-contact.js';

const connections: ZohoConnection[] = ['a', 'b'].map(id => ({ id, name: id, region: 'US', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: `synthetic-refresh-${id}` }));
const context = (ms = 1000): ZohoCallContext => ({ deadlineAt: Date.now() + ms, signal: new AbortController().signal });
function bridge(): ZohoSDKBridge {
  return {
    initialize: vi.fn(async () => undefined),
    searchAccounts: vi.fn(async () => ({ records: [{ id: '1', Account_Name: 'ACME', Owner: { id: '9', name: '负责人', email: 'private@example.test' }, Phone: 'private' }], moreRecords: false, nextPageToken: null })),
    getAccount: vi.fn(async () => ({ records: [{ id: '1', Account_Name: 'ACME' }], moreRecords: false, nextPageToken: null })),
    getContacts: vi.fn(async () => ({ records: [{ id: '2', First_Name: '甲', Last_Name: '乙', Title: null, Owner: { id: '8', name: '管理人', email: 'private@example.test' } }], moreRecords: true, nextPageToken: 'next' })),
  };
}

test('projects account/contact whitelist, escapes criteria, and keeps token/page exclusive', async () => {
  const sdk = bridge(); const client = new ZohoClient(connections, sdk);
  try {
    const accounts = await client.searchAccountsPage('a', 'A,(B):\\C', 2, context());
    expect(accounts).toEqual({ accounts: [{ account_id: '1', company_name: 'ACME', account_owner: { id: '9', name: '负责人' } }], moreRecords: false });
    expect(sdk.searchAccounts).toHaveBeenCalledWith('(Account_Name:equals:A\\,\\(B\\)\\:\\\\C)', 2);
    expect(await client.getContactsPage('a', '1', { pageToken: 'next' }, context())).toEqual({ contacts: [{ record_id: '2', name: '甲 乙', title: null, contact_owner: { id: '8', name: '管理人' }, modified_at: null }], moreRecords: true, nextPageToken: 'next' });
    expect(sdk.getContacts).toHaveBeenCalledWith('1', { pageToken: 'next' });
    expect(await client.getAccount('a', '1', context())).toEqual({ account_id: '1', company_name: 'ACME', account_owner: null });
  } finally { await client.close(); }
});

test('serializes account switching across callers and keeps the lock after caller abort', async () => {
  const sdk = bridge(); const client = new ZohoClient(connections, sdk);
  const events: string[] = []; let release!: () => void;
  sdk.initialize = async connection => { events.push(`init:${connection.id}`); };
  sdk.searchAccounts = async () => { events.push('start'); await new Promise<void>(resolve => { release = resolve; }); events.push('end'); return { records: [], moreRecords: false, nextPageToken: null }; };
  const abort = new AbortController();
  const first = client.searchAccountsPage('a', 'A', 1, { deadlineAt: Date.now() + 1000, signal: abort.signal });
  await vi.waitFor(() => expect(events).toEqual(['init:a', 'start']));
  abort.abort(); await expect(first).rejects.toThrow('ZOHO_DEADLINE_EXCEEDED');
  const second = client.getAccount('b', '1', context());
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(events).toEqual(['init:a', 'start']);
  release(); await second;
  expect(events).toEqual(['init:a', 'start', 'end', 'init:b']);
  await client.close();
});

test('expired queue entries skip init and failure does not poison following operations', async () => {
  const sdk = bridge(); const client = new ZohoClient(connections, sdk);
  let release!: () => void;
  sdk.searchAccounts = async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('ZOHO_PERMISSION_DENIED'); };
  const first = client.searchAccountsPage('a', 'A', 1, context());
  const caughtFirst = first.catch(error => error);
  await vi.waitFor(() => expect(sdk.initialize).toHaveBeenCalledTimes(1));
  const expired = client.getAccount('b', '1', context(10));
  await expect(expired).rejects.toThrow('ZOHO_DEADLINE_EXCEEDED');
  release(); expect((await caughtFirst).message).toBe('ZOHO_PERMISSION_DENIED');
  await client.getAccount('a', '1', context());
  expect(sdk.initialize).toHaveBeenCalledTimes(2);
  await client.close();
});

test('creates private per-connection resource directories and close waits for cleanup', async () => {
  const sdk = bridge(); const paths: string[] = [];
  sdk.initialize = async (_connection, path) => { paths.push(path); };
  const client = new ZohoClient(connections, sdk);
  await client.getAccount('a', '1', context()); await client.getAccount('b', '1', context());
  expect(paths[0]).not.toBe(paths[1]);
  for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect(await readdir(paths[0]!)).toEqual([]);
  await client.close();
  for (const path of paths) await expect(access(path)).rejects.toThrow();
  await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_UNAVAILABLE');
});

test('retries transient errors only once and never retries permission or invalid pagination', async () => {
  const sdk = bridge(); const client = new ZohoClient(connections, sdk);
  sdk.getAccount = vi.fn().mockRejectedValueOnce(new Error('ZOHO_TRANSIENT_ERROR')).mockResolvedValue({ records: [{ id: '1', Account_Name: 'A' }], moreRecords: false, nextPageToken: null });
  await client.getAccount('a', '1', context()); expect(sdk.getAccount).toHaveBeenCalledTimes(2);
  sdk.getAccount = vi.fn().mockRejectedValue(new Error('ZOHO_PERMISSION_DENIED'));
  await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_PERMISSION_DENIED'); expect(sdk.getAccount).toHaveBeenCalledTimes(1);
  await expect(client.searchAccountsPage('a', 'A', 0, context())).rejects.toThrow('ZOHO_INVALID_INPUT');
  await expect(client.getContactsPage('a', '1', { page: 1, pageToken: 'bad' } as never, context())).rejects.toThrow('ZOHO_INVALID_INPUT');
  await client.close();
});

test('memory stores keep their own tokens and implement SDK deletion/id lookups', async () => {
  const a = new MemoryZohoTokenStore(); const b = new MemoryZohoTokenStore();
  const one = { getId: () => 'one', accessToken: 'synthetic-a' }; const two = { getId: () => 'two', accessToken: 'synthetic-b' };
  await a.saveToken(one); await b.saveToken(two);
  expect(await a.findToken(two)).toBe(one); expect(await b.findToken(one)).toBe(two);
  expect(await a.findTokenById('two')).toBeNull(); expect(await a.findTokenById('one')).toBe(one);
  await a.deleteToken('two'); expect(await a.getTokens()).toEqual([one]);
  await a.deleteToken('one'); expect(await a.getTokens()).toEqual([]);
  await b.deleteTokens(); expect(await b.findToken(one)).toBeNull();
});

test('unwritable/missing temp location disables only the Zoho adapter', async () => {
  const sdk = bridge(); const client = new ZohoClient(connections, sdk);
  vi.stubEnv('TMPDIR', '/nonexistent-salestools-zoho-test-location');
  try { await expect(client.getAccount('a', '1', context())).rejects.toThrow('ZOHO_UNAVAILABLE'); expect(sdk.initialize).not.toHaveBeenCalled(); }
  finally { vi.unstubAllEnvs(); await client.close(); }
});

test('an empty contact name retains the record and nullable owner/title/time', async () => {
  const sdk = bridge(); sdk.getContacts = async () => ({ records: [{ id: '3', Full_Name: '', Title: '', Owner: null, Modified_Time: new Date('2026-10-12T00:00:00Z') }], moreRecords: false, nextPageToken: null });
  const client = new ZohoClient(connections, sdk);
  try { expect((await client.getContactsPage('a', '1', { page: 1 }, context())).contacts).toEqual([{ record_id: '3', name: '姓名未提供', title: null, contact_owner: null, modified_at: '2026-10-12T00:00:00.000Z' }]); }
  finally { await client.close(); }
});
