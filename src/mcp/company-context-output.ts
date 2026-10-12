import type { CompanyDetail, CompanySummary, CompanyOverview } from '../companies/company-context-types.js';
import { CompanyDetailSchema, CompanyOverviewSchema } from '../contracts/company-context.js';
export function unavailableSummary(id:string,state:'unavailable'|'not_applicable'='unavailable'):CompanySummary {
  return {state,warnings:state==='unavailable'?['COMPANY_CONTEXT_UNAVAILABLE']:[],
    link:{state:'unlinked',organization_id:id,credit_code:null,basis:null,version:0,candidates:[],warnings:[]},
    has_profile:null,report_count:null,latest_report_at:null};
}
export function unavailableDetail(id:string,state:'unavailable'|'not_applicable'='unavailable'):CompanyDetail {
  return {...unavailableSummary(id,state),profile:null,latest_report:null,
    reports:{items:[],total:null,next_offset:null,complete:false}};
}
export function unavailableOverview(state:'unavailable'|'not_applicable'='unavailable'):CompanyOverview {
  return CompanyOverviewSchema.parse({state,warnings:state==='unavailable'?['COMPANY_CONTEXT_UNAVAILABLE']:[],
    organization_ids:[],organizations_complete:false,people:{count:null,loaded_count:0,complete:false},
    projects:{count:null,loaded_count:0,complete:false},reports:null});
}
export function detailOutput(detail:CompanyDetail,now:()=>Date=()=>new Date(),ttlDays=30) {
  const profile=detail.profile;
  return CompanyDetailSchema.parse({...detail,profile:profile?{legal_name:profile.identity.legalName,
    credit_code:profile.identity.creditCode,basic_profile:profile.basicProfile,collected_at:profile.collectedAt,
    stale:Date.parse(profile.collectedAt)<now().getTime()-ttlDays*86_400_000}:null});
}
