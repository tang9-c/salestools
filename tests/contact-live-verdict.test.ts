import { expect, it } from 'vitest';
import { evaluateInventedSample, type Lookup } from './contact-live-verdict.js';
import type { Detail } from './contact-acceptance-support.js';
function sample() {
  const names = ['Willow Example Academy', 'Birch Example University', 'Cedar Example Labs', 'Maple Example Client', 'Ash Example Client', 'Spruce Example Network', 'Project Aurora', 'Project Beacon'];
  const node = (id: string, label: string, name: string): Detail => ({ entity: { entity_id: id, label, properties: { name }, metadata: { version: 1 } }, relations: [], evidence: [], unverified_claims: [] });
  const details = [node('person', 'Person', 'Riley Example'), ...names.map((n, i) => node(`n${i}`, i < 6 ? 'Organization' : 'Project', n))];
  Object.assign(details[0].entity.properties, { telephone: ['+15550100999', '+15550100888'], email: ['riley@example.test', 'riley.work@example.test'], skills: ['Python', 'Linux operations'], hasCredential: [] });
  const edge = (source: string, target: string, relation_type: string, properties = {}) => ({ source_id: source, target_id: target, relation_type, properties });
  details[0].relations = [edge('person', 'n0', 'alumniOf'), edge('person', 'n1', 'alumniOf'), edge('person', 'n2', 'worksFor', { role: { startDate: '2020', endDate: '2022' } }), edge('person', 'n2', 'worksFor', { role: { startDate: '2022', endDate: '2023' } }), edge('person', 'n6', 'memberOf'), edge('person', 'n7', 'memberOf')];
  details[0].unverified_claims = [{ relation_type: 'affiliation', target_id: 'n5', status: 'unverified', claim_id: 'spruce' }];
  details[7].relations = [edge('n6', 'n3', 'clientOrganization')]; details[8].relations = [edge('n7', 'n4', 'clientOrganization')];
  const lookup: Lookup = async (query, weak) => query === names[5] ? (weak ? [{ entity_id: 'person', match_status: 'unverified', claim_ids: ['spruce'] }] : []) : [{ entity_id: 'person', ...(query === names[3] ? { matched_project_id: 'n6' } : query === names[4] ? { matched_project_id: 'n7' } : {}) }];
  return { details, lookup };
}
it('never equates complete automatic checks to semantic certification', async () => {
  const { details, lookup } = sample(); const result = await evaluateInventedSample('resume', details, lookup, true);
  expect(result.automaticChecksPassed).toBe(true); expect(result.semanticAcceptance).toBe('manual_review_required');
});
it.each(['skills', 'memberOf', 'project', 'organization_lookup', 'two_hop', 'partial'])('rejects otherwise complete sample missing %s', async missing => {
  const { details, lookup } = sample();
  if (missing === 'skills') details[0].entity.properties.skills = [];
  if (missing === 'memberOf') details[0].relations = details[0].relations.filter(r => r.relation_type !== 'memberOf');
  if (missing === 'project') details[7].entity.properties.name = 'Wrong project';
  const result = await evaluateInventedSample('resume', details, missing === 'organization_lookup' ? async () => [] : missing === 'two_hop' ? async () => [{ entity_id: 'person' }] : lookup, missing !== 'partial');
  expect(result.automaticChecksPassed).toBe(false); expect(result.semanticAcceptance).toBe('failed');
});
it.each(['wrong_name', 'confirmed', 'extra_phone'])('rejects an inclusive card hit with %s', async defect => {
  const { details } = sample(); const person = details[0]; person.entity.properties = { name: 'Robin Vale', telephone: [], email: [], skills: [] }; person.relations = [];
  const org = details[1]; org.entity.properties.name = defect === 'wrong_name' ? 'Wrong Studio' : 'Sample Studio';
  person.unverified_claims = [{ relation_type: 'affiliation', target_id: org.entity.entity_id, status: defect === 'confirmed' ? 'confirmed' : 'unverified', claim_id: 'card' }];
  if (defect === 'extra_phone') person.entity.properties.telephone = ['invented'];
  expect((await evaluateInventedSample('card', [person, org], async (_q, weak) => weak ? [{ entity_id: 'person', match_status: 'unverified', claim_ids: ['card'] }] : [], true)).automaticChecksPassed).toBe(false);
});

it('requires an exact weak card association and still leaves semantics for review', async () => {
  const { details } = sample(); const person = details[0]; const org = details[1];
  person.entity.properties = { name: 'Robin Vale', telephone: [], email: [], skills: [] }; person.relations = [];
  org.entity.properties.name = 'Sample Studio';
  person.unverified_claims = [{ relation_type: 'affiliation', target_id: org.entity.entity_id, status: 'unverified', claim_id: 'card' }];
  const verdict = await evaluateInventedSample('card', [person, org], async (_q, weak) => weak ? [{ entity_id: 'person', match_status: 'unverified', claim_id: 'card' }] : [], true);
  expect(verdict.automaticChecksPassed).toBe(true);
  expect(verdict.semanticAcceptance).toBe('manual_review_required');
});


it.each(['none', 'skills', 'weak_skill', 'participation', 'lookup', 'client', 'partial'])('screens real resume requirements: %s', async defect => {
  const { evaluateRealResume } = await import('./contact-live-verdict.js');
  const { details } = sample();
  const person = details[0];
  person.entity.properties.telephone = ['+15550100999']; person.entity.properties.email = ['riley@example.test'];
  person.entity.properties.skills = ['Linux', 'Python', 'Shell', 'Docker', 'K8s', 'MySQL', 'Redis', 'Nginx', 'Ansible', 'Jenkins', 'Git', 'Prometheus', 'Grafana', 'CMDB'];
  details[7].relations = []; details[8].relations = [];
  if (defect === 'skills' || defect === 'weak_skill') person.entity.properties.skills.pop();
  if (defect === 'weak_skill') person.unverified_claims.push({ field_path: 'properties.skills', value: 'CMDB' });
  if (defect === 'participation') person.relations = person.relations.filter(r => r.relation_type !== 'memberOf');
  if (defect === 'client') details[7].unverified_claims.push({ relation_type: 'clientOrganization' });
  const verdict = await evaluateRealResume(details, async () => defect === 'lookup' ? [] : [{ entity_id: 'person' }], defect !== 'partial');
  expect(verdict.automaticChecksPassed).toBe(defect === 'none');
  expect(verdict.semanticAcceptance).toBe(defect === 'none' ? 'manual_review_required' : 'failed');
});
