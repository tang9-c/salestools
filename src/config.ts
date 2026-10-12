import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';

const CONFIG_KEYS = [
  'TOKEN_ADMIN_KEY_SHA256', 'PORT', 'PUBLIC_MCP_HOST', 'ALLOWED_ORIGINS', 'SQLITE_PATH',
  'QCC_MCP_COMPANY_URL', 'QCC_MCP_RISK_URL', 'QCC_MCP_IPR_URL', 'QCC_MCP_OPERATION_URL', 'QCC_API_KEY',
  'DOUBAO_SEARCH_API_URL', 'DOUBAO_SEARCH_API_KEY', 'ARK_API_URL', 'ARK_MODEL', 'ARK_CREDENTIAL',
  'ARK_EMBEDDING_API_URL', 'ARK_EMBEDDING_MODEL', 'ARK_EMBEDDING_CREDENTIAL',
  'CONTACT_EXTRACT_REQUEST_MAX_BYTES', 'ARK_REQUEST_MAX_BYTES', 'MAX_QCC_CALLS', 'MAX_SEARCH_CALLS', 'MAX_ARK_CALLS', 'MAX_TOTAL_UPSTREAM_CALLS',
  'PROFILE_CACHE_TTL_DAYS', 'ASSESSMENT_CACHE_TTL_DAYS', 'MAX_CONCURRENT_ASSESSMENTS',
  'CONTACT_GRAPH_ENABLED', 'CONTACT_GRAPH_SQLITE_PATH', 'CONTACT_GRAPH_BIN',
  'CONTACT_MAX_PENDING_FILES', 'CONTACT_MAX_FILE_BYTES', 'CONTACT_MAX_PDF_PAGES',
  'CONTACT_MAX_IMAGE_PIXELS', 'CONTACT_MAX_TEMP_BYTES', 'CONTACT_IMPORT_TIMEOUT_MS',
  'CONTACT_IMPORT_CONCURRENCY', 'CONTACT_EXTRACT_MAX_BATCHES', 'CONTACT_EXTRACT_MAX_MODEL_CALLS',
  'CONTACT_PYTHON_BIN', 'CONTACT_WORKER_SOCKET',
] as const;

const nonEmptyString = z.string().trim().min(1);
const httpsUrl = nonEmptyString.url().startsWith('https://');
const optionalTrimmed = z.string().trim().optional().transform(value => value || undefined);
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
  TOKEN_ADMIN_KEY_SHA256: optionalTrimmed.refine(value => value === undefined || /^[a-f0-9]{64}$/.test(value)),
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
  ARK_EMBEDDING_API_URL: optionalTrimmed.refine(value => value === undefined || httpsUrl.safeParse(value).success),
  ARK_EMBEDDING_MODEL: optionalTrimmed,
  ARK_EMBEDDING_CREDENTIAL: optionalTrimmed,
  CONTACT_EXTRACT_REQUEST_MAX_BYTES: positiveInteger.min(6144).max(64000).default(32000),
  ARK_REQUEST_MAX_BYTES: positiveInteger.min(minimumArkRequestBytes).default(12_288),
  MAX_QCC_CALLS: positiveInteger.default(8),
  MAX_SEARCH_CALLS: positiveInteger.default(8),
  MAX_ARK_CALLS: positiveInteger.default(16),
  MAX_TOTAL_UPSTREAM_CALLS: positiveInteger.default(32),
  PROFILE_CACHE_TTL_DAYS: positiveInteger.default(30),
  ASSESSMENT_CACHE_TTL_DAYS: positiveInteger.default(30),
  MAX_CONCURRENT_ASSESSMENTS: positiveInteger.default(1),
  CONTACT_GRAPH_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CONTACT_GRAPH_SQLITE_PATH: nonEmptyString.optional(),
  CONTACT_GRAPH_BIN: nonEmptyString.optional(),
  CONTACT_MAX_PENDING_FILES: positiveInteger.default(10),
  CONTACT_MAX_FILE_BYTES: positiveInteger.max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  CONTACT_MAX_PDF_PAGES: positiveInteger.max(50).default(50),
  CONTACT_MAX_IMAGE_PIXELS: positiveInteger.max(25_000_000).default(25_000_000),
  CONTACT_MAX_TEMP_BYTES: positiveInteger.max(1024 * 1024 * 1024).default(1024 * 1024 * 1024),
  CONTACT_IMPORT_TIMEOUT_MS: positiveInteger.default(900_000),
  CONTACT_IMPORT_CONCURRENCY: positiveInteger.default(1),
  CONTACT_EXTRACT_MAX_BATCHES: positiveInteger.max(8).default(8),
  CONTACT_EXTRACT_MAX_MODEL_CALLS: positiveInteger.max(16).default(16),
  CONTACT_PYTHON_BIN: nonEmptyString.optional(),
  CONTACT_WORKER_SOCKET: nonEmptyString.optional(),
}).strict().superRefine((config, context) => {
  const configuredMaximum = config.MAX_QCC_CALLS + config.MAX_SEARCH_CALLS + config.MAX_ARK_CALLS;
  if (config.MAX_TOTAL_UPSTREAM_CALLS < configuredMaximum) {
    context.addIssue({
      code: 'custom',
      path: ['MAX_TOTAL_UPSTREAM_CALLS'],
      message: 'total upstream calls must cover configured source budgets',
    });
  }
  if (config.CONTACT_GRAPH_ENABLED) {
    if (!config.CONTACT_GRAPH_SQLITE_PATH ||
        resolve(config.CONTACT_GRAPH_SQLITE_PATH) === resolve(config.SQLITE_PATH)) {
      context.addIssue({ code: 'custom', path: ['CONTACT_GRAPH_SQLITE_PATH'], message: 'separate graph path required' });
    }
    if (!config.CONTACT_GRAPH_BIN || !isAbsolute(config.CONTACT_GRAPH_BIN)) {
      context.addIssue({ code: 'custom', path: ['CONTACT_GRAPH_BIN'], message: 'absolute graph executable required' });
    }
  }
  if (config.CONTACT_PYTHON_BIN && !isAbsolute(config.CONTACT_PYTHON_BIN)) {
    context.addIssue({ code: 'custom', path: ['CONTACT_PYTHON_BIN'], message: 'absolute Python executable required' });
  }
  if (config.CONTACT_WORKER_SOCKET && !isAbsolute(config.CONTACT_WORKER_SOCKET)) {
    context.addIssue({ code: 'custom', path: ['CONTACT_WORKER_SOCKET'], message: 'absolute worker socket required' });
  }
});

type ParsedConfig = z.infer<typeof configSchema>;

export type AppConfig = ParsedConfig & {
  tokenAdminKeySha256?: string;
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
  embeddingEnabled: boolean;
  embeddingApiUrl?: string;
  embeddingModel?: string;
  embeddingCredential?: string;
  contactExtractRequestMaxBytes: number;
  arkRequestMaxBytes: number;
  maxQccCalls: number;
  maxSearchCalls: number;
  maxArkCalls: number;
  maxTotalUpstreamCalls: number;
  profileCacheTtlDays: number;
  assessmentCacheTtlDays: number;
  maxConcurrentAssessments: number;
  contactGraphEnabled: boolean;
  contactGraphSqlitePath?: string;
  contactGraphBin?: string;
  contactMaxPendingFiles: number;
  contactMaxFileBytes: number;
  contactMaxPdfPages: number;
  contactMaxImagePixels: number;
  contactMaxTempBytes: number;
  contactImportTimeoutMs: number;
  contactImportConcurrency: number;
  contactExtractMaxBatches: number;
  contactExtractMaxModelCalls: number;
  contactPythonBin?: string;
  contactWorkerSocket?: string;
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
    tokenAdminKeySha256: parsed.data.TOKEN_ADMIN_KEY_SHA256,
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
    embeddingEnabled: Boolean(parsed.data.ARK_EMBEDDING_API_URL
      && parsed.data.ARK_EMBEDDING_MODEL && parsed.data.ARK_EMBEDDING_CREDENTIAL),
    embeddingApiUrl: parsed.data.ARK_EMBEDDING_API_URL,
    embeddingModel: parsed.data.ARK_EMBEDDING_MODEL,
    embeddingCredential: parsed.data.ARK_EMBEDDING_CREDENTIAL,
    contactExtractRequestMaxBytes: parsed.data.CONTACT_EXTRACT_REQUEST_MAX_BYTES,
    arkRequestMaxBytes: parsed.data.ARK_REQUEST_MAX_BYTES,
    maxQccCalls: parsed.data.MAX_QCC_CALLS,
    maxSearchCalls: parsed.data.MAX_SEARCH_CALLS,
    maxArkCalls: parsed.data.MAX_ARK_CALLS,
    maxTotalUpstreamCalls: parsed.data.MAX_TOTAL_UPSTREAM_CALLS,
    profileCacheTtlDays: parsed.data.PROFILE_CACHE_TTL_DAYS,
    assessmentCacheTtlDays: parsed.data.ASSESSMENT_CACHE_TTL_DAYS,
    maxConcurrentAssessments: parsed.data.MAX_CONCURRENT_ASSESSMENTS,
    contactGraphEnabled: parsed.data.CONTACT_GRAPH_ENABLED,
    contactGraphSqlitePath: parsed.data.CONTACT_GRAPH_SQLITE_PATH,
    contactGraphBin: parsed.data.CONTACT_GRAPH_BIN,
    contactMaxPendingFiles: parsed.data.CONTACT_MAX_PENDING_FILES,
    contactMaxFileBytes: parsed.data.CONTACT_MAX_FILE_BYTES,
    contactMaxPdfPages: parsed.data.CONTACT_MAX_PDF_PAGES,
    contactMaxImagePixels: parsed.data.CONTACT_MAX_IMAGE_PIXELS,
    contactMaxTempBytes: parsed.data.CONTACT_MAX_TEMP_BYTES,
    contactImportTimeoutMs: parsed.data.CONTACT_IMPORT_TIMEOUT_MS,
    contactImportConcurrency: parsed.data.CONTACT_IMPORT_CONCURRENCY,
    contactExtractMaxBatches: parsed.data.CONTACT_EXTRACT_MAX_BATCHES,
    contactExtractMaxModelCalls: parsed.data.CONTACT_EXTRACT_MAX_MODEL_CALLS,
    contactPythonBin: parsed.data.CONTACT_PYTHON_BIN,
    contactWorkerSocket: parsed.data.CONTACT_WORKER_SOCKET,
    allowedOriginUrls: new Set(originUrls),
    allowedOriginHostnames: new Set(originUrls.map(value => new URL(value).hostname)),
  };
}
