import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { PRODUCT_RULES } from '../opportunity/product-rules.js';
import {
  AcceptedResearchRequestSchema,
  DEFAULT_RESEARCH_GOAL,
  ProductKeySchema,
  RESEARCH_METHOD_VERSION,
  RESEARCH_TEMPLATE,
  ResearchDossierSchema,
  ResearchBudgetUsageSchema,
  ResearchSourceStatusSchema,
  ResearchRunSchema,
  ResearchVersionSchema,
  normalizeResearchRequest,
  parseResearchSnapshot,
  researchRequestHash,
  type AcceptedResearchRequest,
  type ProductKey,
  type ResearchDossier,
  type ResearchRun,
  type ResearchSnapshot,
  type ResearchVersion,
  type StartResearchInput,
} from './contracts.js';
export interface ResearchRepositoryOptions {
  maxQueued?: number;
  maxPerActor?: number;
  maxRunning?: number;
  now?: () => Date;
  template?: { id: 'company_research'; version: number };
}
export interface ResearchStartResult extends ResearchRun {
  replayed: boolean;
  template: ResearchRun['request']['template'];
}
export class ResearchError extends Error {
  constructor(
    code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ResearchError';
  }
}
const emptyBudget = { qcc: 0, search: 0, ark: 0, total: 0 };
export class ResearchRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: ResearchRepositoryOptions = {},
  ) {
    for (const n of [
      options.maxQueued ?? 20,
      options.maxPerActor ?? 3,
      options.maxRunning ?? 1,
    ])
      if (!Number.isInteger(n) || n < 1)
        throw new Error('RESEARCH_CONFIG_INVALID');
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private one(
    sql: string,
    ...args: SQLInputValue[]
  ): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...args) as
      | Record<string, unknown>
      | undefined;
  }
  private all(
    sql: string,
    ...args: SQLInputValue[]
  ): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...args) as Record<string, unknown>[];
  }
  private runRow(row: Record<string, unknown>): ResearchRun {
    const {
      request_json,
      progress_json,
      budget_usage_json,
      source_status_json,
      ...rest
    } = row;
    return ResearchRunSchema.parse({
      ...rest,
      request: JSON.parse(String(request_json)),
      progress: JSON.parse(String(progress_json)),
      budget_usage: JSON.parse(String(budget_usage_json)),
      source_status: JSON.parse(String(source_status_json)),
    });
  }
  private versionRow(row: Record<string, unknown>): ResearchVersion {
    const { scope_json, snapshot_json, ...rest } = row;
    return ResearchVersionSchema.parse({
      ...rest,
      scope: JSON.parse(String(scope_json)),
      snapshot: parseResearchSnapshot(JSON.parse(String(snapshot_json))),
    });
  }
  getRun(id: string): ResearchRun | null {
    const row = this.one(
      'SELECT * FROM company_research_runs WHERE run_id=?',
      id,
    );
    return row ? this.runRow(row) : null;
  }
  /** Read diagnostics without decoding an unsupported future accepted request. */
  runMetadata(id: string): Record<string, unknown> | null {
    const row = this.one(
      'SELECT * FROM company_research_runs WHERE run_id=?',
      id,
    );
    if (!row) return null;
    const {
      request_json,
      request_hash,
      operation_id,
      progress_json,
      budget_usage_json,
      source_status_json,
      ...metadata
    } = row;
    const request = JSON.parse(String(request_json));
    return {
      ...metadata,
      template: request.template ?? null,
      schema_version: request.schema_version ?? null,
      method_version: request.method_version ?? null,
      progress: JSON.parse(String(progress_json)),
      budget_usage: JSON.parse(String(budget_usage_json)),
      source_status: JSON.parse(String(source_status_json)),
    };
  }
  /** Catalogue envelopes are readable even when a newer result schema is unavailable. */
  versionMetadata(dossierId: string, offset = 0, limit = 10) {
    z.number().int().nonnegative().parse(offset);
    z.number().int().min(1).max(50).parse(limit);
    const total = Number(
      this.one(
        'SELECT count(*) n FROM company_research_versions WHERE dossier_id=?',
        dossierId,
      )!.n,
    );
    const items = this.all(
      'SELECT version_id,dossier_id,run_id,sequence,parent_version_id,scope_json,status,snapshot_json,created_at FROM company_research_versions WHERE dossier_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?',
      dossierId,
      limit,
      offset,
    ).map((row) => {
      const { snapshot_json, scope_json, ...rest } = row;
      const snapshot = JSON.parse(String(snapshot_json));
      return {
        ...rest,
        product_keys: JSON.parse(String(scope_json)),
        template: snapshot.template ?? null,
        schema_version: snapshot.schema_version ?? null,
        method_version: snapshot.method_version ?? null,
      };
    });
    return {
      items,
      total,
      next_offset: offset + items.length < total ? offset + items.length : null,
    };
  }
  getDossier(id: string): ResearchDossier | null {
    const row = this.one(
      'SELECT * FROM company_research_dossiers WHERE dossier_id=?',
      id,
    );
    return row ? ResearchDossierSchema.parse(row) : null;
  }
  dossierByCreditCode(code: string): ResearchDossier | null {
    const row = this.one(
      'SELECT * FROM company_research_dossiers WHERE credit_code=?',
      code,
    );
    return row ? ResearchDossierSchema.parse(row) : null;
  }
  getVersion(id: string): ResearchVersion | null {
    const row = this.one(
      'SELECT * FROM company_research_versions WHERE version_id=?',
      id,
    );
    return row ? this.versionRow(row) : null;
  }
  versions(dossierId: string, offset = 0, limit = 50): ResearchVersion[] {
    z.number().int().nonnegative().parse(offset);
    z.number().int().min(1).max(50).parse(limit);
    return this.all(
      'SELECT * FROM company_research_versions WHERE dossier_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?',
      dossierId,
      limit,
      offset,
    ).map((r) => this.versionRow(r));
  }
  latestVersion(id: string): ResearchVersion | null {
    const row = this.one(
      'SELECT * FROM company_research_versions WHERE dossier_id=? ORDER BY sequence DESC LIMIT 1',
      id,
    );
    return row ? this.versionRow(row) : null;
  }
  latestProducts(
    id: string,
    asOf?: string,
  ): Partial<Record<ProductKey, ResearchVersion>> {
    const result: Partial<Record<ProductKey, ResearchVersion>> = {};
    const rows = asOf
      ? this.all(
          'SELECT * FROM company_research_versions WHERE dossier_id=? AND created_at<=? ORDER BY sequence DESC',
          id,
          asOf,
        )
      : this.all(
          'SELECT * FROM company_research_versions WHERE dossier_id=? ORDER BY sequence DESC',
          id,
        );
    for (const row of rows) {
      const v = this.versionRow(row);
      for (const p of v.scope) if (!result[p]) result[p] = v;
    }
    return result;
  }
  replay(input: StartResearchInput, actor: string): ResearchStartResult | null {
    if (!actor.trim()) throw new Error('ACTOR_REQUIRED');
    const row = this.one(
      'SELECT * FROM company_research_runs WHERE actor=? AND operation_id=?',
      actor,
      input.operation_id,
    );
    if (!row) return null;
    if (row.request_hash !== researchRequestHash(input))
      throw new ResearchError('RESEARCH_OPERATION_CONFLICT');
    const run = this.runRow(row);
    return { ...run, replayed: true, template: run.request.template };
  }
  assertWritable(): void {
    for (const row of this.all(
      'SELECT snapshot_json FROM company_research_versions',
    ))
      parseResearchSnapshot(JSON.parse(String(row.snapshot_json)));
  }
  begin(
    raw: unknown,
    actor: string,
    identityLookup?: (creditCode: string, legalName: string) => boolean,
  ): ResearchStartResult {
    const input = normalizeResearchRequest(raw);
    const replay = this.replay(input, actor);
    if (replay) return replay;
    return this.tx(() => {
      const second = this.replay(input, actor);
      if (second) return second;
      if (input.template_id === 'product_sales_scenario')
        throw new ResearchError('RESEARCH_TEMPLATE_UNAVAILABLE');
      this.assertWritable();
      let dossier =
        input.mode === 'initial'
          ? this.dossierByCreditCode(input.credit_code)
          : this.getDossier(input.dossier_id);
      if (input.mode !== 'initial' && !dossier)
        throw new ResearchError('RESEARCH_DOSSIER_NOT_FOUND');
      if (dossier) {
        const active = this.one(
          "SELECT run_id FROM company_research_runs WHERE dossier_id=? AND status IN ('queued','running')",
          dossier.dossier_id,
        );
        if (active)
          throw new ResearchError('RESEARCH_ALREADY_RUNNING', {
            run_id: active.run_id,
          });
      }
      const latest = dossier ? this.latestVersion(dossier.dossier_id) : null;
      if (input.mode === 'initial' && latest)
        throw new ResearchError('RESEARCH_ALREADY_EXISTS', {
          dossier_id: dossier!.dossier_id,
        });
      if (
        input.mode !== 'initial' &&
        latest?.version_id !== input.base_version_id
      )
        throw new ResearchError('RESEARCH_VERSION_CONFLICT', {
          latest_version_id: latest?.version_id ?? null,
        });
      const legalName =
        input.mode === 'initial' ? input.legal_name : dossier!.legal_name;
      const creditCode =
        input.mode === 'initial' ? input.credit_code : dossier!.credit_code;
      if (identityLookup && !identityLookup(creditCode, legalName))
        throw new ResearchError('RESEARCH_IDENTITY_REQUIRED');
      if (
        Number(
          this.one(
            "SELECT count(*) n FROM company_research_runs WHERE status='queued'",
          )!.n,
        ) >= (this.options.maxQueued ?? 20)
      )
        throw new ResearchError('RESEARCH_QUEUE_FULL');
      if (
        Number(
          this.one(
            "SELECT count(*) n FROM company_research_runs WHERE actor=? AND status IN ('queued','running')",
            actor,
          )!.n,
        ) >= (this.options.maxPerActor ?? 3)
      )
        throw new ResearchError('RESEARCH_USER_LIMIT');
      const selectedTemplate =
        AcceptedResearchRequestSchema.shape.template.safeParse(
          this.options.template ?? RESEARCH_TEMPLATE,
        );
      if (!selectedTemplate.success)
        throw new ResearchError('RESEARCH_VERSION_UNSUPPORTED');
      const template = selectedTemplate.data;
      const scope =
        input.products ??
        (input.mode === 'initial'
          ? [...ProductKeySchema.options]
          : latest!.scope);
      const previous = dossier ? this.latestProducts(dossier.dossier_id) : {};
      const bases: AcceptedResearchRequest['product_base_versions'] = {};
      const goals: AcceptedResearchRequest['product_goals'] = {};
      for (const p of scope) {
        const v = input.mode === 'initial' ? null : previous[p];
        bases[p] = v?.version_id ?? null;
        goals[p] =
          input.goal ?? v?.snapshot.product_goals[p] ?? DEFAULT_RESEARCH_GOAL;
      }
      const effective =
        scope.length === 1
          ? goals[scope[0]]!
          : ProductKeySchema.options
              .filter((p) => scope.includes(p))
              .map(
                (p) =>
                  `${PRODUCT_RULES.find((rule) => rule.product === p)!.displayName}: ${goals[p]}`,
              )
              .join('\n');
      const request = AcceptedResearchRequestSchema.parse({
        client_request: input,
        schema_version: 1,
        template,
        method_version: RESEARCH_METHOD_VERSION,
        product_keys: scope,
        product_goals: goals,
        product_base_versions: bases,
        effective_goal: effective,
      });
      const at = this.now();
      if (!dossier) {
        dossier = {
          dossier_id: randomUUID(),
          credit_code: creditCode,
          legal_name: legalName,
          created_by: actor,
          created_at: at,
          updated_at: at,
        };
        this.db
          .prepare('INSERT INTO company_research_dossiers VALUES (?,?,?,?,?,?)')
          .run(dossier.dossier_id, creditCode, legalName, actor, at, at);
      }
      const runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO company_research_runs(run_id,dossier_id,actor,operation_id,request_hash,mode,base_version_id,request_json,status,progress_json,budget_usage_json,source_status_json,created_at) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?)`,
        )
        .run(
          runId,
          dossier.dossier_id,
          actor,
          input.operation_id,
          researchRequestHash(input),
          input.mode,
          input.mode === 'initial' ? null : input.base_version_id,
          JSON.stringify(request),
          JSON.stringify({ phase: 'queued', completed_rounds: 0 }),
          JSON.stringify(emptyBudget),
          '[]',
          at,
        );
      const run = this.getRun(runId)!;
      return { ...run, replayed: false, template: run.request.template };
    });
  }
  queued(): ResearchRun[] {
    return this.all(
      "SELECT * FROM company_research_runs WHERE status='queued' ORDER BY created_at,rowid",
    ).map((r) => this.runRow(r));
  }
  active(): ResearchRun[] {
    return this.all(
      "SELECT * FROM company_research_runs WHERE status IN ('queued','running') ORDER BY created_at,run_id",
    ).map((r) => this.runRow(r));
  }
  claim(runId?: string): ResearchRun | null {
    return this.tx(() => {
      if (
        Number(
          this.one(
            "SELECT count(*) n FROM company_research_runs WHERE status='running'",
          )!.n,
        ) >= (this.options.maxRunning ?? 1)
      )
        return null;
      const run = runId ? this.getRun(runId) : this.queued()[0];
      if (!run || run.status !== 'queued') return null;
      this.db
        .prepare(
          "UPDATE company_research_runs SET status='running',started_at=?,progress_json=? WHERE run_id=? AND status='queued'",
        )
        .run(
          this.now(),
          JSON.stringify({ phase: 'running', completed_rounds: 0 }),
          run.run_id,
        );
      return this.getRun(run.run_id);
    });
  }
  updateProgress(
    runId: string,
    progress: ResearchRun['progress'],
    budgetUsage: ResearchRun['budget_usage'],
    sourceStatus: ResearchRun['source_status'] = [],
  ): ResearchRun {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== 'running')
        throw new ResearchError('RESEARCH_RUN_NOT_ACTIVE');
      const validated = ResearchRunSchema.parse({
        ...run,
        progress,
        budget_usage: budgetUsage,
        source_status: sourceStatus,
      });
      this.db
        .prepare(
          'UPDATE company_research_runs SET progress_json=?,budget_usage_json=?,source_status_json=? WHERE run_id=?',
        )
        .run(
          JSON.stringify(validated.progress),
          JSON.stringify(validated.budget_usage),
          JSON.stringify(validated.source_status),
          runId,
        );
      return this.getRun(runId)!;
    });
  }
  finish(
    runId: string,
    raw: unknown,
    status: 'completed' | 'partial' = 'completed',
    stopReason: string | null = null,
  ): ResearchVersion {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== 'running')
        throw new ResearchError('RESEARCH_RUN_NOT_ACTIVE');
      const s = parseResearchSnapshot(raw),
        dossier = this.getDossier(run.dossier_id)!;
      const latest = this.latestVersion(run.dossier_id);
      if ((latest?.version_id ?? null) !== run.base_version_id)
        throw new ResearchError('RESEARCH_VERSION_CONFLICT');
      const expectedBases = [
        ...new Set(
          Object.values(run.request.product_base_versions).filter(
            (v): v is string => v !== null,
          ),
        ),
      ].sort();
      if (
        s.dossier_id !== run.dossier_id ||
        s.run_id !== run.run_id ||
        s.credit_code !== dossier.credit_code ||
        s.legal_name !== dossier.legal_name ||
        s.parent_version_id !== run.base_version_id ||
        JSON.stringify([...s.product_keys].sort()) !==
          JSON.stringify([...run.request.product_keys].sort()) ||
        run.request.product_keys.some(
          (product) =>
            s.product_goals[product] !== run.request.product_goals[product],
        ) ||
        s.effective_goal !== run.request.effective_goal ||
        s.template.id !== run.request.template.id ||
        s.template.version !== run.request.template.version ||
        s.method_version !== run.request.method_version ||
        JSON.stringify([...new Set(s.evidence_base_version_ids)].sort()) !==
          JSON.stringify(expectedBases)
      )
        throw new ResearchError('RESEARCH_SNAPSHOT_MISMATCH');
      for (const base of expectedBases) {
        const v = this.getVersion(base);
        if (!v || v.dossier_id !== run.dossier_id)
          throw new ResearchError('RESEARCH_VERSION_CONFLICT');
      }
      const at = this.now(),
        versionId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO company_research_versions VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          versionId,
          run.dossier_id,
          runId,
          (latest?.sequence ?? 0) + 1,
          run.base_version_id,
          JSON.stringify(s.product_keys),
          z.enum(['completed', 'partial']).parse(status),
          JSON.stringify(s),
          at,
        );
      this.db
        .prepare(
          "UPDATE company_research_runs SET status=?,version_id=?,completed_at=?,stop_reason=?,budget_usage_json=?,source_status_json=? WHERE run_id=? AND status='running'",
        )
        .run(
          status,
          versionId,
          at,
          stopReason,
          JSON.stringify(s.budget_usage),
          JSON.stringify(s.source_status),
          runId,
        );
      this.db
        .prepare(
          'UPDATE company_research_dossiers SET updated_at=? WHERE dossier_id=?',
        )
        .run(at, run.dossier_id);
      return this.getVersion(versionId)!;
    });
  }
  cancel(runId: string, actor: string): ResearchRun {
    if (!actor.trim()) throw new Error('ACTOR_REQUIRED');
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new ResearchError('RESEARCH_RUN_NOT_FOUND');
      if (run.status === 'queued' || run.status === 'running')
        this.db
          .prepare(
            "UPDATE company_research_runs SET status='cancelled',cancelled_by=?,completed_at=?,stop_reason='USER_CANCELLED' WHERE run_id=?",
          )
          .run(actor, this.now(), runId);
      return this.getRun(runId)!;
    });
  }
  fail(
    runId: string,
    errorCode: string,
    stopReason: string = errorCode,
  ): ResearchRun {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new ResearchError('RESEARCH_RUN_NOT_FOUND');
      if (run.status === 'queued' || run.status === 'running')
        this.db
          .prepare(
            "UPDATE company_research_runs SET status='failed',error_code=?,stop_reason=?,completed_at=? WHERE run_id=?",
          )
          .run(
            z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
              .parse(errorCode),
            z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
              .parse(stopReason),
            this.now(),
            runId,
          );
      return this.getRun(runId)!;
    });
  }
  /** Terminal states permit diagnostics only; never changes cancellation, versions or publication. */
  recordDiagnostics(
    runId: string,
    budgetUsage: ResearchRun['budget_usage'],
    sourceStatus: ResearchRun['source_status'],
  ): void {
    const budget = ResearchBudgetUsageSchema.parse(budgetUsage);
    const sources = z.array(ResearchSourceStatusSchema).parse(sourceStatus);
    this.db
      .prepare(
        'UPDATE company_research_runs SET budget_usage_json=?,source_status_json=? WHERE run_id=?',
      )
      .run(JSON.stringify(budget), JSON.stringify(sources), runId);
  }
  recover(): number {
    return this.tx(() =>
      Number(
        this.db
          .prepare(
            "UPDATE company_research_runs SET status='failed',error_code='PROCESS_RESTARTED',stop_reason='PROCESS_RESTARTED',completed_at=? WHERE status IN ('queued','running')",
          )
          .run(this.now()).changes,
      ),
    );
  }
}
