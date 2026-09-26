import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { ArkEvidenceServiceOptions } from '../src/upstream/ark/client.js';

const arkConstruction = vi.hoisted(() => vi.fn());

vi.mock('../src/upstream/ark/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/upstream/ark/client.js')>();
  return {
    ...actual,
    ArkEvidenceService: class extends actual.ArkEvidenceService {
      constructor(options: ArkEvidenceServiceOptions) {
        arkConstruction(options);
        super(options);
      }
    },
  };
});

const { createApplication } = await import('../src/index.js');

const valid = {
  PUBLIC_MCP_HOST: 'mcp.example.cn',
  ALLOWED_ORIGINS: 'https://codex.example.cn',
  SQLITE_PATH: ':memory:',
  QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
  QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
  QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
  QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream',
  QCC_API_KEY: 'qcc-secret',
  DOUBAO_SEARCH_API_URL: 'https://open.feedcoopapi.com/search_api/web_search',
  DOUBAO_SEARCH_API_KEY: 'search-secret',
  ARK_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  ARK_MODEL: 'ep-test',
  ARK_CREDENTIAL: 'ark-secret',
};

describe('loadConfig', () => {
  const contactLimits = {
    CONTACT_MAX_PENDING_FILES: 10,
    CONTACT_MAX_FILE_BYTES: 20_971_520,
    CONTACT_MAX_PDF_PAGES: 50,
    CONTACT_MAX_IMAGE_PIXELS: 25_000_000,
    CONTACT_MAX_TEMP_BYTES: 1_073_741_824,
    CONTACT_IMPORT_TIMEOUT_MS: 900_000,
    CONTACT_IMPORT_CONCURRENCY: 1,
    CONTACT_EXTRACT_MAX_BATCHES: 8,
    CONTACT_EXTRACT_MAX_MODEL_CALLS: 16,
  } as const;

  it('defaults every contact upload and processing limit', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject(contactLimits);
  });

  it.each(Object.keys(contactLimits))('accepts a positive override and rejects invalid %s', key => {
    const overridden = loadConfig({ ...valid, [key]: '2' } as NodeJS.ProcessEnv);
    expect((overridden as unknown as Record<string, unknown>)[key]).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'not-a-number']) {
      expect(() => loadConfig({ ...valid, [key]: bad } as NodeJS.ProcessEnv))
        .toThrow(`Invalid configuration: ${key}`);
    }
  });

  it('wires the configured upload capacity into the running application', async () => {
    const application = createApplication(loadConfig({ ...valid, CONTACT_MAX_PENDING_FILES: '1' } as NodeJS.ProcessEnv),
      { database: new DatabaseSync(':memory:') });
    await application.uploadStore.reserve();
    await expect(application.uploadStore.reserve()).rejects.toThrow('CAPACITY_FULL');
    await application.close();
  });

  it('requires an absolute Python runtime override and enforces hard document ceilings', () => {
    expect(() => loadConfig({ ...valid, CONTACT_PYTHON_BIN: './python' } as NodeJS.ProcessEnv))
      .toThrow('Invalid configuration: CONTACT_PYTHON_BIN');
    expect(loadConfig({ ...valid, CONTACT_PYTHON_BIN: '/opt/contact/python' } as NodeJS.ProcessEnv).contactPythonBin)
      .toBe('/opt/contact/python');
    expect(() => loadConfig({ ...valid, CONTACT_MAX_FILE_BYTES: '20971521' } as NodeJS.ProcessEnv))
      .toThrow('Invalid configuration: CONTACT_MAX_FILE_BYTES');
  });

  it('ignores undeclared process keys before strict parsing', () => {
    expect(loadConfig({ ...valid, PATH: '/usr/bin', HOME: '/tmp/home', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv))
      .toMatchObject({ maxQccCalls: 8 });
  });

  it('applies v0.1 defaults', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject({
      contactGraphEnabled: false,
      maxQccCalls: 8,
      maxSearchCalls: 8,
      maxArkCalls: 16,
      arkRequestMaxBytes: 12_288,
      maxTotalUpstreamCalls: 32,
      profileCacheTtlDays: 30,
      assessmentCacheTtlDays: 30,
      maxConcurrentAssessments: 1,
    });
  });

  it('requires an explicitly configured binary and separate database when graph is enabled', () => {
    expect(() => loadConfig({ ...valid, CONTACT_GRAPH_ENABLED: 'true' } as NodeJS.ProcessEnv))
      .toThrow(/CONTACT_GRAPH_BIN|CONTACT_GRAPH_SQLITE_PATH/);
    expect(() => loadConfig({ ...valid, CONTACT_GRAPH_ENABLED: 'true',
      CONTACT_GRAPH_BIN: '/tmp/contact-graph', CONTACT_GRAPH_SQLITE_PATH: ':memory:',
    } as NodeJS.ProcessEnv)).toThrow(/CONTACT_GRAPH_SQLITE_PATH/);
    expect(loadConfig({ ...valid, CONTACT_GRAPH_ENABLED: 'true',
      CONTACT_GRAPH_BIN: '/tmp/contact-graph', CONTACT_GRAPH_SQLITE_PATH: '/tmp/contacts.sqlite',
    } as NodeJS.ProcessEnv)).toMatchObject({
      contactGraphEnabled: true,
      contactGraphBin: '/tmp/contact-graph',
      contactGraphSqlitePath: '/tmp/contacts.sqlite',
    });
  });

  it('rejects a relative graph executable or invalid enable flag without leaking values', () => {
    expect(() => loadConfig({ ...valid, CONTACT_GRAPH_ENABLED: 'yes' } as NodeJS.ProcessEnv))
      .toThrow('Invalid configuration: CONTACT_GRAPH_ENABLED');
    expect(() => loadConfig({ ...valid, CONTACT_GRAPH_ENABLED: 'true',
      CONTACT_GRAPH_BIN: './secret-bin', CONTACT_GRAPH_SQLITE_PATH: '/tmp/contacts.sqlite',
    } as NodeJS.ProcessEnv)).toThrow('Invalid configuration: CONTACT_GRAPH_BIN');
  });

  it('defaults the Ark request byte budget and rejects a budget below its immutable request', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv).ARK_REQUEST_MAX_BYTES).toBe(12_288);
    expect(loadConfig(valid as NodeJS.ProcessEnv).arkRequestMaxBytes).toBe(12_288);
    expect(() => loadConfig({
      ...valid,
      ARK_REQUEST_MAX_BYTES: '6143',
    } as NodeJS.ProcessEnv)).toThrow('Invalid configuration: ARK_REQUEST_MAX_BYTES');
  });

  it('passes a valid custom Ark request budget from configuration into application construction', async () => {
    arkConstruction.mockClear();
    const config = loadConfig({ ...valid, ARK_REQUEST_MAX_BYTES: '10240' } as NodeJS.ProcessEnv);
    const application = createApplication(config, { database: new DatabaseSync(':memory:') });

    expect(arkConstruction).toHaveBeenCalledWith(expect.objectContaining({
      requestMaxBytes: 10_240,
      model: config.arkModel,
    }));

    await application.close();
  });

  it('keeps exact origin URLs and derives SDK hostnames', () => {
    const config = loadConfig({
      ...valid,
      ALLOWED_ORIGINS: 'https://codex.example.cn:8443,https://other.example.cn',
    } as NodeJS.ProcessEnv);

    expect(config.allowedOriginUrls).toEqual(new Set(['https://codex.example.cn:8443', 'https://other.example.cn']));
    expect(config.allowedOriginHostnames).toEqual(new Set(['codex.example.cn', 'other.example.cn']));
  });

  it('rejects non-HTTPS upstreams without leaking values', () => {
    const env = { ...valid, ARK_API_URL: 'http://secret.invalid', PATH: '/private/bin' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow(/ARK_API_URL/);
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toBe('Error: Invalid configuration: ARK_API_URL');
    }
  });

  it('rejects missing declared secrets without exposing their values or process keys', () => {
    const env = {
      ...valid,
      QCC_API_KEY: undefined,
      PATH: '/private/qcc-secret',
      HOME: '/home/search-secret',
    } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: QCC_API_KEY');
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toBe('Error: Invalid configuration: QCC_API_KEY');
      expect(String(error)).not.toContain('qcc-secret');
      expect(String(error)).not.toContain('PATH');
      expect(String(error)).not.toContain('HOME');
    }
  });

  it('rejects non-integer or out-of-range call limits without leaking their values', () => {
    const env = { ...valid, MAX_QCC_CALLS: '0', PATH: '/private/bin' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: MAX_QCC_CALLS');
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toBe('Error: Invalid configuration: MAX_QCC_CALLS');
      expect(String(error)).not.toContain('0');
      expect(String(error)).not.toContain('PATH');
    }
  });

  it('rejects fractional call limits after numeric coercion', () => {
    const env = { ...valid, MAX_QCC_CALLS: '1.5' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: MAX_QCC_CALLS');
  });

  it('rejects a total upstream limit that cannot preserve two Ark attempts', () => {
    expect(() => loadConfig({
      ...valid,
      MAX_ARK_CALLS: '2',
      MAX_TOTAL_UPSTREAM_CALLS: '1',
    } as NodeJS.ProcessEnv)).toThrow('Invalid configuration: MAX_TOTAL_UPSTREAM_CALLS');
  });

  it('rejects a total upstream limit below the configured source budgets', () => {
    expect(() => loadConfig({
      ...valid,
      MAX_QCC_CALLS: '8',
      MAX_SEARCH_CALLS: '8',
      MAX_ARK_CALLS: '16',
      MAX_TOTAL_UPSTREAM_CALLS: '31',
    } as NodeJS.ProcessEnv)).toThrow('Invalid configuration: MAX_TOTAL_UPSTREAM_CALLS');
  });

  it('rejects origins that are not complete HTTPS origins', () => {
    const env = { ...valid, ALLOWED_ORIGINS: 'https://codex.example.cn/path' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: ALLOWED_ORIGINS');
  });

  it('rejects empty origin entries', () => {
    const env = { ...valid, ALLOWED_ORIGINS: 'https://codex.example.cn,' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: ALLOWED_ORIGINS');
  });
});
