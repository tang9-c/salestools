import type { IdentityProfile } from '../contracts/identity.js';
import type { ResearchItem } from '../contracts/research.js';
import {
  QccGateway,
  type QccGatewayConfig,
  type QccConnectionFactory,
} from '../upstream/qcc/client.js';
import { mapQccToolResult } from '../upstream/qcc/mapper.js';
import type { QccServer } from '../upstream/qcc/tool-allowlist.js';
import {
  DoubaoSearchClient,
  type DoubaoSearchClientOptions,
} from '../upstream/search/doubao-client.js';
import {
  SearchQuerySchema,
  type SearchQuery,
} from '../upstream/search/search-plan.js';
import { PRODUCT_RULES } from '../opportunity/product-rules.js';
import {
  ingestEvidence,
  containsPrivateContact,
  hasUseLimitation,
  sha256,
} from './evidence.js';
import { findSoftwareAliases } from './software-aliases.js';
import {
  ResearchEvidenceSchema,
  type ProductKey,
  type ResearchEvidence,
  type ResearchSnapshot,
} from './contracts.js';
import {
  type GraphEvidenceCollector,
  type GraphReadContext,
  type GraphCollectionResult,
  type GraphReadOp,
} from './graph-evidence.js';
import { RESEARCH_FOCUS_TERMS, type PendingResearchItem } from './planner.js';
import { COMPANY_RESEARCH_TOPICS } from './templates/company-research.js';
import { ResearchPolicy } from './policy.js';
export interface ResearchSourceBatch {
  evidence: ResearchEvidence[];
  checks: ResearchSnapshot['evidence_checks'];
  source_status: ResearchSnapshot['source_status'];
  warnings: string[];
  conflict_evidence_ids?: string[];
}
export interface ResearchSources {
  collectQcc(
    work: PendingResearchItem[],
    signal: AbortSignal,
  ): Promise<ResearchSourceBatch>;
  search(
    work: PendingResearchItem,
    signal: AbortSignal,
  ): Promise<ResearchSourceBatch>;
  collectGraph(
    work: PendingResearchItem[],
    signal: AbortSignal,
  ): Promise<ResearchSourceBatch>;
  close(): Promise<void>;
}
export interface ResearchSourceContext {
  identity: IdentityProfile;
  scope: ProductKey[];
  policy: ResearchPolicy;
  prior: ResearchEvidence[];
}
export function buildResearchSearchQuery(
  identity: IdentityProfile,
  work: PendingResearchItem,
  scope: readonly ProductKey[],
): SearchQuery {
  if (
    !work.product_keys.length ||
    work.product_keys.some((p) => !scope.includes(p))
  )
    throw new Error('INVALID_QUERY');
  if (
    (work.focus_terms ?? []).some(
      (term) => !(RESEARCH_FOCUS_TERMS as readonly string[]).includes(term),
    ) ||
    (work.focus_terms?.length ?? 0) > 4
  )
    throw new Error('INVALID_QUERY');
  const topic = COMPANY_RESEARCH_TOPICS[work.topic];
  if (!topic) throw new Error('INVALID_QUERY');
  const products = work.product_keys
    .map((p) =>
      PRODUCT_RULES.find((r) => r.product === p)!
        .displayName.replace(/^(?:PTC |Dassault Systèmes )/u, '')
        .replace('CST Studio Suite', 'CST'),
    )
    .join(' ');
  // Fixed subject and a controlled topic; no model-provided free-form search string reaches this endpoint.
  return SearchQuerySchema.parse({
    Query: `${identity.legalName} ${products} ${topic.terms}${work.focus_terms?.length ? ' ' + work.focus_terms.join(' ') : ''}`,
    SearchType: 'web',
    Count: 10,
    Filter: {
      NeedUrl: true,
      NeedContent: true,
      ...(['recruitment', 'procurement'].includes(work.topic)
        ? { TimeRange: 'OneYear' as const }
        : {}),
    },
    purpose: topic.purpose,
    subjectLegalName: identity.legalName,
    subjectAliases: identity.aliases,
    subjectOfficialDomains: identity.officialDomains,
    subjectRegisteredAddress: identity.registeredAddress,
    searchedName: identity.legalName,
  });
}
const empty = (): ResearchSourceBatch => ({
  evidence: [],
  checks: [],
  source_status: [],
  warnings: [],
});
const qccCall = (
  work: PendingResearchItem,
): { server: QccServer; tool: string } | null => {
  switch (work.topic) {
    case 'recruitment':
      return { server: 'operation', tool: 'get_recruitment_info' };
    case 'business':
      return { server: 'company', tool: 'get_company_profile' };
    case 'engineering':
      return { server: 'ipr', tool: 'get_patent_info' };
    case 'quality':
      return { server: 'operation', tool: 'get_qualifications' };
    case 'procurement':
      return { server: 'operation', tool: 'get_bidding_info' };
    default:
      return null;
  }
};
function qccRecordKey(
  item: ResearchItem,
  tool: string,
  identity: IdentityProfile,
): { id: string; reliable: boolean } {
  if (item.url)
    return {
      id: sha256(`${identity.creditCode}:${tool}:${item.url}`),
      reliable: true,
    };
  let record: Record<string, unknown> = {};
  try {
    record = JSON.parse(item.content ?? '{}') as Record<string, unknown>;
  } catch {
    /* Unstructured data has no reliable record key. */
  }
  const recordId = record.applicationNumber ?? record.registrationNumber;
  if (typeof recordId === 'string' && recordId.trim())
    return {
      id: sha256(`${identity.creditCode}:${tool}:${recordId}`),
      reliable: true,
    };
  if (tool === 'get_company_profile')
    return { id: sha256(`${identity.creditCode}:${tool}`), reliable: true };
  // Group unlocated records conservatively as one source. Content hashes identify versions, never records.
  return {
    id: `unlocated:${sha256(`${identity.creditCode}:${tool}`)}`,
    reliable: false,
  };
}
function convertItem(
  item: ResearchItem,
  work: PendingResearchItem,
  identity: IdentityProfile,
  tool?: string,
): ResearchEvidence[] {
  const content = item.content ?? item.summary ?? '';
  if (!content) return [];
  const escapedName = identity.legalName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    '\\$&',
  );
  const ownUse = new RegExp(
    `(?:${escapedName}|本公司|我司)(?:已|目前|现|正在|正式|内部|自主|成功|全面|长期|开始|持续|主要|直接|实际|\\s)*(?:使用|采用|部署|运用)`,
    'u',
  );
  const excerpts = content
    .split(/(?<=[。；，\n])/u)
    .map((q) => q.trim())
    .filter((q) => q && !containsPrivateContact(q))
    .slice(0, 4);
  return excerpts.flatMap((quote) => {
    const visibleAliases = findSoftwareAliases(quote);
    const objectNames = visibleAliases
      .map((a) => a.matched_alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|');
    const aliases = visibleAliases.filter((a) =>
      work.product_keys.includes(a.product),
    );
    const products = aliases.length
      ? [...new Set(aliases.map((a) => a.product))]
      : work.product_keys;
    const signal_kind =
      work.topic === 'recruitment'
        ? ('job_requirement' as const)
        : item.entityMatch === 'confirmed' &&
            aliases.length &&
            aliases.every((alias) => {
              const object = alias.matched_alias.replace(
                /[.*+?^${}()|[\]\\]/gu,
                '\\$&',
              );
              // Only known software names plus explicit coordination may precede this object; never another subject.
              return new RegExp(
                `${ownUse.source}(?:\\s|了|的是|的|三维|设计|软件|系统|平台|参数化){0,6}(?:(?:${objectNames})(?![A-Za-z0-9_])\\s*(?:以及|和|与|及|、)\\s*){0,6}${object}(?![A-Za-z0-9_])`,
                'iu',
              ).test(quote);
            }) &&
            !hasUseLimitation(quote) &&
            !/(?:招聘|岗位|要求|熟悉|技能|培训|供应商|客户)/u.test(quote)
          ? ('direct_use' as const)
          : ('other' as const);
    const common = {
      content,
      collected_at: item.collectedAt,
      published_at: item.publishedAt,
      company_scope: item.entityMatch,
    };
    const source = tool
      ? {
          ...common,
          source_type: 'qcc' as const,
          url: item.url,
          tool,
          record_id: qccRecordKey(item, tool, identity).id,
        }
      : item.url
        ? {
            ...common,
            source_type: 'web' as const,
            url: item.url,
            publisher: item.originalPublisher ?? new URL(item.url).hostname,
          }
        : null;
    if (!source) return [];
    const e = ingestEvidence(source, {
      title: item.title.slice(0, 1000),
      quote: quote.slice(0, 2000),
      product_keys: products,
      signal_kind,
    });
    return e ? [e] : [];
  });
}
export interface ResearchSourcesOptions {
  qcc: Omit<QccGatewayConfig, 'signal'>;
  search: Omit<DoubaoSearchClientOptions, 'signal'>;
}
export interface ResearchSourcesDependencies {
  fetchFn?: typeof fetch;
  qccFactory?: QccConnectionFactory;
  graph?: {
    collector: GraphEvidenceCollector;
    request<T>(
      op: GraphReadOp,
      payload: object,
      signal: AbortSignal,
    ): Promise<T>;
  };
}
/** Creates private QCC/search connections; the graph transport remains shared and is never closed here. */
export function createResearchSources(
  options: ResearchSourcesOptions,
  context: ResearchSourceContext,
  dependencies: ResearchSourcesDependencies = {},
): ResearchSources {
  const { policy, identity, scope, prior } = context;
  const lifecycle = new AbortController();
  const signal = AbortSignal.any([policy.signal('collect'), lifecycle.signal]);
  const gateway = new QccGateway(
    { ...options.qcc, signal },
    dependencies.qccFactory,
  );
  const searchClient = (requestSignal: AbortSignal) =>
    new DoubaoSearchClient({
      ...options.search,
      signal: AbortSignal.any([signal, requestSignal]),
      fetchFn: dependencies.fetchFn ?? options.search.fetchFn,
      now: () => policy.clock.wall(),
    });
  const attempted = new Set<string>();
  let graphDone = false;
  const assert = (requestSignal: AbortSignal) => {
    requestSignal.throwIfAborted();
    signal.throwIfAborted();
    policy.assertOpen('collect');
  };
  type Attempts = ResearchSnapshot['evidence_checks'][number]['attempts'];
  const readAttempt = async <T,>(
    attempts: Attempts,
    dispatch: () => Promise<T>,
  ): Promise<T> => {
    const attempted_at = policy.clock.wall().toISOString();
    try {
      const result = await dispatch();
      attempts.push({ attempted_at, error_code: null });
      return result;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'UPSTREAM_FAILED';
      attempts.push({
        attempted_at,
        error_code: /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
          ? code
          : 'UPSTREAM_FAILED',
      });
      throw error;
    }
  };
  const checked = (
    work: PendingResearchItem,
    evidence: ResearchEvidence[],
    successful: boolean,
    attempts: Attempts = [],
  ): ResearchSnapshot['evidence_checks'] => {
    const at = policy.clock.wall().toISOString();
    const checks: ResearchSnapshot['evidence_checks'] = evidence.map((e) => ({
      evidence_id: e.evidence_id,
      last_checked_at: at,
      check_outcome: 'unchanged',
      attempts: attempts.length
        ? [...attempts]
        : [{ attempted_at: at, error_code: null }],
    }));
    for (const id of work.evidence_ids) {
      const old = prior.find((e) => e.evidence_id === id);
      if (!old || checks.some((c) => c.evidence_id === id)) continue;
      const same = evidence.find((e) => e.source_key === old.source_key);
      const outcome =
        successful && same ? ('changed' as const) : ('unavailable' as const);
      checks.push({
        evidence_id: id,
        last_checked_at: outcome === 'changed' ? at : null,
        check_outcome: outcome,
        attempts: attempts.length
          ? [...attempts]
          : [
              {
                attempted_at: at,
                error_code:
                  outcome === 'unavailable' ? 'SOURCE_UNAVAILABLE' : null,
              },
            ],
      });
    }
    return checks;
  };
  return {
    async collectQcc(work, requestSignal) {
      const batch = empty();
      const ordered = [...work].sort(
        (a, b) =>
          Number(b.topic === 'recruitment') - Number(a.topic === 'recruitment'),
      );
      const grouped = new Map<
        string,
        {
          call: NonNullable<ReturnType<typeof qccCall>>;
          tasks: PendingResearchItem[];
        }
      >();
      for (const task of ordered) {
        if (task.product_keys.some((p) => !scope.includes(p)))
          throw new Error('INVALID_QUERY');
        const call = qccCall(task);
        if (!call) continue;
        const key = `qcc:${call.tool}`;
        const group = grouped.get(key);
        if (group) group.tasks.push(task);
        else grouped.set(key, { call, tasks: [task] });
      }
      for (const [key, { call, tasks }] of grouped) {
        if (attempted.has(key)) continue;
        assert(requestSignal);
        if (!policy.canStart('qcc', 'collect')) {
          batch.warnings.push('BUDGET_EXHAUSTED');
          break;
        }
        attempted.add(key);
        const attempts: Attempts = [];
        let dispatched = false;
        let connectionFailed = false;
        try {
          const payload = await gateway.call(
            call.server,
            call.tool,
            { searchKey: identity.creditCode },
            (prepare) =>
              policy.call(
                'qcc',
                'collect',
                {
                  prepare: async () => {
                    let dispatch: () => Promise<unknown>;
                    try {
                      dispatch = await prepare();
                    } catch (error) {
                      connectionFailed = true;
                      throw error;
                    }
                    return () => {
                      dispatched = true;
                      return readAttempt(attempts, dispatch);
                    };
                  },
                },
                requestSignal,
              ),
          );
          const mapped = mapQccToolResult(
            call.server,
            call.tool,
            payload,
            identity,
            policy.clock.wall(),
          );
          if (
            mapped.items.some(
              (item) => !qccRecordKey(item, call.tool, identity).reliable,
            )
          )
            batch.warnings.push('QCC_RECORD_ID_UNAVAILABLE');
          const combined = {
            ...tasks[0],
            product_keys: [...new Set(tasks.flatMap((t) => t.product_keys))],
          };
          const evidence = mapped.items.flatMap((item) =>
            convertItem(item, combined, identity, call.tool),
          );
          evidence.forEach((e) => ResearchEvidenceSchema.parse(e));
          assert(requestSignal);
          batch.evidence.push(...evidence);
          for (const task of tasks)
            batch.checks.push(...checked(task, evidence, true, attempts));
          batch.source_status.push({ source: 'qcc', status: 'available' });
        } catch (error) {
          assert(requestSignal);
          const errorCode =
            dispatched && !connectionFailed
              ? 'QCC_UNAVAILABLE'
              : 'QCC_CONNECTION_FAILED';
          batch.warnings.push(errorCode);
          batch.source_status.push({
            source: 'qcc',
            status: 'failed',
            error_code: errorCode,
          });
          for (const task of tasks)
            batch.checks.push(...checked(task, [], false, attempts));
        }
      }
      return batch;
    },
    async search(work, requestSignal) {
      const query = buildResearchSearchQuery(identity, work, scope);
      const key = JSON.stringify([
        'web',
        query.Query.normalize('NFKC').trim().replace(/\s+/gu, ' '),
        query.purpose,
        [...work.product_keys].sort(),
      ]);
      if (attempted.has(key)) return empty();
      assert(requestSignal);
      if (!policy.canStart('doubao_search', 'collect'))
        return { ...empty(), warnings: ['BUDGET_EXHAUSTED'] };
      attempted.add(key);
      const attempts: Attempts = [];
      try {
        const items = await policy.call(
          'doubao_search',
          'collect',
          (transportSignal) =>
            readAttempt(attempts, () =>
              searchClient(transportSignal).search(query),
            ),
          requestSignal,
        );
        const evidence = items.flatMap((item) =>
          convertItem(item, work, identity),
        );
        evidence.forEach((e) => ResearchEvidenceSchema.parse(e));
        assert(requestSignal);
        return {
          evidence,
          checks: checked(work, evidence, true, attempts),
          source_status: [{ source: 'web', status: 'available' }],
          warnings: [],
        };
      } catch (error) {
        assert(requestSignal);
        return {
          evidence: [],
          checks: checked(work, [], false, attempts),
          source_status: [
            {
              source: 'web',
              status: 'failed',
              error_code: 'SEARCH_UNAVAILABLE',
            },
          ],
          warnings: ['SEARCH_UNAVAILABLE'],
        };
      }
    },
    async collectGraph(work, requestSignal) {
      const related = work.filter((w) =>
        ['software', 'recruitment', 'project'].includes(w.topic),
      );
      if (!related.length || graphDone) return empty();
      assert(requestSignal);
      graphDone = true;
      if (!dependencies.graph)
        return {
          ...empty(),
          source_status: [
            {
              source: 'graph',
              status: 'unavailable',
              error_code: 'GRAPH_UNAVAILABLE',
            },
          ],
          warnings: ['GRAPH_UNAVAILABLE'],
        };
      const readContext: GraphReadContext = {
        signal: AbortSignal.any([signal, requestSignal]),
        request: <T,>(op: GraphReadOp, payload: object) =>
          policy.graph<T>((readSignal) =>
            dependencies.graph!.request<T>(
              op,
              payload,
              AbortSignal.any([readSignal, requestSignal, lifecycle.signal]),
            ),
          ),
      };
      const result: GraphCollectionResult =
        await dependencies.graph.collector.collect(
          { credit_code: identity.creditCode, legal_name: identity.legalName },
          [...new Set(related.flatMap((w) => w.product_keys))],
          readContext,
        );
      assert(requestSignal);
      return {
        ...result,
        checks: related.flatMap((w) => checked(w, result.evidence, true)),
      };
    },
    async close() {
      lifecycle.abort();
      await gateway.close();
    },
  };
}
