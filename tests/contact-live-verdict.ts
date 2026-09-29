import type { Detail } from './contact-acceptance-support.js';
export type Lookup = (query: string, includeUnverified: boolean) => Promise<Array<{ entity_id: string; matched_project_id?: string; match_status?: string; claim_ids?: string[]; claim_id?: string }>>;
const sameSet = (values: unknown[], expected: string[]) => values.length === expected.length && expected.every(x => values.includes(x));
/** Closed synthetic expectations only; this is not a product semantic validator. */
export async function evaluateInventedSample(kind: 'resume' | 'card', details: Detail[], lookup: Lookup, fullyProcessed: boolean) {
  const people = details.filter(d => d.entity.label === 'Person');
  const person = people[0];
  const checks: Record<string, boolean> = { fullyProcessed, singlePerson: people.length === 1 };
  if (!person) return { checks, automaticChecksPassed: false, semanticAcceptance: 'failed' as const };
  const id = person.entity.entity_id; const p = person.entity.properties;
  const orgs = details.filter(d => d.entity.label === 'Organization');
  const projects = details.filter(d => d.entity.label === 'Project');
  const targetName = (target: string) => details.find(d => d.entity.entity_id === target)?.entity.properties.name;
  const hasFormalHit = async (name: string, projectId?: string) => (await lookup(name, false)).some(hit => hit.entity_id === id && (!projectId || hit.matched_project_id === projectId));
  const hasMarkedHit = async (name: string, claimIds: string[]) => (await lookup(name, true)).some(hit => hit.entity_id === id && hit.match_status === 'unverified' && claimIds.some(c => hit.claim_id === c || hit.claim_ids?.includes(c)));
  const pendingAssociation = (name: string) => person.unverified_claims.filter(c => c.status === 'unverified' && c.relation_type === 'affiliation' && targetName(c.target_id) === name);
  if (kind === 'card') {
    checks.personName = p.name === 'Robin Vale';
    checks.organizationSet = sameSet(orgs.map(d => d.entity.properties.name), ['Sample Studio']);
    checks.noInventedContactsOrSkills = ['telephone', 'email', 'skills'].every(f => (p[f] ?? []).length === 0) && !p.jobTitle;
    checks.noUnexpectedNodesOrFormalRelations = details.length === 2 && projects.length === 0 && person.relations.length === 0;
    const claims = pendingAssociation('Sample Studio');
    checks.markedAssociation = claims.length === 1;
    checks.noUnexpectedClaims = details.reduce((n, d) => n + d.unverified_claims.length, 0) === 1;
    checks.noFormalAssociationHit = !await hasFormalHit('Sample Studio');
    checks.markedLookup = await hasMarkedHit('Sample Studio', claims.map(c => c.claim_id));
  } else {
    checks.personName = p.name === 'Riley Example';
    checks.phones = sameSet(p.telephone ?? [], ['+15550100999', '+15550100888']);
    checks.emails = sameSet(p.email ?? [], ['riley@example.test', 'riley.work@example.test']);
    // Literal coverage is necessary for automatic screening, never sufficient for faithful summarization.
    const skills = (p.skills ?? []).map((s: unknown) => String(s).toLowerCase());
    checks.pythonSkill = skills.some((s: string) => s.includes('python'));
    checks.linuxSkill = skills.some((s: string) => s.includes('linux'));
    checks.noCurrentJobOrInventedDegree = !p.jobTitle && !(p.hasCredential ?? []).length;
    checks.organizationSet = sameSet(orgs.map(d => d.entity.properties.name), ['Willow Example Academy', 'Birch Example University', 'Cedar Example Labs', 'Maple Example Client', 'Ash Example Client', 'Spruce Example Network']);
    checks.projectSet = sameSet(projects.map(d => d.entity.properties.name), ['Project Aurora', 'Project Beacon']);
    checks.noExtraNodes = details.length === 9;
    const schoolEdges = person.relations.filter(r => r.relation_type === 'alumniOf' && r.source_id === id);
    checks.schoolEndpoints = sameSet(schoolEdges.map(r => targetName(r.target_id)), ['Willow Example Academy', 'Birch Example University']);
    const jobs = person.relations.filter(r => r.relation_type === 'worksFor' && r.source_id === id);
    checks.employmentEndpoints = jobs.length === 2 && jobs.every(r => targetName(r.target_id) === 'Cedar Example Labs');
    checks.employmentDates = sameSet(jobs.map(r => `${r.properties.role?.startDate}/${r.properties.role?.endDate}`), ['2020/2022', '2022/2023']);
    const memberships = person.relations.filter(r => r.relation_type === 'memberOf' && r.source_id === id);
    checks.projectParticipation = sameSet(memberships.map(r => targetName(r.target_id)), ['Project Aurora', 'Project Beacon']);
    for (const [i, name] of ['Willow Example Academy', 'Birch Example University', 'Cedar Example Labs'].entries()) {
      checks[`institution${i + 1}FormalLookup`] = await hasFormalHit(name);
      checks[`institution${i + 1}InclusiveLookup`] = (await lookup(name, true)).some(hit => hit.entity_id === id);
    }
    for (const [i, [name, client]] of [['Project Aurora', 'Maple Example Client'], ['Project Beacon', 'Ash Example Client']].entries()) {
      const project = projects.find(d => d.entity.properties.name === name);
      const edges = project?.relations.filter(r => r.relation_type === 'clientOrganization' && r.source_id === project.entity.entity_id) ?? [];
      checks[`project${i + 1}ClientEndpoint`] = edges.length === 1 && targetName(edges[0].target_id) === client;
      checks[`project${i + 1}NoWeakExtraClients`] = !project?.unverified_claims.some(c => c.relation_type === 'clientOrganization');
      checks[`project${i + 1}FormalTwoHop`] = !!project && await hasFormalHit(client, project.entity.entity_id);
      checks[`project${i + 1}InclusiveTwoHop`] = !!project && (await lookup(client, true)).some(hit => hit.entity_id === id && hit.matched_project_id === project.entity.entity_id);
    }
    const claims = pendingAssociation('Spruce Example Network');
    checks.ambiguityMarked = claims.length === 1 && !person.relations.some(r => targetName(r.target_id) === 'Spruce Example Network');
    checks.ambiguityNotFormal = !await hasFormalHit('Spruce Example Network');
    checks.ambiguityLookup = await hasMarkedHit('Spruce Example Network', claims.map(c => c.claim_id));
  }
  const automaticChecksPassed = Object.values(checks).every(Boolean);
  // Source attribution, skills paraphrases and omitted optional facts still need human semantic review.
  return { checks, automaticChecksPassed, semanticAcceptance: automaticChecksPassed ? 'manual_review_required' as const : 'failed' as const };
}


/** Fixed requirements for the opt-in resume fixture; never a general semantic judge. */
export async function evaluateRealResume(details: Detail[], lookup: Lookup, fullyProcessed: boolean) {
  const people = details.filter(d => d.entity.label === 'Person');
  const person = people[0];
  const checks: Record<string, boolean> = { fullyProcessed, singlePerson: people.length === 1 };
  if (!person) return { checks, automaticChecksPassed: false, semanticAcceptance: 'failed' as const };
  const p = person.entity.properties, id = person.entity.entity_id;
  checks.contacts = p.telephone?.length === 1 && p.email?.length === 1;
  checks.school = person.relations.some(r => r.relation_type === 'alumniOf' && r.source_id === id);
  checks.employment = person.relations.some(r => r.relation_type === 'worksFor' && r.source_id === id);
  const skillText = (p.skills ?? []).join(' ').toLowerCase();
  // K8s and Kubernetes are the same required technology, not two skills.
  const required = [['Linux'], ['Python'], ['Shell'], ['Docker'], ['Kubernetes', 'K8s'], ['MySQL'], ['Redis'], ['Nginx'], ['Ansible'], ['Jenkins'], ['Git'], ['Prometheus'], ['Grafana'], ['CMDB']];
  checks.formalTechnicalCoverage = required.every(aliases => aliases.some(token =>
    new RegExp(`(^|[^a-z0-9])${token.toLowerCase()}(?=$|[^a-z0-9])`, 'u').test(skillText)));
  const projects = details.filter(d => d.entity.label === 'Project');
  checks.projects = projects.length === 2;
  const memberships = person.relations.filter(r => r.relation_type === 'memberOf' && r.source_id === id);
  checks.formalProjectParticipation = projects.length === 2 && projects.every(d => memberships.some(r => r.target_id === d.entity.entity_id));
  checks.formalProjectLookup = projects.length === 2 && (await Promise.all(projects.map(async d =>
    typeof d.entity.properties.name === 'string' && (await lookup(d.entity.properties.name, false)).some(hit => hit.entity_id === id)))).every(Boolean);
  checks.noInventedClients = details.every(d => ![...d.relations, ...d.unverified_claims].some(r => r.relation_type === 'clientOrganization'));
  const automaticChecksPassed = Object.values(checks).every(Boolean);
  return { checks, automaticChecksPassed, semanticAcceptance: automaticChecksPassed ? 'manual_review_required' as const : 'failed' as const };
}
