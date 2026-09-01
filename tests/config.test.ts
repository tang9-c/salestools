import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
  it('ignores undeclared process keys before strict parsing', () => {
    expect(loadConfig({ ...valid, PATH: '/usr/bin', HOME: '/tmp/home', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv))
      .toMatchObject({ maxQccCalls: 8 });
  });

  it('applies v0.1 defaults', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject({
      maxQccCalls: 8,
      maxSearchCalls: 8,
      maxArkCalls: 2,
      arkRequestMaxBytes: 12_288,
      maxTotalUpstreamCalls: 18,
      profileCacheTtlDays: 30,
      assessmentCacheTtlDays: 30,
      maxConcurrentAssessments: 1,
    });
  });

  it('defaults the Ark request byte budget and rejects a budget below its immutable request', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv).ARK_REQUEST_MAX_BYTES).toBe(12_288);
    expect(loadConfig(valid as NodeJS.ProcessEnv).arkRequestMaxBytes).toBe(12_288);
    expect(() => loadConfig({
      ...valid,
      ARK_REQUEST_MAX_BYTES: '6143',
    } as NodeJS.ProcessEnv)).toThrow('Invalid configuration: ARK_REQUEST_MAX_BYTES');
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

  it('rejects origins that are not complete HTTPS origins', () => {
    const env = { ...valid, ALLOWED_ORIGINS: 'https://codex.example.cn/path' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: ALLOWED_ORIGINS');
  });

  it('rejects empty origin entries', () => {
    const env = { ...valid, ALLOWED_ORIGINS: 'https://codex.example.cn,' } as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow('Invalid configuration: ALLOWED_ORIGINS');
  });
});
