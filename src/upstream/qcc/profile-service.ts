import type { ProfileRepository } from '../../db/profile-repository.js';
import { CallBudget } from '../../orchestration/call-budget.js';
import { retryOnce, UpstreamError } from '../../orchestration/retry.js';
import {
  mapCompanyCandidates,
  mapCompanyDetails,
  normalizeQccLegalName,
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
  return normalizeQccLegalName(value);
}

function profileFailureMessage(error: unknown): string {
  if (error instanceof UpstreamError) {
    if (error.code === 'INVALID_RESPONSE' || error.code === 'UNMAPPABLE_DATASET') {
      return '企查查返回的数据格式暂不兼容，请检查适配器';
    }
    if (error.code === 'SUBJECT_MISMATCH') return '企查查返回主体与所选企业不一致，请重新确认主体';
    if (error.code === 'AUTHENTICATION_ERROR') return '企查查认证失败，请检查凭据或权限';
  }
  return '企查查暂不可用，请稍后重试';
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
      await this.gateway.call('company', 'get_company_by_query', { searchKey: query }),
    ));
    if (lookup.status === 'failed') {
      return {
        sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
        message: profileFailureMessage(lookup.error),
      };
    }

    const candidates = lookup.value;
    if (candidates.length !== 1 || normalizeLegalName(candidates[0].legalName) !== normalizedQuery) {
      return {
        sourceStatus: 'completed', candidates: candidates.map(candidateToService), basicProfile: null, cacheHit: false,
      };
    }

    const selected = candidates[0];
    const input = { searchKey: selected.creditCode };
    const detailRequests = [
      ['company', 'get_company_registration_info'],
      ['company', 'get_company_profile'],
      ['company', 'get_contact_info'],
      ['risk', 'get_company_risk_scan'],
    ] as const;
    const detailPayloads: Array<unknown | null> = [];
    for (const [server, tool] of detailRequests) {
      if (!budget.canConsume('qcc')) {
        return {
          sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
          message: '企查查暂不可用，请稍后重试',
        };
      }
      const result = await retryOnce('qcc', budget, async () => validateQccPayload(
        tool,
        await this.gateway.call(server, tool, input),
        selected,
      ));
      if (result.status === 'failed') {
        return {
          sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
          message: profileFailureMessage(result.error),
        };
      }
      detailPayloads.push(result.value);
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
    } catch (error) {
      return {
        sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false,
        message: profileFailureMessage(error),
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
