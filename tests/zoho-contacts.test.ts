import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZohoContactService } from '../src/contacts/zoho-contact-service.js';
import type { ZohoClient, ZohoCursor } from '../src/upstream/zoho/client.js';

const account = (id: string, name = 'Acme Inc') => ({ account_id: id, company_name: name, account_owner: null });
const contact = (id: string, name = `Person ${id}`) => ({ record_id: id, name, title: null, contact_owner: null, modified_at: null });
const connections = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const fake = () => ({
  searchAccountsPage: vi.fn(async (_id: string, _query: string, _page: number) => ({ accounts: [account('1')], moreRecords: false })),
  getAccount: vi.fn(async (_id: string, id: string) => account(id)),
  getContactsPage: vi.fn(async (_id: string, _account: string, _cursor: ZohoCursor) => ({ contacts: [contact('1')], moreRecords: false, nextPageToken: null as string | null })),
});
const service = (client: ReturnType<typeof fake>, selected = connections) => new ZohoContactService(client as unknown as Pick<ZohoClient, 'searchAccountsPage' | 'getAccount' | 'getContactsPage'>, selected);
afterEach(() => vi.useRealTimers());

describe('ZohoContactService', () => {
  it('confirms one normalized full name and preserves same named people from distinct connections', async () => {
    const client = fake();
    const result = await service(client).get({ query: '  ACME  INC ' });
    expect(result.status).toBe('completed');
    expect(result.complete).toBe(true);
    expect(result.companies).toHaveLength(2);
    expect(result.companies.map(company => company.contacts[0].record_id)).toEqual(['1', '1']);
    expect(result.companies[0].contacts[0].contact_owner).toEqual({ id: null, name: '未提供' });
  });

  it('requires confirmation of short names before any contact read', async () => {
    const client = fake();
    const result = await service(client).get({ query: 'Acme' });
    expect(result.status).toBe('needs_confirmation');
    expect(result.connections.map(c => c.candidates[0].company_name)).toEqual(['Acme Inc', 'Acme Inc']);
    expect(client.getContactsPage).not.toHaveBeenCalled();
  });

  it('never assumes a match is unique until all search pages finish', async () => {
    const client = fake();
    client.searchAccountsPage.mockImplementation(async (_id, _query, page) => ({ accounts: [account(String(page))], moreRecords: page === 1 }));
    const result = await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    expect(result.status).toBe('needs_confirmation');
    expect(result.connections[0].candidates).toHaveLength(2);
    expect(client.getContactsPage).not.toHaveBeenCalled();
  });

  it('does not auto-confirm an incomplete 2000-record search', async () => {
    const client = fake();
    client.searchAccountsPage.mockImplementation(async (_id, _query, page) => ({ accounts: Array.from({ length: 200 }, (_, i) => account(String((page - 1) * 200 + i + 1), page === 1 && i === 0 ? 'Acme Inc' : `Other ${page}-${i}`)), moreRecords: true }));
    const result = await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    expect(result.status).toBe('needs_confirmation');
    expect(result.connections[0].search_complete).toBe(false);
    expect(client.searchAccountsPage).toHaveBeenCalledTimes(10);
    expect(client.getContactsPage).not.toHaveBeenCalled();
  });

  it('keeps candidates after a later search failure but fails when no candidate was seen', async () => {
    const client = fake();
    client.searchAccountsPage.mockImplementation(async (_id, _query, page) => { if (page === 2) throw new Error('ZOHO_UPSTREAM_ERROR'); return { accounts: [account('1')], moreRecords: true }; });
    expect((await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' })).status).toBe('needs_confirmation');
    client.searchAccountsPage.mockRejectedValue(new Error('ZOHO_UPSTREAM_ERROR'));
    expect((await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' })).status).toBe('failed');
  });

  it('accepts an explicitly selected substring match and reads only that record', async () => {
    const client = fake();
    client.getAccount.mockResolvedValue(account('9', 'Acme Holdings Inc'));
    const result = await service(client).get({ query: 'Acme', connectionIds: ['a'], accountRecords: [{ connectionId: 'a', accountId: '9' }] });
    expect(result.complete).toBe(true);
    expect(result.companies.map(c => c.account_id)).toEqual(['9']);
    expect(client.searchAccountsPage).not.toHaveBeenCalled();
    expect(client.getContactsPage).toHaveBeenCalledWith('a', '9', { page: 1 }, expect.any(Object));
  });

  it('rejects an unrelated selected record and unknown input safely', async () => {
    const client = fake();
    await expect(service(client).get({ query: 'Acme', connectionIds: ['a'], accountRecords: [{ connectionId: 'a', accountId: '1' }] })).resolves.toMatchObject({ status: 'completed' });
    client.getAccount.mockResolvedValue(account('1', 'Other Co'));
    await expect(service(client).get({ query: 'Acme', connectionIds: ['a'], accountRecords: [{ connectionId: 'a', accountId: '1' }] })).rejects.toThrow('ZOHO_INVALID_SELECTION');
    await expect(service(client).get({ query: 'Acme', connectionIds: ['missing'] })).rejects.toThrow('ZOHO_UNKNOWN_CONNECTION');
    await expect(service(client).get({ query: ' ' })).rejects.toThrow('ZOHO_INVALID_INPUT');
  });

  it('returns completed empty results for no company or no contacts', async () => {
    const client = fake();
    client.searchAccountsPage.mockResolvedValue({ accounts: [], moreRecords: false });
    expect(await service(client, connections.slice(0, 1)).get({ query: 'Nobody' })).toMatchObject({ status: 'completed', complete: true, companies: [] });
    client.searchAccountsPage.mockResolvedValue({ accounts: [account('1')], moreRecords: false });
    client.getContactsPage.mockResolvedValue({ contacts: [], moreRecords: false, nextPageToken: null });
    expect((await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' })).companies[0].contacts).toEqual([]);
  });

  it('reads beyond 200 and 2000 with a page token and deduplicates record IDs', async () => {
    const client = fake();
    client.getContactsPage.mockImplementation(async (_id, _account, cursor) => {
      const page = 'page' in cursor ? cursor.page : 11;
      return { contacts: page === 11 ? [contact('2000'), contact('2001')] : Array.from({ length: 200 }, (_, i) => contact(String((page - 1) * 200 + i + 1))), moreRecords: page < 11, nextPageToken: page === 10 ? 'next-11' : null };
    });
    const result = await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    expect(result.status).toBe('completed');
    expect(result.companies[0].contacts).toHaveLength(2001);
    expect(client.getContactsPage).toHaveBeenCalledWith('a', '1', { pageToken: 'next-11' }, expect.any(Object));
  });

  it('preserves collected contacts when a later page or connection fails', async () => {
    const client = fake();
    client.getContactsPage.mockImplementation(async (id, _account, cursor) => { if (id === 'b' || 'page' in cursor && cursor.page === 2) throw new Error('ZOHO_PERMISSION_DENIED'); return { contacts: [contact('1')], moreRecords: true, nextPageToken: null }; });
    const result = await service(client).get({ query: 'Acme Inc' });
    expect(result).toMatchObject({ status: 'partial', complete: false });
    expect(result.companies[0].contacts).toHaveLength(1);
    expect(result.connections.map(c => c.error_code)).toEqual(['ZOHO_PERMISSION_DENIED', 'ZOHO_PERMISSION_DENIED']);
  });

  it('keeps the first connection when searching the second connection fails', async () => {
    const client = fake();
    client.searchAccountsPage.mockImplementation(async (id) => { if (id === 'b') throw new Error('ZOHO_AUTH_FAILED'); return { accounts: [account('1')], moreRecords: false }; });
    const result = await service(client).get({ query: 'Acme Inc' });
    expect(result).toMatchObject({ status: 'partial', complete: false });
    expect(result.companies.map(company => company.connection_id)).toEqual(['a']);
    expect(result.connections[1].error_code).toBe('ZOHO_AUTH_FAILED');
  });

  it('deduplicates by connection and record ID across selected companies without passing extra fields', async () => {
    const client = fake();
    client.getAccount.mockImplementation(async (_id, id) => account(id));
    client.getContactsPage.mockResolvedValue({ contacts: [{ ...contact('1'), Email: 'secret@example.com' } as ReturnType<typeof contact>], moreRecords: false, nextPageToken: null });
    const result = await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc', accountRecords: [{ connectionId: 'a', accountId: '1' }, { connectionId: 'a', accountId: '2' }] });
    expect(result.companies.map(company => company.contacts.length)).toEqual([1, 0]);
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
  });

  it('returns partial for a repeated cursor without looping', async () => {
    const client = fake();
    client.getContactsPage.mockResolvedValue({ contacts: [contact('1')], moreRecords: true, nextPageToken: 'stuck' });
    const result = await service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    expect(result.status).toBe('partial');
    expect(client.getContactsPage).toHaveBeenCalledTimes(11);
  });

  it('returns at 120 seconds even if an SDK promise remains unsettled, then freezes results', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const client = fake();
    let resolve!: (value: { accounts: ReturnType<typeof account>[]; moreRecords: boolean }) => void;
    client.searchAccountsPage.mockImplementation(() => new Promise(r => { resolve = r; }));
    const resultPromise = service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    await vi.advanceTimersByTimeAsync(120000);
    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'failed', complete: false });
    resolve({ accounts: [account('1')], moreRecords: false });
    await Promise.resolve();
    expect(result.companies).toEqual([]);
    expect(client.getContactsPage).not.toHaveBeenCalled();
  });

  it('marks an unfinished contact page partial at the deadline and never starts another page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const client = fake();
    let resolve!: (value: { contacts: ReturnType<typeof contact>[]; moreRecords: boolean; nextPageToken: null }) => void;
    client.getContactsPage.mockImplementation(async (_id, _account, cursor) => {
      if ('page' in cursor && cursor.page === 1) return { contacts: [contact('1')], moreRecords: true, nextPageToken: null };
      return new Promise(r => { resolve = r; });
    });
    const resultPromise = service(client, connections.slice(0, 1)).get({ query: 'Acme Inc' });
    await vi.advanceTimersByTimeAsync(120000);
    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'partial', complete: false });
    expect(result.companies[0].contacts).toHaveLength(1);
    resolve({ contacts: [contact('2')], moreRecords: false, nextPageToken: null });
    await Promise.resolve();
    expect(result.companies[0].contacts).toHaveLength(1);
    expect(client.getContactsPage).toHaveBeenCalledTimes(2);
  });
});
