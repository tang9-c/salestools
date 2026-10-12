import type { ContactEvidence, ContactRelation, ContactEntity } from '../contracts/index.js';
function shortLocatedEvidence(evidence: ContactEvidence): boolean {
  return typeof evidence.quote === 'string' && evidence.quote.length > 0
    && [...evidence.quote].length <= 500
    && (evidence.locator_status === 'located' || evidence.locator_status === 'not_applicable');
}
export function supportedRelationEvidence(
  evidence: readonly ContactEvidence[], relation: ContactRelation,
  subject: ContactEntity, other: ContactEntity,
): ContactEvidence | null {
  const otherName = other.properties.name;
  if (!otherName) return null;
  const relevant = evidence.filter(item => item.subject_kind === 'relation'
    && item.subject_id === relation.relation_id && shortLocatedEvidence(item));
  const selected = relevant.find(item => {
    const quote = item.quote!;
    if (relation.relation_type === 'worksFor') {
      const role = relation.properties.role;
      return (item.field_path === '$relation' || item.field_path === 'properties.role.roleName')
        && quote.includes(otherName)
        && (!role.roleName || quote.includes(role.roleName));
    }
    if (item.field_path !== '$relation') return false;
    if (/(?:不是|并非|未曾|否认|无此关系|\bnot\b)/iu.test(quote)) return false;
    const relationWords: Record<string, RegExp> = {
      spouse: /配偶|妻|丈夫|夫妻|结婚|spouse|married/iu,
      parent: /父|母|家长|儿|女|孩子|子女|parent|child/iu,
      colleague: /同事|同僚|colleague|coworker/iu,
      alumniOf: /校友|就读|学习|毕业|alumni|studied|graduated/iu,
      affiliation: /所属|关联|affiliat/iu,
      memberOf: /成员|会员|member/iu,
    };
    if (relationWords[relation.relation_type] && !relationWords[relation.relation_type].test(quote)) return false;
    if (typeof item.value === 'object' && item.value !== null && 'relation_type' in item.value
      && item.value.relation_type !== relation.relation_type) return false;
    return (!subject.properties.name || quote.includes(subject.properties.name)) && quote.includes(otherName);
  });
  return selected ?? null;
}
