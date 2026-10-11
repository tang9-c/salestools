import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

// Executes the original UI with interpreter type erasure in memory: no bundler or build output.
// Only the external host SDK and HTTP boundary are adapted; DOM, callbacks and fetch are real Chromium.
let browser: Browser;
let html: string;
let source: string;
let sdkTransport: string;
const pages: Page[] = [];
const origin = 'http://upload.test';
const attack = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
const person = (id = 'p_1', overrides: Record<string, unknown> = {}) => ({
  candidate_id: id, label: 'Person', properties: { name: '张敏', telephone: ['13800138000'], email: [] },
  extensions: { hobbies: [], instantMessaging: [] }, can_commit: true, warnings: [],
  evidence: [{ evidence_id: `e_${id}`, subject_kind: 'entity', subject_id: id,
    field_path: 'properties.name', value: '张敏', source_type: 'file', file_name: 'card.pdf',
    file_sha256: 'a'.repeat(64), quote: '张敏 产品经理', page: 1, locator_status: 'located',
    collected_at: '2026-09-29T00:00:00.000Z' }], relation_suggestions: [], review_items: [], ...overrides,
});
const preview = (overrides: Record<string, unknown> = {}) => ({
  import_id: 'ci_browser', status: 'ready_for_review', version: 3, source: { file_name: 'card.pdf' },
  total_candidates: 1, candidates: [person()], warnings: [], match_suggestions: [],
  match_suggestions_truncated: false, processed_block_ids: ['b_1'], unprocessed_block_ids: [],
  coverage_available: true, confirmation: { allowed: true, reasons: [] },
  offset: 0, limit: 50, ...overrides,
});
type Harness = { page: Page; ui: Page | Frame; commits: unknown[]; logs: string[]; requests: Array<{ path: string; method: string; auth?: string; cookie?: string; origin?: string; sessionId?: string }> };
type Options = { app?: boolean; realSdk?: boolean; holdSession?: boolean; bundle?: boolean; data?: ReturnType<typeof preview>;
  context?: BrowserContext; externalSessionId?: string;
  response?: (route: Route, h: Harness) => Promise<boolean> };
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
}
async function open(options: Options = {}): Promise<Harness> {
  const page = options.context ? await options.context.newPage() : await browser.newPage(); pages.push(page);
  if (!options.app) await page.addInitScript(id => {
    if (!sessionStorage.getItem('contact-upload-session')) sessionStorage.setItem('contact-upload-session', id);
  }, options.externalSessionId ?? 'a'.repeat(43));
  await page.context().addCookies([{ name: 'test-upload-cookie', value: 'restricted_cookie', url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const h: Harness = { page, ui: page, commits: [], requests: [], logs: [] };
  page.on('pageerror', error => h.logs.push(error.message));
  page.on('console', async message => { h.logs.push(JSON.stringify(await Promise.all(message.args().map(arg => arg.jsonValue().catch(() => '[unavailable]'))))); });
  if (options.realSdk) await page.addInitScript(({ origin, holdSession }) => {
    if (window.parent !== window) return;
    const host = window as unknown as { testHostPackets: unknown[]; testHostSessionPending?: boolean; releaseTestHostSession?: () => void };
    host.testHostPackets = [];
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector<HTMLIFrameElement>('iframe')?.contentWindow) return;
      const target = event.source as Window;
      const packet = event.data; host.testHostPackets.push(packet);
      if (packet?.method === 'ui/initialize') target.postMessage({ jsonrpc: '2.0', id: packet.id,
        result: { protocolVersion: '2026-01-26', hostInfo: { name: 'browser-test-host', version: '1' },
          hostCapabilities: { serverTools: {} }, hostContext: {} } }, '*');
      if (packet?.method === 'tools/call') {
        const respond = () => target.postMessage({ jsonrpc: '2.0', id: packet.id, result: {
          content: [{ type: 'text', text: 'session created' }],
          structuredContent: { sessionId: 'restricted_session', bearer: 'restricted_secret', base_url: origin },
        } }, '*');
        if (holdSession) { host.testHostSessionPending = true; host.releaseTestHostSession = respond; }
        else respond();
      }
    });
  }, { origin, holdSession: options.holdSession ?? false });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.isNavigationRequest()) {
      if (options.bundle) {
        // CI must use the real artifact, not the interpreter adapter above.
        const artifact = await readFile('web/dist/contact-upload.html', 'utf8');
        const script = /<script>([\s\S]*?)<\/script>/u.exec(artifact)?.[1];
        if (!script) throw new Error('Built upload page has no inline script');
        const hash = createHash('sha256').update(script).digest('base64');
        await route.fulfill({ contentType: 'text/html', body: artifact, headers: {
          'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
        } }); return;
      }
      if (options.realSdk && request.frame() === page.mainFrame()) {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe name="upload-app" src="/embedded-ui" style="width:100%;height:1000px"></iframe>' }); return;
      }
      const imports = {
        '@modelcontextprotocol/client': '/test-deps/@modelcontextprotocol/client/dist/index.mjs',
        '@modelcontextprotocol/client/_shims': '/test-deps/@modelcontextprotocol/client/dist/shimsBrowser.mjs',
        '@modelcontextprotocol/core': '/test-deps/@modelcontextprotocol/core/dist/index.mjs',
        '@modelcontextprotocol/core/internal': '/test-deps/@modelcontextprotocol/core/dist/internal.mjs',
        'zod/v4': '/test-deps/zod/v4/index.js',
        'pkce-challenge': '/test-deps/pkce-challenge/dist/index.browser.js',
        'eventsource': '/test-deps/eventsource/dist/index.js',
        'eventsource-parser': '/test-deps/eventsource-parser/dist/index.js',
        'eventsource-parser/stream': '/test-deps/eventsource-parser/dist/stream.js',
      };
      await route.fulfill({ contentType: 'text/html', body: options.realSdk
        ? html.replace('<script type="module"', `<script type="importmap">${JSON.stringify({ imports })}</script><script type="module"`) : html }); return;
    }
    if (url.pathname === '/test-ui.js') {
      await route.fulfill({ contentType: 'text/javascript', body: options.realSdk
        ? source.replace("'/test-sdk.js'", "'/test-deps/@modelcontextprotocol/ext-apps/dist/src/app.js'")
          .replace("'/test-client.js'", "'@modelcontextprotocol/client'") : source }); return;
    }
    if (url.pathname.startsWith('/test-deps/')) {
      const root = resolve('node_modules'); const file = resolve(root, url.pathname.slice('/test-deps/'.length));
      if (!file.startsWith(root + '/') || !/\.(mjs|js)$/u.test(file)) throw new Error('Invalid real SDK dependency route');
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(file, 'utf8') }); return;
    }
    if (url.pathname === '/test-default-transport.js') { await route.fulfill({ contentType: 'text/javascript', body: sdkTransport }); return; }
    if (url.pathname === '/test-client.js') {
      await route.fulfill({ contentType: 'text/javascript', body: `import { JSONRPCMessageSchema } from '/test-core/index.mjs';
        export const parseJSONRPCMessage = value => JSONRPCMessageSchema.parse(value);` }); return;
    }
    // Serve installed schema dependency modules directly; no module is bundled or built.
    if (url.pathname.startsWith('/test-core/') || url.pathname.startsWith('/test-zod/')) {
      const prefix = url.pathname.startsWith('/test-core/') ? '/test-core/' : '/test-zod/';
      const root = resolve(prefix === '/test-core/' ? 'node_modules/@modelcontextprotocol/core/dist' : 'node_modules/zod');
      const file = resolve(root, url.pathname.slice(prefix.length));
      if (!file.startsWith(root + '/') || !/\.(mjs|js)$/u.test(file)) throw new Error('Invalid test dependency route');
      const module = (await readFile(file, 'utf8')).replaceAll('"zod/v4"', '"/test-zod/v4/index.js"');
      await route.fulfill({ contentType: 'text/javascript', body: module }); return;
    }
    if (url.pathname === '/test-sdk.js') {
      await route.fulfill({ contentType: 'text/javascript', body: `import { PostMessageTransport } from '/test-default-transport.js';
      export class App {
        constructor() { window.testApp = this; this.pending = new Map(); this.nextId = 0; }
        removeRequestHandler() {}
        setRequestHandler() {}
        async connect(transport) {
          this.transport = transport ?? new PostMessageTransport(window.parent, window.parent);
          this.transport.onclose = () => this.onclose?.();
          this.transport.onerror = error => { window.testTransportError = error.message; };
          this.transport.onmessage = message => {
            if ('result' in message) this.pending.get(message.id)?.(message.result);
            else if (message.method === 'ui/notifications/tool-result') window.testReceivedResult = message.params;
          };
          window.addEventListener('message', event => {
            if (event.source !== window || !event.data?.method || !('id' in event.data)) return;
            const result = event.data.method === 'ui/initialize'
              ? { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: {} }
              : { structuredContent: { sessionId: 'restricted_session', bearer: 'restricted_secret', base_url: '${origin}' } };
            window.postMessage({ jsonrpc: '2.0', id: event.data.id, result }, '*');
          });
          await this.transport.start(); await this.rpc('ui/initialize', {});
        }
        rpc(method, params) { return new Promise(resolve => { const id = ++this.nextId; this.pending.set(id, resolve); void this.transport.send({ jsonrpc: '2.0', id, method, params }); }); }
        async close() { await this.transport.close(); }
        async callServerTool(params) { return await this.rpc('tools/call', params); }
      }` }); return;
    }
    h.requests.push({ path: url.pathname + url.search, method: request.method(), auth: request.headers().authorization,
      cookie: request.headers().cookie, origin: request.headers().origin, sessionId: request.headers()['x-upload-session'] });
    if (url.pathname === '/contact-upload/commit') h.commits.push(request.postDataJSON());
    if (await options.response?.(route, h)) return;
    if (url.pathname === '/contact-files') { await json(route, { file_id: 'f_1' }); return; }
    if (url.pathname === '/contact-upload/exit') { await json(route, { ok: true }); return; }
    if (url.pathname === '/contact-upload/exchange') { await json(route, { ok: true, session_id: 'b'.repeat(43) }); return; }
    if (url.pathname === '/contact-upload/commit') { await json(route, { import_id: 'ci_browser', status: 'committed', version: 4 }); return; }
    if (url.pathname === '/contact-upload/import') {
      await json(route, request.method() === 'POST' ? { import_id: 'ci_browser' } : options.data ?? preview()); return;
    }
    await json(route, { code: 'UNEXPECTED_TEST_ROUTE' }, 404);
  });
  await page.goto(origin + (options.app ? '/embedded' : '/contact-upload'));
  if (options.realSdk) h.ui = page.frame({ name: 'upload-app' })!;
  if (options.holdSession) {
    await expect.poll(() => page.evaluate(() => (window as unknown as { testHostSessionPending?: boolean }).testHostSessionPending), { timeout: 2500 }).toBe(true);
    return h;
  }
  await expect.poll(() => h.ui.locator('#status').textContent(), { timeout: 2500 }).not.toBe('正在建立上传会话…');
  if (!options.app) await expect.poll(() => page.locator('#review').isVisible()).toBe(true);
  return h;
}
async function body(page: Page | Frame) { return await page.locator('body').innerText(); }
async function upload(page: Page | Frame, input = '#file', name = 'card.pdf') {
  await page.locator(input).setInputFiles({ name, mimeType: input === '#camera' ? 'image/jpeg' : 'application/pdf', buffer: Buffer.from('test file') });
}
async function ready(page: Page | Frame) { await expect.poll(() => page.locator('#commit').isEnabled()).toBe(true); }

beforeAll(async () => {
  html = (await readFile(new URL('../web/contact-upload.html', import.meta.url), 'utf8'))
    .replace('<!--SCRIPT-->', '<script type="module" src="/test-ui.js"></script>');
  const uiSource: string = process.env.CONTACT_UPLOAD_UI_BASELINE
    ? (JSON.parse(await readFile(process.env.CONTACT_UPLOAD_UI_BASELINE, 'utf8')) as Record<string, string>)['web/contact-upload.ts']
    : await readFile(new URL('../web/contact-upload.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(uiSource)
    .replace("'@modelcontextprotocol/ext-apps'", "'/test-sdk.js'")
    .replace("'@modelcontextprotocol/client'", "'/test-client.js'");
  const distribution = await readFile('node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js', 'utf8');
  const start = distribution.indexOf('class j{eventTarget;');
  const end = distribution.indexOf('import{z as Q}', start);
  if (start < 0 || end < 0) throw new Error('Installed SDK transport changed; update adapter from its actual transport');
  sdkTransport = `import { JSONRPCMessageSchema as LQ } from '/test-core/index.mjs';\nconst q = 'ui/notifications/tool-input-partial';\n${distribution.slice(start, end)}\nexport { j as PostMessageTransport };`;
  const cached = '/Users/tang-codeing/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CONTACT_UPLOAD_CHROMIUM ?? (existsSync(cached) ? cached : undefined) });
});
afterEach(async () => { await Promise.all(pages.splice(0).map(page => page.close())); });
afterAll(async () => { await browser?.close(); });

it.runIf(process.env.CONTACT_UPLOAD_BUNDLE_REQUIRED === '1')('starts the actual CI-built upload page under its script CSP and loads the preview', async () => {
  const h = await open({ bundle: true });
  expect(await h.page.locator('body').getAttribute('data-state')).toBe('review');
  expect(await h.page.locator('#commit').isEnabled()).toBe(true);
  expect(await h.page.locator('#status').count()).toBe(1);
  expect(h.requests.some(request => request.path === '/contact-upload/import' && request.method === 'POST')).toBe(true);
  expect(h.requests.some(request => request.path === '/contact-upload/import' && request.method === 'GET')).toBe(true);
  expect(h.logs).toEqual([]);
});

it('shows the file/model/shared-library disclosure before the user selects a file', async () => {
  const { page } = await open({ app: true });
  const text = await body(page);
  expect(text).toContain('原始文件'); expect(text).toContain('临时');
  expect(text).toContain('提取的文字'); expect(text).toContain('模型'); expect(text).toContain('共享联系人库');
});

it('shows warnings, evidence, review fields, matching details and coverage literally without running HTML', async () => {
  const data = preview({ source: { file_name: attack }, warnings: [attack, '任务警告二'],
    processed_block_ids: ['b_1', 'b_2'], unprocessed_block_ids: ['b_3'],
    candidates: [person('p_1', { properties: { name: attack, description: '正常描述' }, warnings: ['候选警告'],
      evidence: [{ ...person().evidence[0], file_name: attack, quote: attack }],
      review_items: [{ kind: 'field', field_path: 'properties.jobTitle', value: attack, reason: 'missing_evidence', quote: '需核对的文字', page: 2 }] })],
    confirmation: { allowed: false, reasons: ['存在可能重复的联系人，请在聊天中比较资料。'] },
    match_suggestions: [{ entityId: 'existing_1', candidateId: 'p_1', candidateName: attack,
      existingName: attack, reasons: [{ kind: 'self_phone', value: attack }], existingUpdatedAt: '2026-09-20T00:00:00.000Z',
      candidateSources: [{ sourceType: 'file', collectedAt: '2026-09-29T00:00:00.000Z', fileName: attack }], existingSources: [] }] });
  const { page } = await open({ data });
  const text = await body(page);
  expect(text).toContain('任务警告二'); expect(text).toContain('已处理 2'); expect(text).toContain('未处理 1');
  expect(text).toContain('需核对的文字'); expect(text).toContain('existing_1');
  expect(text).toContain(attack); expect(text).not.toContain('"candidate_id"');
  expect(await page.locator('#commit').isEnabled()).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
  expect(await page.locator('#review img, #review script').count()).toBe(0);
});

it.each([
  ['多个主体', { total_candidates: 2, candidates: [person(), person('p_2')] }],
  ['没有主体', { total_candidates: 0, candidates: [] }],
  ['不可入库主体', { candidates: [person('p_1', { can_commit: false })] }],
  ['没有可定位主体证据', { candidates: [person('p_1', { evidence: [{ ...person().evidence[0], locator_status: 'unavailable' }] })] }],
  ['非主体人物', { candidates: [person('p_1', { warnings: ['非主体人物线索'] })] }],
  ['可能重复', { match_suggestions: [{ entityId: 'existing_1', candidateId: 'p_1', reasons: [] }] }],
  ['匹配截断', { match_suggestions_truncated: true }],
  ['匹配查询失败', { warnings: ['身份匹配查询失败，请人工核对已有联系人'] }],
  ['任务失败', { status: 'failed' }],
  ['未处理文本块', { unprocessed_block_ids: ['b_2'] }],
  ['覆盖不可用', { coverage_available: false }],
  ['缺少覆盖可用标志', { coverage_available: undefined }],
])('disables confirmation for %s and retains the import number', async (_name, data) => {
  const { page } = await open({ data: preview({ ...data, confirmation: { allowed: false, reasons: [_name] } }) });
  expect(await page.locator('#commit').isEnabled()).toBe(false);
  expect(await body(page)).toContain('ci_browser');
});

it.each([undefined, { allowed: false, reasons: ['预览不完整，请在聊天中核对。'] }])(
  'requires the explicit server allowance and shows its reasons', async confirmation => {
    const { page } = await open({ data: preview({ confirmation }) });
    expect(await page.locator('#commit').isEnabled()).toBe(false);
    expect(await body(page)).toContain('ci_browser');
    if (confirmation) expect(await body(page)).toContain(confirmation.reasons[0]);
  });

it('displays every candidate from the complete server preview before enabling confirmation', async () => {
  const orgs = Array.from({ length: 50 }, (_, i) => ({ candidate_id: `org_${i}`, label: 'Organization',
    properties: { name: i === 49 ? '尾页公司' : `公司 ${i}` }, can_commit: true,
    warnings: [], evidence: [], relation_suggestions: [], review_items: [] }));
  const h = await open({ data: preview({ total_candidates: 51, candidates: [person(), ...orgs] }) });
  await ready(h.page); expect(await body(h.page)).toContain('尾页公司');
  expect(await h.page.locator('#preview .item').count()).toBe(51);
  expect(h.requests.filter(request => request.method === 'GET' && request.path.includes('/contact-upload/import'))).toHaveLength(1);
});

it('refreshes the full preview after a version conflict and requires a new explicit click', async () => {
  let current = 3;
  const h = await open({ response: async route => {
    const request = route.request();
    if (new URL(request.url()).pathname === '/contact-upload/commit' && current === 3) {
      current = 4; await json(route, { code: 'PREVIEW_VERSION_CHANGED' }, 409); return true;
    }
    if (request.method() === 'GET') { await json(route, preview({ version: current, candidates: [person('p_1', { properties: { name: current === 4 ? '新版本张敏' : '旧版本张敏' } })] })); return true; }
    return false;
  } });
  await ready(h.page); await h.page.locator('#commit').click();
  await expect.poll(() => body(h.page)).toContain('新版本张敏');
  expect(h.commits).toEqual([{ preview_version: 3 }]);
  await ready(h.page); expect(await body(h.page)).toContain('重新核对');
  await h.page.locator('#commit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('导入完成');
  expect(h.commits).toEqual([{ preview_version: 3 }, { preview_version: 4 }]);
  expect(await body(h.page)).toContain('ci_browser');
});

it.each([false, true])('allows only a manual same-version receipt retry after a lost successful response (App=%s)', async app => {
  const h = await open({ app, response: async (route, h) => {
    if (new URL(route.request().url()).pathname === '/contact-upload/commit' && h.commits.length === 1) {
      await route.abort('connectionfailed'); return true;
    } return false;
  } });
  if (app) await upload(h.page);
  await ready(h.page); await h.page.locator('#commit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('回执');
  expect(h.commits).toEqual([{ preview_version: 3 }]);
  expect(await h.page.locator('#commit').isEnabled()).toBe(false);
  expect(await h.page.locator('#retry').isVisible()).toBe(true);
  await h.page.locator('#retry').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('导入完成');
  expect(h.commits).toEqual([{ preview_version: 3 }, { preview_version: 3 }]);
  const confirmations = h.requests.filter(r => r.path === '/contact-upload/commit');
  expect(confirmations[1]?.auth).toBe(app ? 'Bearer restricted_session.restricted_secret' : undefined);
  expect(confirmations[1]?.cookie).toBe(app ? undefined : 'test-upload-cookie=restricted_cookie');
  expect(h.requests.filter(r => r.method === 'POST' && r.path === '/contact-upload/import')).toHaveLength(1);
  expect(await body(h.page)).toContain('ci_browser');
});

it.each(['#file', '#camera'])('uploads a selected file through %s and shows literal file name', async input => {
  const h = await open({ app: true }); await upload(h.page, input, attack + '.pdf'); await ready(h.page);
  expect(await body(h.page)).toContain(attack + '.pdf');
  expect(await h.page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
  expect(h.requests.find(r => r.path === '/contact-files')?.auth).toBe('Bearer restricted_session.restricted_secret');
  expect(h.requests.find(r => r.path === '/contact-files')?.cookie).toBeUndefined();
});

it('handles unsupported files with safe selection retry and capacity with a reopen instruction', async () => {
  let uploads = 0;
  const h = await open({ app: true, response: async route => {
    if (new URL(route.request().url()).pathname === '/contact-files') {
      uploads++; await json(route, { code: uploads === 1 ? 'UNSUPPORTED_FILE' : 'TEMP_CAPACITY_FULL' }, uploads === 1 ? 415 : 429); return true;
    } return false;
  } });
  await upload(h.page);
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('PDF');
  expect(await h.page.locator('#file').isEnabled()).toBe(true);
  expect(h.requests.filter(r => r.path === '/contact-upload/import')).toHaveLength(0);
  await upload(h.page);
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('容量');
  expect(await h.page.locator('#file').isEnabled()).toBe(true);
});

it('shows session capacity without calling it expired and preserves the handoff until successful exchange', async () => {
  let full = true;
  const h = await open({ response: async route => {
    if (new URL(route.request().url()).pathname !== '/contact-upload/exchange') return false;
    await json(route, full ? { code: 'UPLOAD_SESSION_CAPACITY' } : { ok: true, session_id: 'b'.repeat(43) }, full ? 429 : 200);
    return true;
  } });
  await h.page.goto(origin + '/contact-upload#code=capacity_test_code');
  await h.page.reload();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('服务上传会话容量暂时已满');
  expect(await h.page.locator('#status').textContent()).not.toContain('其他上传页面');
  expect(await h.page.locator('#status').textContent()).not.toContain('已失效');
  expect(await h.page.locator('#file').isEnabled()).toBe(false);
  expect(new URL(h.page.url()).hash).toBe('#code=capacity_test_code');
  full = false;
  await h.page.reload();
  await expect.poll(() => h.page.locator('#review').isVisible()).toBe(true);
  expect(new URL(h.page.url()).hash).toBe('');
});

it('selects the exchanged external session on every request and retains only its non-secret id on reload', async () => {
  const h = await open();
  await h.page.goto(origin + '/contact-upload#code=fresh_page_code');
  await h.page.reload();
  await expect.poll(() => h.page.locator('#review').isVisible()).toBe(true);
  expect(new URL(h.page.url()).hash).toBe('');
  expect(await h.page.evaluate(() => sessionStorage.getItem('contact-upload-session'))).toBe('b'.repeat(43));
  await h.page.reload();
  await ready(h.page);
  const requests = h.requests.filter(r => r.path === '/contact-upload/import').slice(-2);
  expect(requests.map(r => r.sessionId)).toEqual(['b'.repeat(43), 'b'.repeat(43)]);
  expect(requests.every(r => r.auth === undefined)).toBe(true);
  await h.page.locator('#exit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('已退出');
  expect(h.requests.find(r => r.path === '/contact-upload/exit')?.sessionId).toBe('b'.repeat(43));
  expect(await h.page.evaluate(() => sessionStorage.getItem('contact-upload-session'))).toBeNull();
  expect(await h.page.evaluate(() => localStorage.length)).toBe(0);
});

it('keeps two external tabs in one browser context on their own session selectors', async () => {
  const context = await browser.newContext();
  try {
    const a = await open({ context });
    const b = await open({ context, externalSessionId: 'c'.repeat(43) });
    await a.page.reload();
    await ready(a.page);
    expect(a.requests.filter(r => r.path === '/contact-upload/import').slice(-2).map(r => r.sessionId))
      .toEqual(['a'.repeat(43), 'a'.repeat(43)]);
    expect(b.requests.filter(r => r.path === '/contact-upload/import').map(r => r.sessionId))
      .toEqual(['c'.repeat(43), 'c'.repeat(43)]);
    await a.page.locator('#exit').click();
    await expect.poll(() => a.page.locator('#status').textContent()).toContain('已退出');
    await b.page.reload();
    await ready(b.page);
    expect(await b.page.evaluate(() => sessionStorage.getItem('contact-upload-session'))).toBe('c'.repeat(43));
    expect(b.requests.filter(r => r.path === '/contact-upload/import').slice(-2).map(r => r.sessionId))
      .toEqual(['c'.repeat(43), 'c'.repeat(43)]);
  } finally { await context.close(); }
});

it('keeps an import number when extraction fails and can safely retry preview reads', async () => {
  let fail = true;
  const h = await open({ app: true, response: async route => {
    if (route.request().method() === 'GET' && fail) { fail = false; await route.abort('connectionfailed'); return true; }
    return false;
  } });
  await upload(h.page);
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('连接');
  expect(await body(h.page)).toContain('ci_browser');
  expect(await h.page.locator('#retry').isVisible()).toBe(true);
  await h.page.locator('#retry').click(); await ready(h.page);
  expect(h.requests.filter(r => r.method === 'POST' && r.path === '/contact-upload/import')).toHaveLength(1);
});

it('clears App credentials and disables actions on host disconnect without promising refresh recovery', async () => {
  const h = await open({ app: true }); await upload(h.page); await ready(h.page);
  await h.page.evaluate(() => (window as unknown as { testApp: { onclose?: () => void } }).testApp.onclose?.());
  const text = await body(h.page);
  expect(text).toContain('连接'); expect(text).toContain('ci_browser'); expect(text).toContain('重新打开');
  expect(await h.page.locator('#commit').isEnabled()).toBe(false);
  expect(await h.page.locator('#file').isEnabled()).toBe(false);
  expect(await h.page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  const prior = h.requests.length; await h.page.locator('#commit').dispatchEvent('click');
  expect(h.requests).toHaveLength(prior);
});

it('resumes an external Cookie task on reload, while an App reload explains it creates a fresh entry', async () => {
  const external = await open(); await ready(external.page);
  await external.page.reload(); await ready(external.page);
  expect(external.requests.filter(r => r.method === 'POST' && r.path === '/contact-upload/import')).toHaveLength(2);
  expect(external.requests.find(r => r.path === '/contact-upload/import')?.cookie).toContain('test-upload-cookie=restricted_cookie');
  const embedded = await open({ app: true });
  expect(await body(embedded.page)).toContain('新会话'); expect(await body(embedded.page)).toContain('聊天');
  expect(embedded.requests.filter(r => r.path === '/contact-upload/import')).toHaveLength(0);
  await upload(embedded.page); await ready(embedded.page);
  const count = embedded.requests.filter(r => r.path.startsWith('/contact-upload/import')).length;
  await embedded.page.reload();
  await expect.poll(() => embedded.page.locator('#file').isEnabled()).toBe(true);
  expect(await embedded.page.locator('#review').isVisible()).toBe(false);
  expect(await body(embedded.page)).toContain('无法恢复原会话');
  expect(embedded.requests.filter(r => r.path.startsWith('/contact-upload/import'))).toHaveLength(count);
});

it('shows expired or revoked sessions as a disabled fresh-entry recovery with retained import number', async () => {
  const h = await open({ response: async route => {
    if (new URL(route.request().url()).pathname === '/contact-upload/commit') {
      await json(route, { code: 'UPLOAD_SESSION_UNAUTHORIZED' }, 401); return true;
    } return false;
  } });
  await ready(h.page); await h.page.locator('#commit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('失效');
  expect(await body(h.page)).toContain('ci_browser'); expect(await body(h.page)).toContain('重新打开');
  expect(await h.page.locator('#file').isEnabled()).toBe(false);
  expect(await h.page.locator('#commit').isEnabled()).toBe(false);
});

it('exits using the authorized endpoint and prevents in-flight preview from restoring controls', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  const h = await open({ app: true, response: async route => {
    if (route.request().method() === 'GET') { waiting = true; await gate; await json(route, preview()); return true; }
    return false;
  } });
  await upload(h.page); await expect.poll(() => waiting).toBe(true);
  expect(await h.page.locator('#exit').count()).toBe(1);
  await h.page.locator('#exit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('退出');
  release(); await h.page.waitForTimeout(50);
  expect(h.requests.find(r => r.path === '/contact-upload/exit')?.auth).toBe('Bearer restricted_session.restricted_secret');
  expect(h.requests.find(r => r.path === '/contact-upload/exit')?.cookie).toBeUndefined();
  expect(await h.page.locator('#commit').isEnabled()).toBe(false);
  expect(await h.page.locator('#file').isEnabled()).toBe(false);
  expect(await h.page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

it('keeps host credentials, tool inputs and preview values out of browser logs while validating transport messages', async () => {
  const h = await open({ app: true });
  await upload(h.page); await ready(h.page);
  await h.page.evaluate(() => window.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result',
    params: { content: [{ type: 'text', text: 'private model/OCR preview' }] } }, '*'));
  await h.page.waitForTimeout(30);
  expect(h.logs.join('\n')).not.toContain('restricted_secret');
  expect(h.logs.join('\n')).not.toContain('create_contact_upload_session');
  expect(h.logs.join('\n')).not.toContain('private model/OCR preview');
  expect(await h.page.evaluate(() => (window as unknown as { testReceivedResult?: unknown }).testReceivedResult)).toEqual({ content: [{ type: 'text', text: 'private model/OCR preview' }] });
  await h.page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    source: null, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [] } },
  })));
  expect(await h.page.evaluate(() => (window as unknown as { testReceivedResult?: unknown }).testReceivedResult)).toEqual({ content: [{ type: 'text', text: 'private model/OCR preview' }] });
  await h.page.evaluate(() => window.postMessage({ jsonrpc: '2.0', id: { secret: 'malformed_private_value' }, result: {} }, '*'));
  await h.page.waitForTimeout(30);
  expect(await h.page.evaluate(() => (window as unknown as { testTransportError?: string }).testTransportError)).toBe('Invalid host message');
  expect(h.logs.join('\n')).not.toContain('malformed_private_value');
});

it('recovers an ambiguous upload without sending a second file and shows each task state', async () => {
  let releaseUpload!: () => void; let releaseStart!: () => void;
  const uploaded = new Promise<void>(resolve => { releaseUpload = resolve; });
  const extracting = new Promise<void>(resolve => { releaseStart = resolve; });
  const h = await open({ app: true, response: async route => {
    const request = route.request();
    if (new URL(request.url()).pathname === '/contact-files') { await uploaded; await route.abort('connectionfailed'); return true; }
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/contact-upload/import') {
      await extracting; await json(route, { import_id: 'ci_browser' }); return true;
    } return false;
  } });
  expect(await h.page.locator('body').getAttribute('data-state')).toBe('waiting');
  await h.page.setViewportSize({ width: 390, height: 844 });
  expect(await h.page.locator('#camera').getAttribute('capture')).toBe('environment');
  await upload(h.page, '#camera', 'camera.jpg');
  await expect.poll(() => h.page.locator('body').getAttribute('data-state')).toBe('uploading');
  releaseUpload();
  await expect.poll(() => h.page.locator('body').getAttribute('data-state')).toBe('failed');
  expect(await h.page.locator('#file').isEnabled()).toBe(false);
  await h.page.locator('#retry').click();
  await expect.poll(() => h.page.locator('body').getAttribute('data-state')).toBe('extracting');
  releaseStart(); await ready(h.page);
  expect(await h.page.locator('body').getAttribute('data-state')).toBe('review');
  expect(h.requests.filter(r => r.path === '/contact-files')).toHaveLength(1);
  await h.page.locator('#commit').click();
  await expect.poll(() => h.page.locator('body').getAttribute('data-state')).toBe('committed');
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

it('exits a Cookie task with its exact browser origin and prevents further interaction', async () => {
  const h = await open(); await ready(h.page);
  await h.page.locator('#exit').click();
  await expect.poll(() => h.page.locator('#status').textContent()).toContain('已退出');
  const request = h.requests.find(r => r.path === '/contact-upload/exit');
  expect(request?.cookie).toContain('test-upload-cookie=restricted_cookie');
  expect(request?.auth).toBeUndefined(); expect(request?.origin).toBe('http://upload.test');
  const count = h.requests.length;
  await h.page.locator('#commit').dispatchEvent('click');
  await h.page.locator('#retry').dispatchEvent('click');
  expect(h.requests).toHaveLength(count);
});

it('keeps an unnamed supported subject confirmable when its institution relationship has located direct evidence', async () => {
  const { page } = await open({ data: preview({ candidates: [person('p_1', {
    properties: { telephone: ['13800138000'] }, evidence: [], relation_suggestions: [{
      source_candidate_id: 'p_1', target_candidate_id: 'org_1', relation_type: 'worksFor', properties: {}, uncertain: false,
      evidence: [{ ...person().evidence[0], subject_kind: 'relation', subject_id: 'r_1', field_path: '$relation',
        value: { source_id: 'p_1', target_id: 'org_1', relation_type: 'worksFor' }, quote: '本人就职于测试公司' }],
    }],
  })] }) });
  await ready(page); expect(await body(page)).toContain('本人就职于测试公司');
});

async function hostRequest(page: Page, id: string, method: string, params: unknown = {}) {
  await page.evaluate(({ id, method, params }) => document.querySelector<HTMLIFrameElement>('iframe')!.contentWindow!
    .postMessage({ jsonrpc: '2.0', id, method, params }, '*'), { id, method, params });
}
async function hostResult(page: Page, id: string) {
  return await page.evaluate(id => (window as unknown as {
    testHostPackets: Array<{ id?: string; result?: unknown }>;
  }).testHostPackets.find(packet => packet.id === id && 'result' in packet)?.result, id);
}

it('acknowledges actual SDK host teardown while revoking and discarding an in-flight preview', async () => {
  let releasePreview!: () => void; let releaseExit!: () => void;
  const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
  const exitGate = new Promise<void>(resolve => { releaseExit = resolve; });
  let waiting = false;
  const h = await open({ app: true, realSdk: true, response: async route => {
    if (route.request().method() === 'GET') { waiting = true; await previewGate; await json(route, preview()); return true; }
    if (new URL(route.request().url()).pathname === '/contact-upload/exit') { await exitGate; await json(route, { ok: true }); return true; }
    return false;
  } });
  try {
    await upload(h.ui); await expect.poll(() => waiting).toBe(true);
    await hostRequest(h.page, 'host-teardown-preview', 'ui/resource-teardown');
    await expect.poll(() => hostResult(h.page, 'host-teardown-preview')).toEqual({});
    expect(await h.ui.locator('#file').isEnabled()).toBe(false);
    expect(await h.ui.locator('#commit').isEnabled()).toBe(false);
    await expect.poll(() => h.requests.filter(request => request.path === '/contact-upload/exit').length).toBe(1);
    expect(h.requests.find(request => request.path === '/contact-upload/exit')?.auth).toBe('Bearer restricted_session.restricted_secret');
    const returned = h.page.waitForResponse(response => new URL(response.url()).pathname === '/contact-upload/import' && response.request().method() === 'GET');
    releasePreview(); await (await returned).finished();
    await h.ui.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await h.ui.locator('#commit').isEnabled()).toBe(false);
    expect(await h.ui.locator('#review').isVisible()).toBe(false);
    const count = h.requests.length;
    await h.ui.locator('#commit').dispatchEvent('click'); await h.ui.locator('#retry').dispatchEvent('click');
    expect(h.requests).toHaveLength(count);
  } finally { releasePreview(); releaseExit(); }
});

it('acknowledges actual SDK teardown during session-tool response and never revives the late credential', async () => {
  const h = await open({ app: true, realSdk: true, holdSession: true });
  await hostRequest(h.page, 'host-teardown-tool', 'ui/resource-teardown');
  await expect.poll(() => hostResult(h.page, 'host-teardown-tool')).toEqual({});
  await h.page.evaluate(() => (window as unknown as { releaseTestHostSession?: () => void }).releaseTestHostSession?.());
  await expect.poll(() => h.requests.filter(request => request.path === '/contact-upload/exit').length).toBe(1);
  expect(h.requests.find(request => request.path === '/contact-upload/exit')?.auth).toBe('Bearer restricted_session.restricted_secret');
  expect(await h.ui.locator('#file').isEnabled()).toBe(false);
  expect(await h.ui.locator('#commit').isEnabled()).toBe(false);
  expect(await h.ui.locator('#exit').isEnabled()).toBe(false);
  expect(h.requests.some(request => request.path === '/contact-files' || request.path.startsWith('/contact-upload/import'))).toBe(false);
  expect(h.logs.join('\n')).not.toContain('restricted_secret');
});

it('responds to actual SDK ping with private metadata without logging the host payload', async () => {
  const h = await open({ app: true, realSdk: true });
  await hostRequest(h.page, 'host-private-ping', 'ping', { _meta: { private_value: 'synthetic_private_ping_payload' } });
  await expect.poll(() => hostResult(h.page, 'host-private-ping')).toEqual({});
  await h.page.waitForTimeout(30);
  expect(h.logs.join('\n')).not.toContain('synthetic_private_ping_payload');
  expect(await h.ui.locator('#file').isEnabled()).toBe(true);
});
