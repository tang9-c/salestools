// A relation verb somewhere in a long OCR quote is not proof that it applies
// to every organization named there. Keep this predicate shared by extraction
// and the automatic import path.
const negative = /(?:不是|并非|未曾|未在|未于|未就读|未任职|未毕业|未学习|没有|\b(?:not|never)\b)/iu;
const nonEmployer = /(?:客户|甲方|服务对象|合作方|合作伙伴|供应商|外包服务对象|\b(?:client|customer|partner|supplier)\b)/iu;
const nonSchool = /(?:客户|甲方|服务对象|合作方|合作伙伴|供应商|\b(?:client|customer|partner|supplier)\b)/iu;
const employmentVerb = /\b(?:works?\s+for|worked\s+for|employed\s+by|works?\s+at)\b|任职|就职|受雇于/iu;
const educationVerb = /\b(?:alumni|studied|graduated|attended)\b|校友|就读|毕业|学习/iu;

export function directInstitutionStatement(type: string, quote: string, targetName: unknown): boolean {
  if ((type !== 'worksFor' && type !== 'alumniOf') || typeof targetName !== 'string'
    || targetName.trim().length === 0) return false;
  return quote.split(/[。.;；,，\r\n]+|(?:并|且|同时)(?=负责|参与|服务|协助|对接|实施|为|在)|\band\s+(?=responsible\s+for|served|worked\s+on)/iu)
    .some(part => part.includes(targetName)
    && !negative.test(part)
    && !(type === 'worksFor' ? nonEmployer : nonSchool).test(part)
    && (type === 'worksFor' ? employmentVerb : educationVerb).test(part));
}

export function hasInstitutionExclusion(text: string): boolean {
  return nonEmployer.test(text) || negative.test(text) || /(?:项目|\bproject\b)/iu.test(text);
}
