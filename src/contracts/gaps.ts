export const QCC_UNAVAILABLE_LINK_AUDIT_GAP_PREFIX = '企查查来源链接不可用：';

export function qccUnavailableLinkAuditGap(evidenceId: string): string {
  return `${QCC_UNAVAILABLE_LINK_AUDIT_GAP_PREFIX}${evidenceId}`;
}

export function isQccUnavailableLinkAuditGap(gap: string): boolean {
  return gap.startsWith(QCC_UNAVAILABLE_LINK_AUDIT_GAP_PREFIX)
    && gap.length > QCC_UNAVAILABLE_LINK_AUDIT_GAP_PREFIX.length;
}
