import type { ContactEvidence } from '../contracts/index.js';
import type { AssessmentRecord } from '../db/assessment-repository.js';
import type { ContextMaterial, ContextCitation, MaterialReadContext, ReportItem } from './company-context-types.js';
export function dedupeMaterials(items: ContextMaterial[]): ContextMaterial[] {
  const seen = new Map<string, ContextMaterial>();
  for (const item of items) {
    // Snapshot facts can require distinct excerpts from the same underlying source.
    // Keep those citations while source_key continues to identify one source.
    const requiredCitation = item.citation.source_type === 'assessment'
      ? [item.citation.ref, item.citation.quote] : null;
    const key = JSON.stringify([item.source_key,item.citation.subject_id,item.predicate,
      item.object,item.statement,requiredCitation]);
    const existing = seen.get(key);
    if (existing) {
      const dependencies = [...new Set([...(existing.required_context_refs ?? []), ...(item.required_context_refs ?? [])])];
      if (dependencies.length) seen.set(key, { ...existing, required_context_refs: dependencies });
    } else seen.set(key, item);
  }
  return [...seen.values()];
}
// Small internal closure shared by material count, byte packing and citation validation.
export function contextDependencyGroup(item: ContextMaterial, available: ContextMaterial[]): ContextMaterial[] | null {
  const refs = new Set<string>();
  const group: ContextMaterial[] = [];
  const pending = [item.citation.ref];
  while (pending.length) {
    const ref = pending.pop()!;
    if (refs.has(ref)) continue;
    refs.add(ref);
    const matches = available.filter(value => value.citation.ref === ref);
    if (!matches.length) return null;
    group.push(...matches);
    for (const match of matches) pending.push(...(match.required_context_refs ?? []));
  }
  return group;
}
export function validateContextRefs(refs: string[], included: ContextMaterial[]): ContextCitation[] {
  const cited = new Set(refs);
  return [...cited].map(ref => {
    const item = included.find(value => value.citation.ref === ref);
    const group = item && contextDependencyGroup(item, included);
    if (!group || group.some(value => !cited.has(value.citation.ref))) throw Error('UNSUPPORTED_CONTEXT_REFERENCE');
    return item!.citation;
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
  return { signal, remaining_contacts:12,remaining_materials:20,remaining_relation_pages:20,selected_report_id:selectedReportId,
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
