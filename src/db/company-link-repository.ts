import type { DatabaseSync } from 'node:sqlite';
import type { CompanyLink, LinkWrite } from '../companies/company-context-types.js';

interface OperationRow { request_json: string; result_json: string }

function requestJson(input: LinkWrite): string {
  return JSON.stringify({
    action: input.action,
    organization_id: input.organization_id,
    credit_code: input.credit_code ?? null,
    operation_id: input.operation_id,
    expected_link_version: input.expected_link_version,
    expected_organization_version: input.expected_organization_version,
    note: input.note,
  });
}

export class CompanyLinkRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(id: string): CompanyLink | null {
    return (this.database.prepare('SELECT * FROM company_links WHERE organization_id = ?')
      .get(id) as unknown as CompanyLink | undefined) ?? null;
  }

  getMany(ids: string[]): Map<string, CompanyLink> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database.prepare(`SELECT * FROM company_links WHERE organization_id IN (${placeholders})`)
      .all(...ids) as unknown as CompanyLink[];
    return new Map(rows.map(row => [row.organization_id, row]));
  }

  byCreditCode(code: string): CompanyLink[] {
    return this.database.prepare('SELECT * FROM company_links WHERE credit_code = ? ORDER BY organization_id')
      .all(code) as unknown as CompanyLink[];
  }

  replay(input: LinkWrite, actor: string): CompanyLink | null {
    this.requireActor(actor);
    const operation = this.database.prepare(`
      SELECT request_json, result_json FROM company_link_operations
      WHERE actor = ? AND operation_id = ?
    `).get(actor, input.operation_id) as unknown as OperationRow | undefined;
    if (operation === undefined) return null;
    if (operation.request_json !== requestJson(input)) throw new Error('OPERATION_CONFLICT');
    return JSON.parse(operation.result_json) as CompanyLink;
  }

  write(input: LinkWrite, actor: string, identityHash: string, now: string): CompanyLink {
    this.requireActor(actor);
    const existingReceipt = this.replay(input, actor);
    if (existingReceipt !== null) return existingReceipt;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.replay(input, actor);
      if (receipt !== null) {
        this.database.exec('COMMIT');
        return receipt;
      }

      const before = this.get(input.organization_id);
      if ((before?.version ?? 0) !== input.expected_link_version) {
        throw new Error('LINK_VERSION_CONFLICT');
      }
      if (input.action === 'confirm' && !input.credit_code) {
        throw new Error('CREDIT_CODE_REQUIRED');
      }

      const result: CompanyLink = {
        organization_id: input.organization_id,
        credit_code: input.action === 'confirm' ? input.credit_code! : null,
        state: input.action === 'confirm' ? 'confirmed' : 'revoked',
        version: (before?.version ?? 0) + 1,
        identity_hash: identityHash,
        organization_version: input.expected_organization_version,
        note: input.note,
        actor,
        updated_at: now,
      };

      this.database.prepare(`
        INSERT INTO company_links (
          organization_id, credit_code, state, version, identity_hash,
          organization_version, note, actor, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organization_id) DO UPDATE SET
          credit_code = excluded.credit_code,
          state = excluded.state,
          version = excluded.version,
          identity_hash = excluded.identity_hash,
          organization_version = excluded.organization_version,
          note = excluded.note,
          actor = excluded.actor,
          updated_at = excluded.updated_at
      `).run(result.organization_id, result.credit_code, result.state, result.version,
        result.identity_hash, result.organization_version, result.note, result.actor, result.updated_at);
      this.database.prepare(`
        INSERT INTO company_link_operations (
          actor, operation_id, request_json, before_json, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(actor, input.operation_id, requestJson(input), before === null ? null : JSON.stringify(before),
        JSON.stringify(result), now);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireActor(actor: string): void {
    if (actor.trim() === '') throw new Error('ACTOR_REQUIRED');
  }
}
