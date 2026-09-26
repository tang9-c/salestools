import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Json = Record<string, unknown>;
type Count = { tp: number; fp: number; fn: number };
type Fact = { owner: string; field: string; value: string; page: number; quote: string };
type Relation = { source: string; target: string; type: string; page: number; quote: string;
  role?: Partial<Record<'roleName' | 'startDate' | 'endDate', string>> };
type Document = { id: string; file: string; kind: string; pages: readonly { page: number; text: string }[];
  entities?: readonly { id: string; label: 'Person' | 'Organization' }[];
  facts: readonly Fact[]; relations: readonly Relation[]; complexity: readonly string[] };
type SearchCase = { id: string; query: string; target: string };
type AnswerCase = { id: string; question: string; subject?: string; status: string;
  citations: readonly { file_name: string; page: number; quote: string }[];
  requiredQuote?: string;
  allowedEvidenceIds?: readonly string[];
  facts?: readonly { subject?: string; predicate: string; object: string }[] };
type Dataset = { version: string; documents: Document[]; semantic: SearchCase[]; answers: AnswerCase[] };

const root = fileURLToPath(new URL('../', import.meta.url));
const annotationPath = new URL('../tests/fixtures/contact-evals/annotations.json', import.meta.url);
const outputPath = new URL('../docs/validation/contact-management-quality.md', import.meta.url);
const documentDirectory = new URL('../tests/fixtures/contact-documents/', import.meta.url);

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function phrase(value: unknown): string { return typeof value === 'string' ? value : ''; }
function normalize(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase(); }
function fieldValue(field: string, value: string): string {
  return /^(name|alternateName|legalName|jobTitle|roleName|organization)$/u.test(field)
    ? normalize(value) : value;
}
function values(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return list(value).filter((item): item is string => typeof item === 'string');
}
function key(owner: string, field: string, value: string): string {
  return `${owner}\0${field}\0${fieldValue(field, value)}`;
}

export function precision(tp: number, fp: number): number { return tp / Math.max(1, tp + fp); }
export function recall(tp: number, fn: number): number { return tp / Math.max(1, tp + fn); }
export function extractionPass(tp: number, fp: number, fn: number): boolean {
  return precision(tp, fp) >= 0.95 && recall(tp, fn) >= 0.90;
}

export function scoreExtraction(prediction: unknown, truth: Document): {
  counts: Count; fabricatedRelations: number; labelErrors: number; evidenceErrors: string[]; failures: string[];
  passes: boolean; candidateIds: Record<string, string>;
} {
  const candidates = list(obj(prediction).candidates).map(obj);
  const names = new Map<string, string>();
  for (const fact of truth.facts) if (fact.field === 'name') names.set(normalize(fact.value), fact.owner);
  const labels = new Map((truth.entities ?? []).map(entity => [entity.id, entity.label]));
  const candidateIds: Record<string, string> = {};
  const actual = new Map<string, { candidate: Json; field: string; value: string }>();
  const expected = new Map(truth.facts.map(fact => [key(fact.owner, fact.field, fact.value), fact]));
  const failures: string[] = [];
  const evidenceErrors: string[] = [];
  let fp = 0;
  let labelErrors = 0;
  for (const candidate of candidates) {
    const properties = obj(candidate.properties);
    const owner = names.get(normalize(phrase(properties.name))) ?? `unexpected:${phrase(candidate.candidate_id)}`;
    if (!owner.startsWith('unexpected:') && !candidateIds[owner]) candidateIds[owner] = phrase(candidate.candidate_id);
    if (labels.has(owner) && candidate.label !== labels.get(owner)) {
      labelErrors += 1;
      failures.push(`wrong label ${owner}: ${phrase(candidate.label)} expected ${labels.get(owner)}`);
    }
    for (const [field, raw] of Object.entries(properties)) {
      for (const value of values(raw)) {
        const id = key(owner, field, value);
        if (actual.has(id)) {
          fp += 1;
          failures.push(`duplicate ${owner}.${field}: ${value}`);
          continue;
        }
        actual.set(id, { candidate, field, value });
      }
    }
  }
  let tp = 0;
  let fn = 0;
  for (const [id, fact] of expected) {
    const matched = actual.get(id);
    if (!matched) { fn += 1; failures.push(`FN ${fact.owner}.${fact.field}: ${fact.value}`); continue; }
    tp += 1;
    const evidence = list(matched.candidate.evidence).map(obj).find(item =>
      item.field_path === `properties.${fact.field}`
      && typeof item.value === 'string' && fieldValue(fact.field, item.value) === fieldValue(fact.field, fact.value)
      && item.page === fact.page && typeof item.quote === 'string'
      && truth.pages.some(page => page.page === fact.page && page.text.includes(item.quote as string))
      && (item.quote as string).includes(fact.quote));
    if (!evidence) evidenceErrors.push(`evidence/page ${fact.owner}.${fact.field}: ${fact.value}`);
  }
  for (const [id, item] of actual) if (!expected.has(id)) {
    fp += 1; failures.push(`FP ${id.split('\0')[0]}.${item.field}: ${item.value}`);
  }
  const expectedRelations = new Map(truth.relations.map(relation =>
    [`${relation.source}\0${relation.type}\0${relation.target}`, relation]));
  const seenRelations = new Set<string>();
  let fabricatedRelations = 0;
  for (const candidate of candidates) for (const raw of list(candidate.relation_suggestions)) {
    const relation = obj(raw);
    const ownerFor = (id: unknown) => Object.entries(candidateIds).find(([, candidateId]) => candidateId === id)?.[0];
    const relationKey = `${ownerFor(relation.source_candidate_id) ?? '?'}\0${phrase(relation.relation_type)}\0${ownerFor(relation.target_candidate_id) ?? '?'}`;
    const expectedRelation = expectedRelations.get(relationKey);
    if (!expectedRelation || seenRelations.has(relationKey)) {
      fabricatedRelations += 1; fp += 1; failures.push(`fabricated relation ${relationKey}`);
    } else {
      seenRelations.add(relationKey);
      tp += 1;
      const predictedRole = obj(obj(relation.properties).role);
      const expectedRole = expectedRelation.role ?? {};
      for (const field of new Set([...Object.keys(expectedRole), ...Object.keys(predictedRole)])) {
        const want = expectedRole[field as keyof typeof expectedRole];
        const got = predictedRole[field];
        if (typeof want === 'string' && typeof got === 'string'
          && fieldValue(field, got) === fieldValue(field, want)) tp += 1;
        else {
          if (typeof want === 'string') { fn += 1; failures.push(`FN relation ${field}: ${want}`); }
          if (typeof got === 'string') { fp += 1; failures.push(`FP relation ${field}: ${got}`); }
        }
      }
      if (!list(relation.evidence).map(obj).some(proof => proof.page === expectedRelation.page
        && typeof proof.quote === 'string'
        && truth.pages.some(page => page.page === expectedRelation.page && page.text.includes(proof.quote as string))
        && (expectedRelation.quote.includes(proof.quote) || proof.quote.includes(expectedRelation.quote)))) {
        evidenceErrors.push(`evidence/page relation ${relationKey}`);
      }
    }
  }
  for (const relation of truth.relations) {
    const relationKey = `${relation.source}\0${relation.type}\0${relation.target}`;
    if (!seenRelations.has(relationKey)) { fn += 1; failures.push(`FN relation ${relationKey}`); }
  }
  return { counts: { tp, fp, fn }, fabricatedRelations, labelErrors, evidenceErrors, failures,
    passes: extractionPass(tp, fp, fn) && evidenceErrors.length === 0 && fabricatedRelations === 0
      && labelErrors === 0,
    candidateIds };
}

export function scoreSearch(prediction: unknown, targetId: string): { passes: boolean; rank: number | null } {
  const result = obj(prediction);
  const rank = list(result.items).slice(0, 5).findIndex(item => obj(item).entity_id === targetId);
  return { passes: result.mode_used === 'semantic' && rank >= 0, rank: rank < 0 ? null : rank + 1 };
}

export function scoreAnswer(prediction: unknown, truth: Pick<AnswerCase,
  'status' | 'citations' | 'facts' | 'requiredQuote' | 'allowedEvidenceIds'>): {
  passes: boolean; statusCorrect: boolean; fabricatedCitations: number; failures: string[];
} {
  const result = obj(prediction);
  const statusCorrect = result.status === truth.status;
  const failures = statusCorrect ? [] : [`status ${phrase(result.status)} expected ${truth.status}`];
  const citations = list(result.citations).map(obj);
  const requiredTerms = [truth.requiredQuote, ...(truth.facts ?? []).map(fact => fact.object)].filter(
    (item): item is string => typeof item === 'string' && item.length > 0);
  let fabricatedCitations = 0;
  for (const citation of citations) {
    const quote = phrase(citation.quote);
    const supported = truth.citations.some(expected => citation.file_name === expected.file_name
      && citation.page === expected.page && expected.quote.includes(quote) && quote.length > 0
      && typeof citation.evidence_id === 'string' && citation.evidence_id.length > 0
      && (!truth.allowedEvidenceIds || truth.allowedEvidenceIds.includes(citation.evidence_id))
      && (requiredTerms.length === 0 || requiredTerms.some(term => quote.includes(term))));
    if (!supported) { fabricatedCitations += 1; failures.push(`fabricated citation ${phrase(citation.evidence_id)}`); }
  }
  for (const expected of truth.citations) if (!citations.some(citation =>
    citation.file_name === expected.file_name && citation.page === expected.page
    && typeof citation.quote === 'string' && expected.quote.includes(citation.quote))) {
    failures.push(`missing citation ${expected.file_name}:${expected.page}`);
  }
  const actualFacts = list(result.facts).map(obj);
  for (const fact of actualFacts) if (!citations.some(citation => citation.evidence_id === fact.evidence_id)) {
    failures.push(`uncited fact ${phrase(fact.predicate)}:${phrase(fact.object)}`);
  }
  for (const expected of truth.facts ?? []) if (!actualFacts.some(fact =>
    fact.predicate === expected.predicate && fact.object === expected.object)) {
    failures.push(`missing fact ${expected.predicate}:${expected.object}`);
  }
  for (const fact of actualFacts) if (truth.facts && !truth.facts.some(expected =>
    fact.predicate === expected.predicate && fact.object === expected.object)) {
    failures.push(`fabricated fact ${phrase(fact.predicate)}:${phrase(fact.object)}`);
  }
  return { passes: failures.length === 0, statusCorrect, fabricatedCitations, failures };
}

export function summarizeQuality(counts: Count,
  searches: readonly { passes: boolean }[], answers: readonly { passes: boolean; fabricatedCitations: number }[],
  fabricatedRelations: number, evidenceErrors = 0) {
  const semanticTop5 = searches.filter(item => item.passes).length;
  const answeredCorrectly = answers.filter(item => item.passes).length;
  const fabricatedCitations = answers.reduce((sum, item) => sum + item.fabricatedCitations, 0);
  return { precision: precision(counts.tp, counts.fp), recall: recall(counts.tp, counts.fn),
    semanticTop5, answeredCorrectly, fabricatedRelations, fabricatedCitations, evidenceErrors,
    passes: extractionPass(counts.tp, counts.fp, counts.fn) && searches.length === 10 && semanticTop5 >= 9
      && answers.length === 10 && answeredCorrectly === 10 && fabricatedRelations === 0
      && fabricatedCitations === 0 && evidenceErrors === 0 };
}

async function call(client: Client, name: string, args: Json): Promise<Json> {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError || !response.structuredContent) throw new Error(`${name}: tool error`);
  return obj(response.structuredContent);
}
async function upload(file: Document, endpoint: URL, token: string): Promise<string> {
  const bytes = await readFile(new URL(file.file, documentDirectory));
  const mime = extname(file.file) === '.pdf' ? 'application/pdf'
    : extname(file.file) === '.png' ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), file.file);
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!response.ok) throw new Error(`upload ${file.id}: HTTP ${response.status}`);
  const fileId = obj(await response.json()).file_id;
  if (typeof fileId !== 'string' || !fileId) throw new Error(`upload ${file.id}: missing file_id`);
  return fileId;
}
async function preview(client: Client, fileId: string): Promise<Json> {
  const started = await call(client, 'import_contacts', { file_id: fileId, operation_id: randomUUID() });
  const importId = phrase(started.import_id);
  if (!importId) throw new Error('import_contacts: missing import_id');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const first = await call(client, 'get_contact_import', { import_id: importId, offset: 0, limit: 50 });
    if (first.status === 'failed' || first.status === 'cancelled') throw new Error(`import ${importId}: ${first.status}`);
    if (first.status === 'ready_for_review') {
      const candidates = [...list(first.candidates)];
      for (let offset = 50; offset < Number(first.total_candidates); offset += 50) {
        candidates.push(...list((await call(client, 'get_contact_import',
          { import_id: importId, offset, limit: 50 })).candidates));
      }
      return { ...first, candidates };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`import ${importId}: timeout`);
}

function markdown(value: unknown): string { return JSON.stringify(value).replaceAll('|', '\\|'); }
function publicEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? `${url.origin}${url.pathname}` : undefined;
  } catch { return undefined; }
}
async function run(): Promise<number> {
  const raw = await readFile(annotationPath);
  const dataset = JSON.parse(raw.toString('utf8')) as Dataset;
  const fixtureHash = createHash('sha256').update(raw).digest('hex');
  const fileHashes = Object.fromEntries(await Promise.all(dataset.documents.map(async doc =>
    [doc.file, createHash('sha256').update(await readFile(new URL(doc.file, documentDirectory))).digest('hex')])));
  const sourceHashes = Object.fromEntries(await Promise.all([
    'python/uv.lock', 'python/contact_worker/parser.py', 'src/contacts/document-extractor.ts',
    'src/contacts/contact-answer.ts', 'src/contracts/contact-graph.ts',
  ].map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
  const mcpUrl = process.env.CONTACT_EVAL_MCP_URL;
  const uploadUrl = process.env.CONTACT_EVAL_UPLOAD_URL;
  const token = process.env.CONTACT_EVAL_TOKEN;
  if (!mcpUrl || !uploadUrl || !token) {
    process.stderr.write('CONTACT_EVAL_UNVERIFIED: CONTACT_EVAL_MCP_URL, CONTACT_EVAL_UPLOAD_URL and CONTACT_EVAL_TOKEN are required\n');
    return 2;
  }
  const mcp = new URL(mcpUrl);
  const uploadEndpoint = new URL(uploadUrl);
  if (mcp.pathname !== '/mcp' || uploadEndpoint.pathname !== '/contact-files'
      || mcp.origin !== uploadEndpoint.origin || !['http:', 'https:'].includes(mcp.protocol)) {
    throw new Error('CONTACT_EVAL_INVALID_ENDPOINTS');
  }
  const client = new Client({ name: 'contact-quality-evaluator', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(mcp,
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const rows: Array<{ id: string; result: ReturnType<typeof scoreExtraction> }> = [];
  const ids = new Map<string, string>();
  const evidenceIds = new Set<string>();
  const counts: Count = { tp: 0, fp: 0, fn: 0 };
  const startedAt = Date.now();
  try {
    for (const doc of dataset.documents) {
      try {
        const fileId = await upload(doc, uploadEndpoint, token);
        const result = await preview(client, fileId);
        const scored = scoreExtraction(result, doc);
        for (const candidate of list(result.candidates)) {
          for (const evidence of list(obj(candidate).evidence)) {
            const id = obj(evidence).evidence_id;
            if (typeof id === 'string') evidenceIds.add(id);
          }
          for (const relation of list(obj(candidate).relation_suggestions)) {
            for (const evidence of list(obj(relation).evidence)) {
              const id = obj(evidence).evidence_id;
              if (typeof id === 'string') evidenceIds.add(id);
            }
          }
        }
        rows.push({ id: doc.id, result: scored });
        counts.tp += scored.counts.tp; counts.fp += scored.counts.fp; counts.fn += scored.counts.fn;
        // The isolated graph is disposable; incorrect previews still fail extraction scoring.
        const choices = list(result.candidates).map(candidate => ({
          candidate_id: phrase(obj(candidate).candidate_id),
          action: obj(candidate).can_commit === true ? 'create' : 'skip',
        }));
        const selected = new Set(choices.filter(choice => choice.action === 'create')
          .map(choice => choice.candidate_id));
        const relationChoices = list(result.candidates).flatMap(candidate =>
          list(obj(candidate).relation_suggestions).map(obj).filter(relation =>
            selected.has(phrase(relation.source_candidate_id))
              && selected.has(phrase(relation.target_candidate_id))
              && doc.relations.some(expected => scored.candidateIds[expected.source] === relation.source_candidate_id
              && scored.candidateIds[expected.target] === relation.target_candidate_id
              && expected.type === relation.relation_type))
            .map(relation => ({ source_candidate_id: relation.source_candidate_id,
              target_candidate_id: relation.target_candidate_id, relation_type: relation.relation_type,
              properties: obj(relation.properties) })));
        const committed = await call(client, 'commit_contact_import', {
          import_id: result.import_id, preview_version: result.version,
          operation_id: `contact-import:${phrase(result.import_id)}`, choices,
          relation_choices: relationChoices,
        });
        for (const item of list(committed.results)) {
          const row = obj(item);
          const owner = Object.entries(scored.candidateIds).find(([, candidateId]) => candidateId === row.candidate_id)?.[0];
          if (owner && typeof row.entity_id === 'string') ids.set(`${doc.id}/${owner}`, row.entity_id);
        }
      } catch (error) {
        if (rows.at(-1)?.id === doc.id) rows.at(-1)!.result.failures.push(`service error: ${String(error)}`);
        else {
          const fn = doc.facts.length + doc.relations.length;
          counts.fn += fn;
          rows.push({ id: doc.id, result: { counts: { tp: 0, fp: 0, fn }, fabricatedRelations: 0, labelErrors: 0,
            evidenceErrors: [], failures: [`service error: ${String(error)}`], passes: false,
            candidateIds: {} } });
        }
      }
    }
    const searches: Array<{ id: string; passes: boolean; rank: number | null; error?: string }> = [];
    for (const item of dataset.semantic) {
      const targetId = ids.get(item.target);
      if (!targetId) { searches.push({ id: item.id, passes: false, rank: null, error: 'target_not_committed' }); continue; }
      try {
        const found = await call(client, 'search_contacts', { query: item.query, mode: 'semantic', limit: 5 });
        searches.push({ id: item.id, ...scoreSearch(found, targetId) });
      } catch (error) { searches.push({ id: item.id, passes: false, rank: null, error: String(error) }); }
    }
    const answers: Array<{ id: string; result: ReturnType<typeof scoreAnswer> }> = [];
    for (const item of dataset.answers) {
      try {
        const subject = item.subject ? ids.get(item.subject) : undefined;
        const response = await call(client, 'ask_contacts', {
          question: item.question, ...(subject ? { entity_id: subject } : {}),
        });
        answers.push({ id: item.id, result: scoreAnswer(response,
          { ...item, allowedEvidenceIds: [...evidenceIds] }) });
      } catch (error) {
        answers.push({ id: item.id, result: { passes: false, statusCorrect: false,
          fabricatedCitations: 0, failures: [String(error)] } });
      }
    }
    const summary = summarizeQuality(counts, searches, answers.map(item => item.result),
      rows.reduce((sum, row) => sum + row.result.fabricatedRelations, 0),
      rows.reduce((sum, row) => sum + row.result.evidenceErrors.length, 0));
    const serviceErrors = rows.filter(row => row.result.failures.some(failure => failure.startsWith('service error:'))).length;
    const metadata = {
      deployment: process.env.CONTACT_EVAL_DEPLOY_REVISION,
      arkEndpoint: publicEndpoint(process.env.CONTACT_EVAL_ARK_URL ?? process.env.ARK_API_URL),
      arkModel: process.env.CONTACT_EVAL_ARK_MODEL ?? process.env.ARK_MODEL,
      embeddingEndpoint: publicEndpoint(process.env.CONTACT_EVAL_EMBEDDING_URL ?? process.env.ARK_EMBEDDING_API_URL),
      embeddingModel: process.env.CONTACT_EVAL_EMBEDDING_MODEL ?? process.env.ARK_EMBEDDING_MODEL,
      doclingVersion: process.env.CONTACT_EVAL_DOCLING_VERSION,
      ocrVersion: process.env.CONTACT_EVAL_OCR_VERSION,
    };
    const metadataComplete = Object.values(metadata).every(value => typeof value === 'string' && value.length > 0);
    const labelErrors = rows.reduce((sum, row) => sum + row.result.labelErrors, 0);
    const overallPass = summary.passes && serviceErrors === 0 && labelErrors === 0;
    const report = [
      '# 联系人质量评测', '',
      `状态：${!metadataComplete ? 'unverified-config' : overallPass ? 'verified-pass' : 'verified-fail'}`, '',
      `样本版本：${dataset.version}；annotations SHA-256：${fixtureHash}`, '',
      `逐文件 SHA-256：${markdown(fileHashes)}`, '',
      `运行时间：${new Date().toISOString()}；耗时：${Date.now() - startedAt} ms`, '',
      `服务端点：${mcp.origin}；部署与模型元数据：${markdown(metadata)}`, '',
      `本地锁文件、Docling 解析器、抽取提示词、问答提示词和契约 SHA-256：${markdown(sourceHashes)}`, '',
      `微平均 precision=${summary.precision.toFixed(4)}，recall=${summary.recall.toFixed(4)}；semantic Top-5=${summary.semanticTop5}/10；问答=${summary.answeredCorrectly}/10；伪造关系=${summary.fabricatedRelations}；伪造引用=${summary.fabricatedCitations}；证据错误=${summary.evidenceErrors}；实体类型错误=${labelErrors}；服务错误=${serviceErrors}`, '',
      '| 文档 | TP/FP/FN | 关系伪造 | 实体类型错误 | 证据错误 | 失败细节 |', '| --- | --- | --- | --- | --- | --- |',
      ...rows.map(({ id, result }) => `| ${id} | ${result.counts.tp}/${result.counts.fp}/${result.counts.fn} | ${result.fabricatedRelations} | ${result.labelErrors} | ${result.evidenceErrors.length} | ${markdown([...result.failures, ...result.evidenceErrors])} |`),
      '', '| 语义案例 | Top-5 | 排名/原因 |', '| --- | --- | --- |',
      ...searches.map(item => `| ${item.id} | ${item.passes} | ${item.rank ?? item.error ?? 'miss'} |`),
      '', '| 问答案例 | 通过 | 失败细节 |', '| --- | --- | --- |',
      ...answers.map(item => `| ${item.id} | ${item.result.passes} | ${markdown(item.result.failures)} |`), '',
      '若跨页、多人物归属或证据定位案例阻断门槛，须按计划以同一样本、同一 Ark 模型和 8 批/16 次调用预算进行一次固定 Docling Graph 对比，并记录两侧精确率、召回率、证据正确率、耗时、调用次数及下一步决策。当前未运行该对比。', '',
    ].join('\n');
    await writeFile(outputPath, report);
    process.stdout.write(`${JSON.stringify({ summary, report: fileURLToPath(outputPath) })}\n`);
    return !metadataComplete ? 2 : overallPass ? 0 : 1;
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await run(); }
  catch (error) { process.stderr.write(`CONTACT_EVAL_FAILED: ${String(error)}\n`); process.exitCode = 1; }
}
