import type { ZohoAccountCandidate, ZohoCompany, ZohoConnection, ZohoConnectionStatus, ZohoContactsOutput, ZohoQuery } from '../contracts/zoho-contact.js';
import type { ZohoCallContext, ZohoClient, ZohoCursor } from '../upstream/zoho/client.js';

type Client = Pick<ZohoClient, 'searchAccountsPage' | 'getAccount' | 'getContactsPage'>;
type Event = { connection_id: string; phase: string; pages: number; count: number; duration_ms: number; error_code: string | null };
const fail = (code: string): never => { throw new Error(code); };
const normalize = (name: string) => name.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const code = (error: unknown) => error instanceof Error && /^ZOHO_[A-Z0-9_]+$/u.test(error.message) ? error.message : 'ZOHO_UPSTREAM_ERROR';
const candidate = (item: ZohoAccountCandidate): ZohoAccountCandidate => ({
  account_id: item.account_id, company_name: item.company_name,
  account_owner: item.account_owner ? { id: item.account_owner.id, name: item.account_owner.name ?? '未提供' } : { id: null, name: '未提供' },
});

export class ZohoContactService {
  constructor(
    private readonly client: Client,
    private readonly connections: readonly Pick<ZohoConnection, 'id' | 'name'>[],
    private readonly options: { now?: () => number; logger?: (event: Event) => void } = {},
  ) {}

  async get(input: ZohoQuery): Promise<ZohoContactsOutput> {
    if (!input || typeof input.query !== 'string' || !input.query.trim()) fail('ZOHO_INVALID_INPUT');
    if (input.connectionIds !== undefined && (!Array.isArray(input.connectionIds) || input.connectionIds.some(id => typeof id !== 'string'))) fail('ZOHO_INVALID_INPUT');
    if (input.accountRecords !== undefined && (!Array.isArray(input.accountRecords) || input.accountRecords.some(record => !record || typeof record.connectionId !== 'string' || !/^\d+$/u.test(record.accountId)))) fail('ZOHO_INVALID_INPUT');
    const known = new Map(this.connections.map(connection => [connection.id, connection]));
    const ids = input.connectionIds ?? this.connections.map(connection => connection.id);
    if (ids.some(id => !known.has(id))) fail('ZOHO_UNKNOWN_CONNECTION');
    if (new Set(ids).size !== ids.length) fail('ZOHO_INVALID_INPUT');
    const selections = input.accountRecords ?? [];
    if (selections.some(record => !ids.includes(record.connectionId))) fail('ZOHO_INVALID_SELECTION');
    if (new Set(selections.map(record => `${record.connectionId}:${record.accountId}`)).size !== selections.length) fail('ZOHO_INVALID_INPUT');
    const now = this.options.now ?? Date.now;
    const deadlineAt = now() + 120000;
    const controller = new AbortController();
    const context: ZohoCallContext = { deadlineAt, signal: controller.signal };
    const scopedIds = input.accountRecords ? ids.filter(id => selections.some(record => record.connectionId === id)) : ids;
    const states: ZohoConnectionStatus[] = scopedIds.map(id => ({ connection_id: id, name: known.get(id)!.name, status: 'completed', search_complete: Boolean(input.accountRecords), candidates: [], error_code: null }));
    const companies: ZohoCompany[] = [];
    const warnings: string[] = [];
    const selected = new Map<string, ZohoAccountCandidate[]>();
    const finished = new Set<string>();
    let timedOut = false;
    const active = () => !controller.signal.aborted && now() < deadlineAt;
    const deadlineError = new Error('ZOHO_DEADLINE_EXCEEDED');
    const assertActive = () => { if (!active()) throw deadlineError; };
    const log = (id: string, phase: string, pages: number, count: number, start: number, errorCode: string | null) => {
      this.options.logger?.({ connection_id: id, phase, pages, count, duration_ms: Math.max(0, now() - start), error_code: errorCode });
    };
    const snapshot = (): ZohoContactsOutput => {
      const needs = states.some(state => state.status === 'needs_confirmation');
      const bad = states.some(state => state.status === 'partial' || state.status === 'failed');
      const complete = !needs && !bad && states.every(state => state.search_complete);
      const hasResult = companies.length > 0 || states.some(state => state.candidates.length > 0 || (!input.accountRecords && state.search_complete));
      const status = timedOut ? (hasResult ? 'partial' : 'failed') : needs ? 'needs_confirmation' : complete ? 'completed' : states.every(state => state.status === 'failed') ? 'failed' : 'partial';
      return structuredClone({ status, complete: timedOut ? false : complete, connections: states, companies, warnings, collected_at: new Date(now()).toISOString() });
    };
    let deadlineResult: ZohoContactsOutput | undefined;
    const finishDeadline = (): ZohoContactsOutput => {
      if (!deadlineResult) {
        timedOut = true;
        controller.abort();
        for (const state of states) if (state.status === 'completed' && !finished.has(state.connection_id)) {
          state.status = companies.some(company => company.connection_id === state.connection_id) ? 'partial' : 'failed';
          state.error_code = 'ZOHO_DEADLINE_EXCEEDED';
        }
        warnings.push('ZOHO_DEADLINE_EXCEEDED');
        deadlineResult = snapshot();
      }
      return deadlineResult;
    };
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<ZohoContactsOutput>(resolve => {
      timer = setTimeout(() => resolve(finishDeadline()), Math.max(0, deadlineAt - now()));
    });
    const work = (async () => {
      const query = normalize(input.query);
      if (input.accountRecords) {
        // Explicit selection defines the scope. Validate every record before reading contacts.
        for (const state of states) {
          const start = now(); let count = 0;
          for (const record of selections.filter(record => record.connectionId === state.connection_id)) {
            assertActive();
            let item: ZohoAccountCandidate;
            try { item = await this.client.getAccount(state.connection_id, record.accountId, context); }
            catch (error) { assertActive(); state.status = 'failed'; state.error_code = code(error); warnings.push(state.error_code); break; }
            assertActive();
            if (item.account_id !== record.accountId || !normalize(item.company_name).includes(query)) fail('ZOHO_INVALID_SELECTION');
            const list = selected.get(state.connection_id) ?? [];
            list.push(candidate(item)); selected.set(state.connection_id, list); count++;
          }
          log(state.connection_id, 'selection', count, count, start, state.error_code);
        }
      } else {
        for (const state of states) {
          assertActive();
          const start = now(); let pages = 0; let more = true; let errorCode: string | null = null;
          while (more && pages < 10 && state.candidates.length < 2000) {
            assertActive();
            try {
              const page = await this.client.searchAccountsPage(state.connection_id, input.query.trim(), pages + 1, context);
              assertActive();
              pages++;
              for (const item of page.accounts) {
                if (state.candidates.length >= 2000) break;
                if (!state.candidates.some(existing => existing.account_id === item.account_id)) state.candidates.push(candidate(item));
              }
              more = page.moreRecords;
            } catch (error) { assertActive(); errorCode = code(error); break; }
          }
          state.search_complete = !more && !errorCode;
          if (!state.search_complete) {
            state.error_code = errorCode ?? 'ZOHO_SEARCH_LIMIT';
            warnings.push(state.error_code);
            state.status = state.candidates.length ? 'needs_confirmation' : 'failed';
          } else if (state.candidates.length) {
            const exact = state.candidates.filter(item => normalize(item.company_name) === query);
            if (exact.length === 1) selected.set(state.connection_id, exact);
            else state.status = 'needs_confirmation';
          } else selected.set(state.connection_id, []);
          log(state.connection_id, 'search', pages, state.candidates.length, start, state.error_code);
        }
      }
      assertActive();
      if (states.some(state => state.status === 'needs_confirmation')) return snapshot();
      for (const state of states) {
        if (state.status === 'failed') continue;
        for (const item of selected.get(state.connection_id) ?? []) {
          assertActive();
          const start = now(); let pages = 0; let cursor: ZohoCursor = { page: 1 };
          const seenCursors = new Set<string>();
          const seenContacts = new Set<string>();
          const company: ZohoCompany = { ...item, connection_id: state.connection_id, contacts: [] };
          companies.push(company);
          for (;;) {
            assertActive();
            const key = JSON.stringify(cursor);
            if (seenCursors.has(key)) { state.status = 'partial'; state.error_code = 'ZOHO_PAGINATION_STALLED'; break; }
            seenCursors.add(key);
            try {
              const page = await this.client.getContactsPage(state.connection_id, item.account_id, cursor, context);
              assertActive();
              pages++;
              const before = company.contacts.length;
              for (const raw of page.contacts) {
                const id = `${state.connection_id}:${raw.record_id}`;
                if (seenContacts.has(id)) continue;
                seenContacts.add(id);
                company.contacts.push({
                  record_id: raw.record_id, name: raw.name?.trim() || '姓名未提供', title: raw.title,
                  contact_owner: raw.contact_owner ? { id: raw.contact_owner.id, name: raw.contact_owner.name ?? '未提供' } : { id: null, name: '未提供' },
                  modified_at: raw.modified_at,
                });
              }
              if (!page.moreRecords) break;
              if (company.contacts.length === before) { state.status = 'partial'; state.error_code = 'ZOHO_PAGINATION_STALLED'; break; }
              if (pages >= 10) {
                if (!page.nextPageToken) { state.status = 'partial'; state.error_code = 'ZOHO_PAGINATION_STALLED'; break; }
                cursor = { pageToken: page.nextPageToken };
              } else cursor = { page: pages + 1 };
            } catch (error) { assertActive(); state.status = 'partial'; state.error_code = code(error); break; }
          }
          if (state.error_code) warnings.push(state.error_code);
          log(state.connection_id, 'contacts', pages, company.contacts.length, start, state.error_code);
        }
        finished.add(state.connection_id);
      }
      return snapshot();
    })().catch((error: unknown) => {
      if (error === deadlineError) return finishDeadline();
      throw error;
    });
    try { return await Promise.race([work, timeout]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
