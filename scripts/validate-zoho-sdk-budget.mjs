import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

// Real pinned SDK transport: no SDK, got, or HTTP mocks. Only synthetic localhost data.
const sdkRoot = '@zohocrm/nodejs-sdk-8.0/lib/';
test('CRM transient failure must not exceed the two-attempt business budget', { timeout: 10_000 }, async () => {
  const [{ Initializer }, { SDKConfigBuilder }, { APIHTTPConnector }, { Logger, Levels }] = await Promise.all([
    import(sdkRoot + 'routes/initializer.js'),
    import(sdkRoot + 'routes/sdk_config_builder.js'),
    import(sdkRoot + 'routes/controllers/api_http_connector.js'),
    import(sdkRoot + 'routes/logger/logger.js'),
  ]);
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts++;
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"code":"SYNTHETIC_UNAVAILABLE"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No localhost port');
  const base = `http://127.0.0.1:${address.port}`;
  const resourcePath = await mkdtemp(join(tmpdir(), 'zoho-sdk-budget-'));
  try {
    await Initializer.initialize(
      { getUrl: () => base }, null, null,
      new SDKConfigBuilder().timeout(100).build(), resourcePath,
      Logger.getInstance(Levels.OFF, null),
    );
    const connector = new APIHTTPConnector();
    connector.setUrl(base + '/crm/v8/Accounts');
    connector.setRequestMethod('GET');
    const result = await connector.fireRequest(null);
    assert.equal(result.statusCode, 503);
    assert.ok(attempts <= 2, `Expected at most 2 HTTP attempts; actual SDK attempts: ${attempts}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(resourcePath, { recursive: true, force: true });
  }
});
