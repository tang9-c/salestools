import type { DatabaseSync } from 'node:sqlite';
import {
  BasicProfileSchema,
  IdentityProfileSchema,
  UtcTimestampSchema,
  type BasicProfile,
  type IdentityProfile,
} from '../contracts/index.js';

export interface CompanyProfileInput {
  identity: IdentityProfile;
  normalizedLegalName: string;
  basicProfile: BasicProfile;
  collectedAt: string;
}

export interface StoredCompanyProfile extends CompanyProfileInput {}

interface ProfileRow {
  normalized_legal_name: string;
  identity_json: string;
  basic_profile_json: string;
  collected_at: string;
}

function ttlCutoff(now: Date, ttlDays: number): string {
  return new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
}

function toStoredProfile(row: ProfileRow): StoredCompanyProfile {
  return {
    identity: IdentityProfileSchema.parse(JSON.parse(row.identity_json)),
    normalizedLegalName: row.normalized_legal_name,
    basicProfile: BasicProfileSchema.parse(JSON.parse(row.basic_profile_json)),
    collectedAt: UtcTimestampSchema.parse(row.collected_at),
  };
}

export class ProfileRepository {
  constructor(private readonly database: DatabaseSync) {}

  findByCreditCodes(codes: string[]): StoredCompanyProfile[] {
    if (codes.length === 0) return [];
    const rows = this.database.prepare(`
      SELECT normalized_legal_name, identity_json, basic_profile_json, collected_at
      FROM company_profiles WHERE credit_code IN (SELECT value FROM json_each(?))
      ORDER BY credit_code
    `).all(JSON.stringify(codes)) as unknown as ProfileRow[];
    return rows.map(toStoredProfile);
  }

  findByNormalizedNames(names: string[]): StoredCompanyProfile[] {
    if (names.length === 0) return [];
    const rows = this.database.prepare(`
      SELECT normalized_legal_name, identity_json, basic_profile_json, collected_at
      FROM company_profiles WHERE normalized_legal_name IN (SELECT value FROM json_each(?))
      ORDER BY credit_code
    `).all(JSON.stringify(names)) as unknown as ProfileRow[];
    return rows.map(toStoredProfile);
  }

  upsert(input: CompanyProfileInput): void {
    const identity = IdentityProfileSchema.parse(input.identity);
    const basicProfile = BasicProfileSchema.parse(input.basicProfile);
    const collectedAt = UtcTimestampSchema.parse(input.collectedAt);
    this.database.prepare(`
      INSERT INTO company_profiles (
        credit_code, normalized_legal_name, identity_json, basic_profile_json, collected_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(credit_code) DO UPDATE SET
        normalized_legal_name = excluded.normalized_legal_name,
        identity_json = excluded.identity_json,
        basic_profile_json = excluded.basic_profile_json,
        collected_at = excluded.collected_at
    `).run(
      identity.creditCode,
      input.normalizedLegalName,
      JSON.stringify(identity),
      JSON.stringify(basicProfile),
      collectedAt,
    );
  }

  findFreshByCreditCode(creditCode: string, now: Date, ttlDays: number): StoredCompanyProfile | null {
    const row = this.database.prepare(`
      SELECT normalized_legal_name, identity_json, basic_profile_json, collected_at
      FROM company_profiles
      WHERE credit_code = ? AND collected_at >= ?
    `).get(creditCode, ttlCutoff(now, ttlDays)) as unknown as ProfileRow | undefined;
    return row === undefined ? null : toStoredProfile(row);
  }

  findFreshByNormalizedName(normalizedLegalName: string, now: Date, ttlDays: number): StoredCompanyProfile[] {
    const rows = this.database.prepare(`
      SELECT normalized_legal_name, identity_json, basic_profile_json, collected_at
      FROM company_profiles
      WHERE normalized_legal_name = ? AND collected_at >= ?
      ORDER BY credit_code
    `).all(normalizedLegalName, ttlCutoff(now, ttlDays)) as unknown as ProfileRow[];
    return rows.map(toStoredProfile);
  }
}
