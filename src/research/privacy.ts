export function containsPrivateContact(text: string): boolean {
  const withoutDates = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, '')
    .replace(/\b[0-9A-Z]{18}\b/gu, '');
  return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\d ()-]{8,}\d)|电话|手机|邮箱|婚姻|身份证|出生日期|家庭住址)/iu.test(
    withoutDates,
  );
}
