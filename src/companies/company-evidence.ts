import type { ContactEvidence } from '../contracts/index.js';
import type { AssessmentRecord } from '../db/assessment-repository.js';
import type { ContextMaterial, ContextCitation, MaterialReadContext, ReportItem } from './company-context-types.js';
export function dedupeMaterials(items: ContextMaterial[]): ContextMaterial[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = JSON.stringify([item.source_key,item.citation.subject_id,item.predicate,item.object,item.statement]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function validateContextRefs(refs: string[], included: ContextMaterial[]): ContextCitation[] {
  const citations = new Map(included.map(item => [item.citation.ref,item.citation]));
  return [...new Set(refs)].map(ref => {
    const citation = citations.get(ref);
    if (!citation) throw Error('UNSUPPORTED_CONTEXT_REFERENCE');
    return citation;
  });
}
export function filterConflictedEvidence(evidence: ContactEvidence[], conflicts: ContactEvidence[]): { usable: ContactEvidence[]; blocked: ContactEvidence[] } {
  const blocked: ContactEvidence[] = [], usable: ContactEvidence[] = [];
  for (const item of evidence) {
    const conflict = conflicts.some(other => other.subject_kind === item.subject_kind
      && other.subject_id === item.subject_id && (other.field_path === item.field_path
        || (other.subject_kind === 'relation' && other.field_path === '$relation')));
    (conflict ? blocked : usable).push(item);
  }
  return { usable,blocked };
}
export function createMaterialReadContext(signal: AbortSignal, selectedReportId: string | null): MaterialReadContext {
  return { signal, remaining_contacts:12,remaining_materials:20,selected_report_id:selectedReportId,
    report_reads:0,report:undefined,contacts:new Map() };
}
export function selectReportForQuestion(reports: ReportItem[], explicitId?: string): string | null {
  return explicitId ?? [...reports].sort((a,b)=>Date.parse(b.generated_at)-Date.parse(a.generated_at)
    || b.assessment_id.localeCompare(a.assessment_id))[0]?.assessment_id ?? null;
}
export function readSelectedReport(context: MaterialReadContext, load: (id:string)=>AssessmentRecord|null): AssessmentRecord|null {
  context.signal.throwIfAborted();
  if(context.report!==undefined) return context.report;
  if(context.selected_report_id===null) return context.report=null;
  if(context.report_reads!==0) throw Error('REPORT_BUDGET_EXHAUSTED');
  context.report_reads=1;
  try {return context.report=load(context.selected_report_id);}
  catch(error) {context.report=null;throw error;}
}
