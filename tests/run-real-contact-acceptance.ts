/** Explicit opt-in live acceptance. Never included by Vitest; emits counts and codes only. */
import { config } from 'dotenv';
import { join } from 'node:path';
import { acceptanceHarness, acceptanceBudgetOptions, root, type Detail } from './contact-acceptance-support.js';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { evaluateInventedSample, evaluateRealResume } from './contact-live-verdict.js';
config({ path: process.env.ACCEPTANCE_ENV ?? '/Users/tang-codeing/code/salestools/.env', quiet: true });
// This explicit acceptance entry uses local test parsing; production and Linux hardening gates keep their own policy.
process.env.NODE_ENV = 'test';
const budgetOptions = acceptanceBudgetOptions(process.env.ACCEPTANCE_REQUEST_MAX_BYTES);
const samples = ['layout-single-column.pdf', 'layout-two-column.pdf', 'synthetic-card.png', process.env.ACCEPTANCE_RESUME ?? '/Users/tang-codeing/Downloads/J运维简历.pdf'];
for (const [index, file] of samples.entries()) {
  if (process.env.ACCEPTANCE_SAMPLE && Number(process.env.ACCEPTANCE_SAMPLE) !== index + 1) continue;
  const requestStats: Array<{ bytes: number; blocks: number }> = [];
  let stage = 'extract';
  let h: Awaited<ReturnType<typeof acceptanceHarness>> | undefined;
  try {
    h = await acceptanceHarness(file.startsWith('/') ? file : join(root, 'tests/fixtures/contact-documents', file), {
      url: process.env.ARK_API_URL!, model: process.env.ARK_MODEL!, credential: process.env.ARK_CREDENTIAL!,
      ...budgetOptions,
      fetchFn: (async (url, init) => {
        const body = String(init?.body);
        requestStats.push({ bytes: Buffer.byteLength(body), blocks: JSON.parse(JSON.parse(body).messages[1].content).blocks.length });
        const response = await fetch(url, init);
        if (process.env.ACCEPTANCE_SHAPE_DIAGNOSTICS === '1') try {
          const envelope = await response.clone().json() as any;
          const profile = JSON.parse(envelope.choices[0].message.content);
          const shapes = [...(profile.education ?? []).map((x: any) => ['attendance', x.attendance]), ...(profile.employment ?? []).map((x: any) => ['employment', x.employment]), ...(profile.projects ?? []).flatMap((x: any) => [['participation', x.participation], ...(x.clients ?? []).map((c: any) => ['client', c.client])])];
          console.log(JSON.stringify({ sample: index + 1, linkShapes: shapes.map(([kind, value]) => ({ kind, type: Array.isArray(value) ? 'array' : typeof value, keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter(k => ['evidence', 'uncertain', 'field_path', 'value', 'status', 'startDate', 'endDate'].includes(k)) : [], keyCount: value && typeof value === 'object' ? Object.keys(value).length : 0 })) }));
        } catch { /* Never print malformed model content. */ }
        return response;
      }) as typeof fetch,
    });
    const reasons = h.candidates.flatMap(c => c.review_items).reduce((a, c) => ({ ...a, [c.reason]: (a[c.reason] ?? 0) + 1 }), {} as Record<string, number>);
    const base = { requestMaxBytes: budgetOptions.requestMaxBytes ?? 20000, requestStats, reasons, sample: index + 1, status: h.preview.status, blocks: h.parsed.length, warnings: h.preview.warnings, processed: (h.preview.processed_block_ids as unknown[])?.length, unprocessed: (h.preview.unprocessed_block_ids as unknown[])?.length };
    if (h.preview.status !== 'ready_for_review' || !h.candidates.length) { process.exitCode = 1; console.log(JSON.stringify(base)); continue; }
    stage = 'commit';

    console.log(JSON.stringify({ ...base, candidateCounts: h.candidates.reduce((a, c) => ({ ...a, [c.label]: (a[c.label] ?? 0) + 1 }), {} as Record<string, number>) }));
    const committed = await h.commit();
    stage = 'get';
    const details = await Promise.all(committed.results.filter(r => r.entity_id).map(r => h!.graph.request<Detail>('get_contact', { entity_id: r.entity_id })));
    const person = details.find(d => d.entity.label === 'Person');
    const people = details.filter(d => d.entity.label === 'Person').length;
    if (!person) { process.exitCode = 1; console.log(JSON.stringify({ ...base, people, committed: committed.results.filter(r => r.entity_id).length, skipped: committed.results.filter(r => !r.entity_id).length })); continue; }
    stage = 'search';
    const search = new ContactSearch(h.graph);
    const checks: Record<string, unknown> = {};
    for (const [j, d] of details.filter(d => d.entity.label === 'Organization').entries()) {
      const query = String(d.entity.properties.name);
      const formal = await search.search({ query }); const weak = await search.search({ query, include_unverified: true });
      checks[`organization${j + 1}`] = { formal: formal.items.some(i => i.entity_id === person.entity.entity_id), inclusive: weak.items.some(i => i.entity_id === person.entity.entity_id) };
    }
    if (index < 2) {
      const p = person.entity.properties;
      checks.requiredContacts = ['+15550100999', '+15550100888'].every(v => p.telephone.includes(v)) && ['riley@example.test', 'riley.work@example.test'].every(v => p.email.includes(v));
      checks.noIntentAsCurrentJob = !p.jobTitle; checks.noInventedDegree = !p.hasCredential?.length;
      checks.noReferenceSubject = !details.some(d => ['Taylor Example', 'Elm Example Company'].includes(d.entity.properties.name));
      checks.projects = details.filter(d => d.entity.label === 'Project').map(d => {
        const relations = [...d.relations, ...d.unverified_claims].filter(r => r.relation_type === 'clientOrganization');
        const expected = d.entity.properties.name === 'Project Aurora' ? 'Maple Example Client' : 'Ash Example Client';
        return { expectedProject: ['Project Aurora', 'Project Beacon'].includes(d.entity.properties.name), clients: relations.length, correct: relations.every(r => details.find(t => t.entity.entity_id === r.target_id)?.entity.properties.name === expected) };
      });
      checks.clientAsEmployer = person.relations.filter(r => r.relation_type === 'worksFor' && ['Maple Example Client', 'Ash Example Client'].includes(details.find(d => d.entity.entity_id === r.target_id)?.entity.properties.name)).length;
      const spr = await search.search({ query: 'Spruce Example Network', include_unverified: true });
      checks.ambiguityMarked = spr.items.some(i => i.entity_id === person.entity.entity_id && i.match_status === 'unverified');
    }
    if (index === 3) {
      const expectedTechnicalTokens = ['Linux', 'Python', 'Shell', 'Docker', 'Kubernetes', 'K8s', 'MySQL', 'Redis', 'Nginx', 'Ansible', 'Jenkins', 'Git', 'Prometheus', 'Grafana', 'CMDB'];
      const skillText = JSON.stringify(person.entity.properties.skills).toLowerCase();
      const weakSkillText = JSON.stringify(person.unverified_claims.filter(c => c.field_path === 'properties.skills').map(c => c.value)).toLowerCase();
      checks.technicalTokenCoverage = expectedTechnicalTokens.map(token => ({ token, formal: skillText.includes(token.toLowerCase()), inclusive: (skillText + weakSkillText).includes(token.toLowerCase()) }));
      const projectQueries = h.candidates.filter(c => c.label === 'Project').flatMap(c => {
        const value = c.properties.name ?? c.review_items.flatMap(r => r.kind === 'field' && r.field_path === 'properties.name' ? [r.value] : [])[0];
        return typeof value === 'string' ? [value] : [];
      });
      checks.projectKeywordLookup = await Promise.all(projectQueries.map(async query => ({ formal: (await search.search({ query })).items.some(i => i.entity_id === person.entity.entity_id), inclusive: (await search.search({ query, include_unverified: true })).items.some(i => i.entity_id === person.entity.entity_id) })));
      checks.projectClientLinks = details.filter(d => d.entity.label === 'Project').reduce((n, d) => n + [...d.relations, ...d.unverified_claims].filter(r => r.relation_type === 'clientOrganization').length, 0);
      checks.projectParticipation = { formal: person.relations.filter(r => r.relation_type === 'memberOf').length, weak: person.unverified_claims.filter(c => c.relation_type === 'memberOf').length };
      checks.sourceContactCoverage = { telephone: person.entity.properties.telephone.filter((v: string) => h!.parsed.some(b => b.text.includes(v))).length, email: person.entity.properties.email.filter((v: string) => h!.parsed.some(b => b.text.includes(v))).length };
    }
    const verdict = index < 3 ? await evaluateInventedSample(index === 2 ? 'card' : 'resume', details,
      async (query, includeUnverified) => (await search.search({ query, include_unverified: includeUnverified })).items,
      (h.preview.unprocessed_block_ids as unknown[])?.length === 0 && (h.preview.processed_block_ids as unknown[])?.length === h.parsed.length)
      : await evaluateRealResume(details,
        async (query, includeUnverified) => (await search.search({ query, include_unverified: includeUnverified })).items,
        (h.preview.unprocessed_block_ids as unknown[])?.length === 0 && (h.preview.processed_block_ids as unknown[])?.length === h.parsed.length);
    if (!verdict.automaticChecksPassed) process.exitCode = 1;
    else if (process.exitCode !== 1) process.exitCode = 2; // Manual review is never a successful semantic verdict.
    console.log(JSON.stringify({ ...base, automaticChecksPassed: verdict.automaticChecksPassed, semanticAcceptance: verdict.semanticAcceptance, requiredChecks: verdict.checks, committed: committed.results.filter(r => r.entity_id).length, skipped: committed.results.filter(r => !r.entity_id).length, people, telephone: person.entity.properties.telephone?.length, email: person.entity.properties.email?.length, skills: person.entity.properties.skills?.length, schools: person.relations.filter(r => r.relation_type === 'alumniOf').length, employment: person.relations.filter(r => r.relation_type === 'worksFor').length, projects: details.filter(d => d.entity.label === 'Project').length, claims: details.reduce((n, d) => n + d.unverified_claims.length, 0), checks }));
  } catch (e) { process.exitCode = 1; console.log(JSON.stringify({ sample: index + 1, stage, error: e instanceof Error ? e.name : 'unknown', code: (e as { code?: string }).code ?? (e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'UNCLASSIFIED') })); }
  finally { try { await h?.close(); } catch { process.exitCode = 1; console.log(JSON.stringify({ sample: index + 1, stage: 'cleanup', code: 'CLEANUP_FAILED' })); } }
}
