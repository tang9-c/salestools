export const QCC_TOOL_ALLOWLIST = {
  company: [
    'get_company_by_query',
    'get_company_registration_info',
    'get_company_profile',
    'get_contact_info',
    'get_shareholder_info',
    'get_actual_controller',
    'get_key_personnel',
  ],
  risk: ['get_company_risk_scan'],
  ipr: ['get_patent_info', 'get_software_copyright_info'],
  operation: [
    'get_recruitment_info',
    'get_financing_records',
    'get_annual_reports',
    'get_bidding_info',
    'get_qualifications',
  ],
} as const;

export type QccServer = keyof typeof QCC_TOOL_ALLOWLIST;
export type QccTool = (typeof QCC_TOOL_ALLOWLIST)[QccServer][number];

export function isAllowedQccTool(server: string, tool: string): server is QccServer {
  if (!Object.hasOwn(QCC_TOOL_ALLOWLIST, server)) return false;
  return (QCC_TOOL_ALLOWLIST[server as QccServer] as readonly string[]).includes(tool);
}
