import {
  type ProductKey,
  type ResearchDossier,
  type ResearchRun,
  type ResearchEvidence,
  type ResearchClaim,
  type ResearchGap,
  type ResearchSnapshot,
  ResearchEvidenceSchema,
} from './contracts.js';
import { type ResearchRepository } from './repository.js';
import {
  evidenceDependencyGroup,
  packEvidenceGroups,
  validateClaim,
  sha256,
} from './evidence.js';
import {
  planResearch,
  mergeEvidence,
  suggestedWork,
  workGap,
  type PendingResearchItem,
  type ProductBaselines,
} from './planner.js';
import { parseAnalysis, type ResearchModel } from './model.js';
import { type ResearchSources, type ResearchSourceBatch } from './sources.js';
import {
  ResearchPolicy,
  systemResearchClock,
  researchLimits,
  type ResearchLimits,
  type ResearchClock,
} from './policy.js';
export interface ResearchRunContext {
  run: ResearchRun;
  dossier: ResearchDossier;
  baselines: ProductBaselines;
  prior: ResearchEvidence[];
  scope: ProductKey[];
  policy: ResearchPolicy;
}
/** Deterministic, bounded local assembly only: Task4 provides this required callback. No upstream calls. */
export interface ResearchResultInput extends ResearchRunContext {
  evidence: ResearchEvidence[];
  facts: ResearchSnapshot['facts'];
  claims: ResearchClaim[];
  gaps: ResearchGap[];
  evidence_checks: ResearchSnapshot['evidence_checks'];
  source_status: ResearchSnapshot['source_status'];
  budget_usage: ResearchSnapshot['budget_usage'];
  conflict_evidence_ids: string[];
  warnings: string[];
  stop_reason: string;
  completed_rounds: number;
  round_search_counts: number[];
  pending_work: PendingResearchItem[];
  assessed_at: string;
}
export interface ResearchRunnerOptions {
  repository: ResearchRepository;
  limits?: Partial<ResearchLimits>;
  clock?: ResearchClock;
  /** Reads already confirmed cached/profile/assessment evidence only. Never parses old report prose. */
  context?: (
    run: ResearchRun,
    dossier: ResearchDossier,
    baselines: ProductBaselines,
  ) => ResearchEvidence[];
  sources: (context: ResearchRunContext) => ResearchSources;
  model: (context: ResearchRunContext) => ResearchModel;
  resultBuilder: (input: ResearchResultInput) => ResearchSnapshot | null;
}
/** Merge projections only when their original content and semantic fields are identical. */
function mergeEntityProjections<T extends { product_keys: ProductKey[] }>(
  entities: readonly T[],
  idField: keyof T,
): T[] {
  const merged = new Map<string, T>();
  for (const entity of entities) {
    const originalId = String(entity[idField]);
    const previous = merged.get(originalId);
    if (!previous) {
      merged.set(originalId, entity);
      continue;
    }
    const { product_keys: oldProducts, ...oldContent } = previous;
    const { product_keys: newProducts, ...newContent } = entity;
    if (JSON.stringify(oldContent) === JSON.stringify(newContent)) {
      merged.set(originalId, {
        ...previous,
        product_keys: [...new Set([...oldProducts, ...newProducts])],
      });
    } else {
      // Distinct frozen versions can reuse a local entity ID: retain both qualified statements.
      const id = sha256(JSON.stringify([originalId, entity]));
      merged.set(id, { ...entity, [idField]: id });
    }
  }
  return [...merged.values()];
}
export class ResearchRunner {
  constructor(private readonly options: ResearchRunnerOptions) {
    researchLimits(options.limits);
  }
  async run(runId: string, serviceSignal: AbortSignal): Promise<void> {
    const repository = this.options.repository;
    const run =
      repository.getRun(runId)?.status === 'running'
        ? repository.getRun(runId)!
        : repository.claim(runId);
    if (!run || run.status !== 'running') return;
    const clock = this.options.clock ?? systemResearchClock;
    const policy = new ResearchPolicy(
      this.options.limits,
      clock,
      serviceSignal,
    );
    let sources: ResearchSources | undefined;
    let model: ResearchModel | undefined;
    const sourceStatus = new Map<
      string,
      ResearchSnapshot['source_status'][number]
    >();
    const active = () =>
      !serviceSignal.aborted && repository.getRun(runId)?.status === 'running';
    try {
      if (!active()) return;
      const dossier = repository.getDossier(run.dossier_id)!;
      const baselines: ProductBaselines = {};
      const roots: ResearchEvidence[] = [];
      const inheritedClaims: ResearchClaim[] = [];
      const inheritedGaps: ResearchGap[] = [];
      const facts: ResearchSnapshot['facts'] = [];
      const checks = new Map<
        string,
        ResearchSnapshot['evidence_checks'][number]
      >();
      const loaded = new Set<string>();
      for (const product of run.request.product_keys) {
        const id = run.request.product_base_versions[product];
        if (!id || loaded.has(id)) continue;
        loaded.add(id);
        const version = repository.getVersion(id);
        if (
          !version ||
          version.dossier_id !== run.dossier_id ||
          !version.scope.includes(product)
        )
          throw new Error('RESEARCH_VERSION_CONFLICT');
        const base = version.snapshot;
        const sourceProducts = run.request.product_keys.filter(
          (p) => run.request.product_base_versions[p] === id,
        );
        for (const p of sourceProducts) baselines[p] = base;
        const relevant = (entity: { product_keys: ProductKey[] }) =>
          entity.product_keys.some((p) => sourceProducts.includes(p));
        const project = <T extends { product_keys: ProductKey[] }>(
          entity: T,
        ): T => ({
          ...entity,
          product_keys: entity.product_keys.filter((p) =>
            sourceProducts.includes(p),
          ),
        });
        const projectedClaims = base.claims.filter(relevant).map(project);
        const projectedGaps = base.gaps.filter(relevant).map(project);
        const projectedFacts = base.facts.filter(relevant).map(project);
        inheritedClaims.push(...projectedClaims);
        inheritedGaps.push(...projectedGaps);
        facts.push(...projectedFacts);
        // Entity references may themselves have only another product label; provenance is not projected.
        const referenced = new Set(
          [...projectedClaims, ...projectedGaps, ...projectedFacts].flatMap(
            (entity) => entity.evidence_ids,
          ),
        );
        for (const e of base.evidence.filter(
          (e) => relevant(e) || referenced.has(e.evidence_id),
        ))
          roots.push(...(evidenceDependencyGroup(e, base.evidence) ?? []));
        for (const check of base.evidence_checks)
          if (roots.some((e) => e.evidence_id === check.evidence_id))
            checks.set(check.evidence_id, check);
      }
      const cached = this.options.context?.(run, dossier, baselines) ?? [];
      const initialById = new Map<string, ResearchEvidence>();
      // Fixed inherited objects win over later cache copies; reads are not fresh collection checks.
      for (const e of [...roots, ...cached]) {
        if (!initialById.has(e.evidence_id))
          initialById.set(e.evidence_id, ResearchEvidenceSchema.parse(e));
      }
      const initial = packEvidenceGroups([...initialById.values()]);
      let evidence = initial.evidence;
      const warnings = new Set<string>(
        initial.omitted ? ['EVIDENCE_OMITTED'] : [],
      );
      let claims = mergeEntityProjections(inheritedClaims, 'claim_id');
      let gaps = mergeEntityProjections(inheritedGaps, 'gap_id');
      const conflictIds = new Set(
        gaps
          .filter((g) => g.kind === 'conflict')
          .flatMap((g) => g.evidence_ids),
      );
      let pending = planResearch(run, baselines, evidence, clock.wall());
      let completedRounds = 0;
      const roundCounts: number[] = [];
      let stopReason = pending.length ? 'RESEARCH_COMPLETE' : 'NO_PENDING_WORK';
      const context: ResearchRunContext = {
        run,
        dossier,
        baselines,
        prior: evidence,
        scope: run.request.product_keys,
        policy,
      };
      const update = (phase: string) => {
        if (active())
          repository.updateProgress(
            runId,
            { phase, completed_rounds: completedRounds },
            policy.usage(),
            [...sourceStatus.values()],
          );
      };
      const accept = (batch: ResearchSourceBatch) => {
        policy.assertOpen('collect');
        if (!active()) throw new Error('RESEARCH_ABORTED');
        const incoming = batch.evidence.map((e) =>
          ResearchEvidenceSchema.parse(e),
        );
        const merged = mergeEvidence(evidence, incoming);
        // Parsing and dependency packing are part of collection validation, not accepted state.
        if (!active()) throw new Error('RESEARCH_ABORTED');
        policy.assertOpen('collect');
        evidence = merged.evidence;
        if (merged.omitted) warnings.add('EVIDENCE_OMITTED');
        for (const w of batch.warnings) warnings.add(w);
        for (const id of batch.conflict_evidence_ids ?? []) conflictIds.add(id);
        for (const status of batch.source_status) {
          const previous = sourceStatus.get(status.source);
          sourceStatus.set(
            status.source,
            previous && previous.status !== status.status
              ? {
                  source: status.source,
                  status: 'partial',
                  error_code: previous.error_code ?? status.error_code,
                }
              : status,
          );
        }
        for (const check of batch.checks) {
          if (!evidence.some((e) => e.evidence_id === check.evidence_id))
            continue;
          const old = checks.get(check.evidence_id);
          checks.set(check.evidence_id, {
            ...check,
            last_checked_at:
              check.last_checked_at ?? old?.last_checked_at ?? null,
            attempts: [...(old?.attempts ?? []), ...check.attempts].slice(-20),
          });
        }
        update('collecting');
        return merged.added;
      };
      const analyzed = async (stage: 'collect' | 'final') => {
        if (!model) model = this.options.model(context);
        const raw = await model.analyze(
          evidence,
          gaps,
          context.scope,
          policy.signal(stage),
          stage,
        );
        if (model.omitted) warnings.add('MODEL_MATERIAL_OMITTED');
        const result = parseAnalysis(
          raw,
          evidence,
          gaps,
          context.scope,
          dossier.credit_code,
        );
        policy.assertOpen(stage);
        if (!active()) throw new Error('RESEARCH_ABORTED');
        claims = result.claims.filter((c) =>
          validateClaim(c, evidence, {
            conflict_evidence_ids: [...conflictIds],
          }),
        );
        gaps = result.gaps;
        sourceStatus.set('model', { source: 'model', status: 'available' });
        return result;
      };
      if (pending.length) {
        sources = this.options.sources(context);
        const searched = new Set<string>();
        for (
          let round = 0;
          round < 3 && pending.length && active() && policy.isOpen('collect');
          round++
        ) {
          let added = 0;
          const current = [...pending];
          // Seed legal visible gaps for each planned question before accepting model suggestions.
          gaps = [
            ...new Map(
              [...gaps, ...current.map(workGap)].map((g) => [g.gap_id, g]),
            ).values(),
          ].slice(0, 100);
          try {
            // Publish each independently validated QCC topic before starting another request.
            for (const topic of [...new Set(current.map((t) => t.topic))].sort(
              (a, b) =>
                Number(b === 'recruitment') - Number(a === 'recruitment'),
            )) {
              policy.assertOpen('collect');
              added += accept(
                await sources.collectQcc(
                  current.filter((t) => t.topic === topic),
                  policy.signal('collect'),
                ),
              );
            }
            added += accept(
              await sources.collectGraph(current, policy.signal('collect')),
            );
            const selected = current
              .filter((t) => !searched.has(t.key))
              .slice(0, round === 0 ? 8 : 4);
            roundCounts.push(selected.length);
            for (const task of selected) {
              policy.assertOpen('collect');
              if (!active()) throw new Error('RESEARCH_ABORTED');
              searched.add(task.key);
              added += accept(
                await sources.search(task, policy.signal('collect')),
              );
            }
            pending = current.filter((t) => !searched.has(t.key));
            completedRounds++;
            update('analyzing');
            if (!added) {
              stopReason = 'NO_NEW_EVIDENCE';
              break;
            }
            if (round < 2 && policy.canStart('ark', 'collect')) {
              const analysis = await analyzed('collect');
              pending.push(
                ...suggestedWork(analysis).filter(
                  (t) =>
                    !searched.has(t.key) &&
                    !pending.some((p) => p.key === t.key),
                ),
              );
            }
            if (round === 2 && pending.length) {
              warnings.add('ROUND_LIMIT');
              stopReason = 'ROUND_LIMIT';
            }
          } catch (error) {
            if (!active()) return;
            if (!policy.isOpen('collect')) {
              stopReason = 'TIME_BUDGET_EXHAUSTED';
              break;
            }
            warnings.add('COLLECTION_FAILED');
            stopReason = 'SOURCE_UNAVAILABLE';
            break;
          }
        }
        if (!active()) return;
        if (!policy.isOpen('collect')) {
          stopReason = 'TIME_BUDGET_EXHAUSTED';
          warnings.add(stopReason);
        }
        if (policy.canStart('ark', 'final')) {
          update('finalizing');
          try {
            await analyzed('final');
          } catch {
            if (!active()) return;
            const failure = policy.isOpen('final')
              ? 'FINAL_MODEL_FAILED'
              : 'TIME_BUDGET_EXHAUSTED';
            warnings.add(failure);
            if (stopReason === 'RESEARCH_COMPLETE') stopReason = failure;
          }
        } else
          warnings.add(
            policy.isOpen('final')
              ? 'BUDGET_EXHAUSTED'
              : 'TIME_BUDGET_EXHAUSTED',
          );
      }
      if (!active()) return;
      if (clock.monotonic() >= policy.upstreamUntil) {
        stopReason = 'TIME_BUDGET_EXHAUSTED';
        warnings.add(stopReason);
      }
      // No further awaits or network calls after this point. The frozen bounded input is locally assembled once.
      const ids = new Set(evidence.map((e) => e.evidence_id));
      claims = claims.filter((c) =>
        validateClaim(c, evidence, { conflict_evidence_ids: [...conflictIds] }),
      );
      gaps = gaps.map((g) => ({
        ...g,
        evidence_ids: g.evidence_ids.filter((id) => ids.has(id)),
      }));
      const input: ResearchResultInput = {
        ...context,
        evidence,
        facts: mergeEntityProjections(
          facts.filter((f) => f.evidence_ids.every((id) => ids.has(id))),
          'fact_id',
        ),
        claims,
        gaps,
        evidence_checks: [...checks.values()].filter((c) =>
          ids.has(c.evidence_id),
        ),
        source_status: [...sourceStatus.values()],
        budget_usage: policy.usage(),
        conflict_evidence_ids: [...conflictIds],
        warnings: [...warnings],
        stop_reason: stopReason,
        completed_rounds: completedRounds,
        round_search_counts: roundCounts,
        pending_work: pending,
        assessed_at: clock.wall().toISOString(),
      };
      if (!evidence.length) {
        repository.fail(runId, 'NO_VALID_EVIDENCE', stopReason);
        return;
      }
      const snapshot = this.options.resultBuilder(input);
      if (!active()) return;
      if (!snapshot) {
        repository.fail(runId, 'NO_VALID_EVIDENCE', stopReason);
        return;
      }
      update('persisting');
      repository.finish(
        runId,
        snapshot,
        warnings.size || snapshot.gaps.some((gap) => gap.kind === 'technical')
          ? 'partial'
          : 'completed',
        stopReason,
      );
    } catch {
      if (active()) repository.fail(runId, 'RESEARCH_FAILED');
    } finally {
      policy.close();
      await Promise.allSettled([sources?.close(), model?.close()]);
      const usage = policy.usage();
      if (serviceSignal.aborted) {
        for (const [source, count] of [
          ['qcc', usage.qcc],
          ['web', usage.search],
          ['model', usage.ark],
          ['graph', usage.graph],
        ] as const) {
          if (count && !sourceStatus.has(source))
            sourceStatus.set(source, {
              source,
              status: 'failed',
              error_code: 'RESEARCH_ABORTED',
            });
        }
      }
      repository.recordDiagnostics(runId, usage, [...sourceStatus.values()]);
    }
  }
}
