import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
import type { LinkWrite } from '../src/companies/company-context-types.js';

const at = '2026-10-12T00:00:00Z';
const confirm: LinkWrite = {
  action: 'confirm', organization_id: 'o1', credit_code: '91310000123456789X',
  operation_id: 'confirm-1', expected_link_version: 0,
  expected_organization_version: 1, note: '核对营业执照',
};

function memory(): { db: DatabaseSync; repo: CompanyLinkRepository } {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  return { db, repo: new CompanyLinkRepository(db) };
}

it('replays unlink before checking the now-stale expected version', () => {
  const { db, repo } = memory();
  try {
    const input: LinkWrite = { action: 'unlink', organization_id: 'o1', operation_id: 'unlink-1',
      expected_link_version: 0, expected_organization_version: 1, note: '解除自动匹配' };
    const first = repo.write(input, 'sales-a', 'hash1', at);
    expect(first).toMatchObject({ state: 'revoked', version: 1, credit_code: null });
    expect(repo.write(input, 'sales-a', 'hash1', '2026-10-12T00:01:00Z')).toEqual(first);
    expect(() => repo.write({ ...input, operation_id: 'unlink-2' }, 'sales-a', 'hash1',
      '2026-10-12T00:02:00Z')).toThrow('LINK_VERSION_CONFLICT');
  } finally { db.close(); }
});

it('rejects a changed request for the same actor and operation ID', () => {
  const { db, repo } = memory();
  try {
    repo.write(confirm, 'sales-a', 'hash1', at);
    expect(() => repo.replay({ ...confirm, note: '另一理由' }, 'sales-a')).toThrow('OPERATION_CONFLICT');
    expect(() => repo.write({ ...confirm, credit_code: 'OTHER' }, 'sales-a', 'hash2', at))
      .toThrow('OPERATION_CONFLICT');
    expect(repo.get('o1')?.credit_code).toBe(confirm.credit_code);
  } finally { db.close(); }
});

it('isolates operation IDs by actor and rejects an empty actor', () => {
  const { db, repo } = memory();
  try {
    const first = repo.write(confirm, 'sales-a', 'hash1', at);
    expect(repo.replay(confirm, 'sales-b')).toBeNull();
    const second = repo.write({ ...confirm, organization_id: 'o2' }, 'sales-b', 'hash2', at);
    expect(second).toMatchObject({ organization_id: 'o2', version: 1 });
    expect(repo.replay(confirm, 'sales-a')).toEqual(first);
    expect(repo.byCreditCode(confirm.credit_code!)).toHaveLength(2);
    expect(() => repo.write(confirm, '', 'hash1', at)).toThrow();
  } finally { db.close(); }
});

it('replaces one organization target only with the current link version', () => {
  const { db, repo } = memory();
  try {
    repo.write(confirm, 'sales-a', 'hash1', at);
    const replacement = repo.write({ ...confirm, credit_code: 'NEW', operation_id: 'replace-1',
      expected_link_version: 1, expected_organization_version: 2 }, 'sales-a', 'hash2', at);
    expect(replacement).toMatchObject({ state: 'confirmed', version: 2, credit_code: 'NEW',
      organization_version: 2, identity_hash: 'hash2' });
    expect(repo.byCreditCode(confirm.credit_code!)).toEqual([]);
    expect(repo.byCreditCode('NEW')).toEqual([replacement]);
    expect(repo.getMany(['o1', 'missing']).get('o1')).toEqual(replacement);
    expect(repo.getMany(['o1', 'missing']).has('missing')).toBe(false);
    expect(() => repo.write({ ...confirm, operation_id: 'stale-1' }, 'sales-a', 'hash1', at))
      .toThrow('LINK_VERSION_CONFLICT');
  } finally { db.close(); }
});

it('revokes a confirmed link and records its previous value for audit', () => {
  const { db, repo } = memory();
  try {
    const first = repo.write(confirm, 'sales-a', 'hash1', at);
    const unlink: LinkWrite = { action: 'unlink', organization_id: 'o1', operation_id: 'unlink-2',
      expected_link_version: 1, expected_organization_version: 2, note: '人工撤销' };
    const revoked = repo.write(unlink, 'sales-a', 'hash2', '2026-10-12T00:01:00Z');
    expect(revoked).toMatchObject({ state: 'revoked', credit_code: null, version: 2 });
    expect(repo.byCreditCode(confirm.credit_code!)).toEqual([]);
    const audit = db.prepare(`SELECT before_json, result_json FROM company_link_operations
      WHERE actor = ? AND operation_id = ?`).get('sales-a', 'unlink-2') as {
      before_json: string; result_json: string;
    };
    expect(JSON.parse(audit.before_json)).toEqual(first);
    expect(JSON.parse(audit.result_json)).toEqual(revoked);
    expect(repo.replay(unlink, 'sales-a')).toEqual(revoked);
  } finally { db.close(); }
});

it('rolls back a link change when the operation receipt cannot be inserted', () => {
  const { db, repo } = memory();
  try {
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON company_link_operations
      WHEN NEW.operation_id = 'blocked' BEGIN SELECT RAISE(ABORT, 'blocked receipt'); END`);
    expect(() => repo.write({ ...confirm, operation_id: 'blocked' }, 'sales-a', 'hash1', at))
      .toThrow('blocked receipt');
    expect(repo.get('o1')).toBeNull();
    expect(repo.replay({ ...confirm, operation_id: 'blocked' }, 'sales-a')).toBeNull();
    expect(repo.write(confirm, 'sales-a', 'hash1', at).version).toBe(1);
  } finally { db.close(); }
});

it('preserves links and receipts across repeated database initialization', () => {
  const { db, repo } = memory();
  try {
    const first = repo.write(confirm, 'sales-a', 'hash1', at);
    initializeDatabase(db);
    const reopened = new CompanyLinkRepository(db);
    expect(reopened.get('o1')).toEqual(first);
    expect(reopened.replay(confirm, 'sales-a')).toEqual(first);
    expect(reopened.write(confirm, 'sales-a', 'changed hash', '2026-10-13T00:00:00Z')).toEqual(first);
  } finally { db.close(); }
});
