import { z } from 'zod';

const CONFIG_KEYS = [
  'PORT', 'PUBLIC_MCP_HOST', 'ALLOWED_ORIGINS', 'SQLITE_PATH',
  'QCC_MCP_COMPANY_URL', 'QCC_MCP_RISK_URL', 'QCC_MCP_IPR_URL', 'QCC_MCP_OPERATION_URL', 'QCC_API_KEY',
  'DOUBAO_SEARCH_API_URL', 'DOUBAO_SEARCH_API_KEY', 'ARK_API_URL', 'ARK_MODEL', 'ARK_CREDENTIAL',
  'ARK_REQUEST_MAX_BYTES', 'MAX_QCC_CALLS', 'MAX_SEARCH_CALLS', 'MAX_ARK_CALLS', 'MAX_TOTAL_UPSTREAM_CALLS',
  'PROFILE_CACHE_TTL_DAYS', 'ASSESSMENT_CACHE_TTL_DAYS', 'MAX_CONCURRENT_ASSESSMENTS',
] as const;

const nonEmptyString = z.string().trim().min(1);
const httpsUrl = nonEmptyString.url().startsWith('https://');
const positiveInteger = z.coerce.number().int().min(1);
const minimumArkRequestBytes = 6_144;

function isCompleteHttpsOrigin(value: string): boolean {
  if (!value.startsWith('https://')) return false;

  const authority = value.slice('https://'.length);
  if (!authority || /[/?#]/.test(authority)) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

const origins = nonEmptyString.refine(
  value => value.split(',').map(origin => origin.trim()).every(isCompleteHttpsOrigin),
);

const configSchema = z.object({
  PORT: positiveInteger.default(3000),
  PUBLIC_MCP_HOST: nonEmptyString,
  ALLOWED_ORIGINS: origins,
  SQLITE_PATH: nonEmptyString,
  QCC_MCP_COMPANY_URL: httpsUrl,
  QCC_MCP_RISK_URL: httpsUrl,
  QCC_MCP_IPR_URL: httpsUrl,
  QCC_MCP_OPERATION_URL: httpsUrl,
  QCC_API_KEY: nonEmptyString,
  DOUBAO_SEARCH_API_URL: httpsUrl,
  DOUBAO_SEARCH_API_KEY: nonEmptyString,
  ARK_API_URL: httpsUrl,
  ARK_MODEL: nonEmptyString,
  ARK_CREDENTIAL: nonEmptyString,
  ARK_REQUEST_MAX_BYTES: positiveInteger.min(minimumArkRequestBytes).default(12_288),
  MAX_QCC_CALLS: positiveInteger.default(8),
  MAX_SEARCH_CALLS: positiveInteger.default(8),
  MAX_ARK_CALLS: positiveInteger.default(16),
  MAX_TOTAL_UPSTREAM_CALLS: positiveInteger.default(32),
  PROFILE_CACHE_TTL_DAYS: positiveInteger.default(30),
  ASSESSMENT_CACHE_TTL_DAYS: positiveInteger.default(30),
  MAX_CONCURRENT_ASSESSMENTS: positiveInteger.default(1),
}).strict().superRefine((config, context) => {
  const configuredMaximum = config.MAX_QCC_CALLS + config.MAX_SEARCH_CALLS + config.MAX_ARK_CALLS;
  if (config.MAX_TOTAL_UPSTREAM_CALLS < configuredMaximum) {
    context.addIssue({
      code: 'custom',
      path: ['MAX_TOTAL_UPSTREAM_CALLS'],
      message: 'total upstream calls must cover configured source budgets',
    });
  }
});

type ParsedConfig = z.infer<typeof configSchema>;

export type AppConfig = ParsedConfig & {
  port: number;
  publicMcpHost: string;
  sqlitePath: string;
  qccMcpCompanyUrl: string;
  qccMcpRiskUrl: string;
  qccMcpIprUrl: string;
  qccMcpOperationUrl: string;
  qccApiKey: string;
  doubaoSearchApiUrl: string;
  doubaoSearchApiKey: string;
  arkApiUrl: string;
  arkModel: string;
  arkCredential: string;
  arkRequestMaxBytes: number;
  maxQccCalls: number;
  maxSearchCalls: number;
  maxArkCalls: number;
  maxTotalUpstreamCalls: number;
  profileCacheTtlDays: number;
  assessmentCacheTtlDays: number;
  maxConcurrentAssessments: number;
  allowedOriginUrls: Set<string>;
  allowedOriginHostnames: Set<string>;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const declaredOnly = Object.fromEntries(
    CONFIG_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]),
  );
  const parsed = configSchema.safeParse(declaredOnly);

  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }

  const originUrls = parsed.data.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  return {
    ...parsed.data,
    port: parsed.data.PORT,
    publicMcpHost: parsed.data.PUBLIC_MCP_HOST,
    sqlitePath: parsed.data.SQLITE_PATH,
    qccMcpCompanyUrl: parsed.data.QCC_MCP_COMPANY_URL,
    qccMcpRiskUrl: parsed.data.QCC_MCP_RISK_URL,
    qccMcpIprUrl: parsed.data.QCC_MCP_IPR_URL,
    qccMcpOperationUrl: parsed.data.QCC_MCP_OPERATION_URL,
    qccApiKey: parsed.data.QCC_API_KEY,
    doubaoSearchApiUrl: parsed.data.DOUBAO_SEARCH_API_URL,
    doubaoSearchApiKey: parsed.data.DOUBAO_SEARCH_API_KEY,
    arkApiUrl: parsed.data.ARK_API_URL,
    arkModel: parsed.data.ARK_MODEL,
    arkCredential: parsed.data.ARK_CREDENTIAL,
    arkRequestMaxBytes: parsed.data.ARK_REQUEST_MAX_BYTES,
    maxQccCalls: parsed.data.MAX_QCC_CALLS,
    maxSearchCalls: parsed.data.MAX_SEARCH_CALLS,
    maxArkCalls: parsed.data.MAX_ARK_CALLS,
    maxTotalUpstreamCalls: parsed.data.MAX_TOTAL_UPSTREAM_CALLS,
    profileCacheTtlDays: parsed.data.PROFILE_CACHE_TTL_DAYS,
    assessmentCacheTtlDays: parsed.data.ASSESSMENT_CACHE_TTL_DAYS,
    maxConcurrentAssessments: parsed.data.MAX_CONCURRENT_ASSESSMENTS,
    allowedOriginUrls: new Set(originUrls),
    allowedOriginHostnames: new Set(originUrls.map(value => new URL(value).hostname)),
  };
}
