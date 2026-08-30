import type { ProfileRepository } from '../../db/profile-repository.js';
import { CallBudget } from '../../orchestration/call-budget.js';
import { retryOnce } from '../../orchestration/retry.js';
import {
  mapCompanyCandidates,
  mapCompanyDetails,
  validateQccPayload,
  type MappedCandidate,
  type MappedCompanyDetails,
} from './mapper.js';
import type { QccServer } from './tool-allowlist.js';

export interface CompanyProfileGateway {
  call(server: QccServer, tool: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface CompanyProfileServiceOptions {
  profileCacheTtlDays: number;
  maxQccCalls: number;
  maxTotalCalls: number;
  now?: () => Date;
}

export interface CompanyProfileCandidate {
  legalName: string;
  creditCode: string;
  status: string | null;
  registeredAddress: string | null;
  matchReason: string;
}

export interface CompanyProfileBasicProfile {
  industry: string | null;
  region: string | null;
  companyType: string | null;
  foundedYear: number | null;
  registeredCapital: string | null;
  legalRepresentative: string | null;
  website: string | null;
  employeeRange: string | null;
  riskSummary: string | null;
  collectedAt: string;
}

export type CompanyProfileResult = {
  sourceStatus: 'completed';
  candidates: CompanyProfileCandidate[];
  basicProfile: CompanyProfileBasicProfile | null;
  cacheHit: boolean;
} | {
  sourceStatus: 'failed';
  candidates: [];
  basicProfile: null;
  cacheHit: false;
  message: string;
};

export function normalizeLegalName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[A-Z]/g, character => character.toLowerCase());
}

function candidateFromIdentity(identity: {
  legalName: string;
  creditCode: string;
  registeredAddress: string | null;
}, matchReason: string): CompanyProfileCandidate {
  return {
    legalName: identity.legalName,
    creditCode: identity.creditCode,
    status: null,
    registeredAddress: identity.registeredAddress,
    matchReason,
  };
}

function basicProfileToService(profile: {
  industry: string | null;
  region: string | null;
  company_type: string | null;
  founded_year: number | null;
  registered_capital: string | null;
  legal_representative: string | null;
  website: string | null;
  employee_range: string | null;
  risk_summary: string | null;
  collected_at: string;
}): CompanyProfileBasicProfile {
  return {
    industry: profile.industry,
    region: profile.region,
    companyType: profile.company_type,
    foundedYear: profile.founded_year,
    registeredCapital: profile.registered_capital,
    legalRepresentative: profile.legal_representative,
    website: profile.website,
    employeeRange: profile.employee_range,
    riskSummary: profile.risk_summary,
    collectedAt: profile.collected_at,
  };
}

function candidateToService(candidate: MappedCandidate): CompanyProfileCandidate {
  return { ...candidate };
}

export class CompanyProfileService {
  private readonly now: () => Date;

  constructor(
    private readonly gateway: CompanyProfileGateway,
    private readonly profiles: ProfileRepository,
    private readonly options: CompanyProfileServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(query: string, regionHint?: string): Promise<CompanyProfileResult> {
    const requestedAt = this.now();
    const normalizedQuery = normalizeLegalName(query);
    const cached = this.profiles.findFreshByNormalizedName(
      normalizedQuery,
      requestedAt,
      this.options.profileCacheTtlDays,
    );
    const normalizedRegionHint = regionHint === undefined ? null : normalizeLegalName(regionHint);
    const regionalCacheMatches = normalizedRegionHint === null ? [] : cached.filter(entry => [
      entry.basicProfile.region,
      entry.identity.registeredAddress,
    ].some(value => value !== null && normalizeLegalName(value).includes(normalizedRegionHint)));
    const cachedMatch = cached.length === 1
      ? cached[0]
      : regionalCacheMatches.length === 1 ? regionalCacheMatches[0] : null;
    if (cachedMatch !== null) {
      return {
        sourceStatus: 'completed',
        candidates: [candidateFromIdentity(
          cachedMatch.identity,
          cached.length === 1 ? '缓存的法定名称完全匹配' : '缓存的法定名称与地域匹配',
        )],
        basicProfile: basicProfileToService(cachedMatch.basicProfile),
        cacheHit: true,
      };
    }

    const budget = new CallBudget({
      qcc: this.options.maxQccCalls,
      doubaoSearch: 1,
      ark: 1,
      total: this.options.maxTotalCalls,
    });
    const lookup = await retryOnce('qcc', budget, async () => mapCompanyCandidates(
      await this.gateway.call('company', 'get_company_by_query', {
        query,
        ...(regionHint === undefined ? {} : { region_hint: regionHint }),
      }),
    ));
    if (lookup.status === 'failed') {
      return {
        sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
        message: '企查查暂不可用，请稍后重试',
      };
    }

    const candidates = lookup.value;
    if (candidates.length !== 1 || normalizeLegalName(candidates[0].legalName) !== normalizedQuery) {
      return {
        sourceStatus: 'completed', candidates: candidates.map(candidateToService), basicProfile: null, cacheHit: false,
      };
    }

    const selected = candidates[0];
    const input = { credit_code: selected.creditCode, company_name: selected.legalName };
    const detailRequests = [
      ['company', 'get_company_registration_info'],
      ['company', 'get_company_profile'],
      ['company', 'get_contact_info'],
      ['risk', 'get_company_risk_scan'],
    ] as const;
    const detailPayloads: Array<unknown | null> = [];
    for (const [server, tool] of detailRequests) {
      if (!budget.canConsume('qcc')) {
        detailPayloads.push(null);
        continue;
      }
      const result = await retryOnce('qcc', budget, async () => validateQccPayload(
        await this.gateway.call(server, tool, input),
      ));
      if (tool === 'get_company_registration_info' && result.status === 'failed') {
        return {
          sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
          message: '企查查暂不可用，请稍后重试',
        };
      }
      detailPayloads.push(result.status === 'completed' ? result.value : null);
    }

    let mapped: MappedCompanyDetails;
    try {
      mapped = mapCompanyDetails(
        selected,
        detailPayloads[0],
        detailPayloads[1],
        detailPayloads[2],
        detailPayloads[3],
        requestedAt,
      );
    } catch {
      return {
        sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
        message: '企查查暂不可用，请稍后重试',
      };
    }
    this.profiles.upsert({
      identity: mapped.identity,
      normalizedLegalName: normalizeLegalName(mapped.identity.legalName),
      basicProfile: mapped.basicProfile,
      collectedAt: mapped.basicProfile.collected_at,
    });
    return {
      sourceStatus: 'completed',
      candidates: candidates.map(candidateToService),
      basicProfile: basicProfileToService(mapped.basicProfile),
      cacheHit: false,
    };
  }
}
