import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

let browser: Browser;
const pages: Page[] = [];
const root = { items: [{ entity_id: 'o1', label: 'Organization', name: '云杉智造' }],
  total: 1, mode_used: 'keyword', warnings: [] };
const edge = (id: number) => ({ relation_id: `r${id}`, source_id: `p${id}`, target_id: 'o1',
  relation_type: 'worksFor', properties: { role: { roleName: '工程师' } }, metadata: { employment_status: 'unknown' } });
const detail = (id: string, relations: unknown[] = [], next: number | null = null, claims: unknown[] = []) => ({
  entity: { entity_id: id, label: id === 'o1' ? 'Organization' : 'Person',
    properties: { name: id === 'o1' ? '云杉智造' : `人物${id}`, jobTitle: '工程师', telephone: ['secret-phone'] } },
  relations, unverified_claims: claims, evidence: [], conflicts: [], pagination: {
    relations: { offset: 0, total: relations.length, next_offset: next },
    evidence: { offset: 0, total: 0, next_offset: null as number | null },
    unverified_claims: { offset: 0, total: claims.length, next_offset: null as number | null },
  },
});
type Call = { name: string; arguments: Record<string, unknown> };
type Host = { notify: (method: string, params: unknown) => void; barrier: () => Promise<void> };
const result = (data: unknown) => ({ content: [], structuredContent: data });
async function open(reply: (call: Call) => Promise<unknown> | unknown, input: Record<string, unknown> | null = {}, data: typeof root & { next_offset?: number } = root) {
  const page = await browser.newPage(); pages.push(page);
  const calls: Call[] = []; const logs: string[] = []; const sent: unknown[] = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(error.message));
  await page.clock.install();
  await page.exposeFunction('reply', async (call: Call) => { calls.push(call); return reply(call); });
  await page.exposeFunction('sent', (value: unknown) => { sent.push(value); });
  await page.addInitScript(({ input, data }) => {
    if (parent !== window) return;
    const host = window as unknown as Host;
    host.notify = (method, params) => document.querySelector('iframe')?.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
    let resolveBarrier: (() => void) | undefined;
    host.barrier = () => new Promise(resolve => {
      resolveBarrier = resolve;
      document.querySelector('iframe')?.contentWindow?.postMessage({ jsonrpc: '2.0', id: 90000, method: 'ping' }, '*');
    });
    window.addEventListener('message', async event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow) return;
      const p = event.data;
      if (p.id === 90000 && p.result) { resolveBarrier?.(); return; }
      const send = (value: unknown) => (event.source as Window).postMessage({ jsonrpc: '2.0', id: p.id, result: value }, '*');
      if (p.method === 'ui/initialize') send({ protocolVersion: '2026-01-26', hostInfo: { name: 'real-sdk-test', version: '1' },
        hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: {} });
      if (p.method === 'ui/notifications/initialized') {
        if (input) host.notify('ui/notifications/tool-input', { arguments: input });
        host.notify('ui/notifications/tool-result', { content: [], structuredContent: data });
      }
      if (p.method === 'tools/call') {
        try {
          send(await (window as unknown as { reply: (v: unknown) => Promise<unknown> }).reply(p.params));
          await (window as unknown as { sent: (v: unknown) => Promise<void> }).sent(p.params);
        }
        catch { (event.source as Window).postMessage({ jsonrpc: '2.0', id: p.id, error: { code: -32603, message: 'fixture failure' } }, '*'); }
      }
      if (p.method === 'ui/open-link') send({ isError: true });
      if (p.method === 'ping') send({});
    });
  }, { input, data });
  const imports = {
    '@modelcontextprotocol/client': '/deps/@modelcontextprotocol/client/dist/index.mjs',
    '@modelcontextprotocol/client/_shims': '/deps/@modelcontextprotocol/client/dist/shimsBrowser.mjs',
    '@modelcontextprotocol/core': '/deps/@modelcontextprotocol/core/dist/index.mjs',
    '@modelcontextprotocol/core/internal': '/deps/@modelcontextprotocol/core/dist/internal.mjs',
    'zod/v4': '/deps/zod/v4/index.js', 'pkce-challenge': '/deps/pkce-challenge/dist/index.browser.js',
    eventsource: '/deps/eventsource/dist/index.js', 'eventsource-parser': '/deps/eventsource-parser/dist/index.js',
    'eventsource-parser/stream': '/deps/eventsource-parser/dist/stream.js',
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<iframe src="/app" style="width:100%;height:900px"></iframe>' }); return;
    }
    if (url.pathname === '/app') {
      const bundled = process.env.CONTACT_UPLOAD_BUNDLE_REQUIRED === '1';
      const html = await readFile(bundled ? 'web/dist/contact-search-graph.html' : 'web/contact-search-graph.html', 'utf8');
      let headers: Record<string, string> | undefined;
      if (bundled) {
        const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
        if (!script) throw new Error('Built graph App has no inline script');
        const hash = createHash('sha256').update(script).digest('base64');
        headers = { 'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` };
      }
      await route.fulfill({ contentType: 'text/html', body: bundled ? html : html.replace('<!--SCRIPT-->',
        `<script type="importmap">${JSON.stringify({ imports })}</script><script type="module" src="/ui.js"></script>`), headers }); return;
    }
    if (url.pathname === '/ui.js' || url.pathname === '/contact-search-graph-model.js') {
      const file = url.pathname === '/ui.js' ? 'web/contact-search-graph.ts' : 'web/contact-search-graph-model.ts';
      const source = stripTypeScriptTypes(await readFile(file, 'utf8')).replace("'@modelcontextprotocol/ext-apps'", "'/deps/@modelcontextprotocol/ext-apps/dist/src/app.js'");
      await route.fulfill({ contentType: 'text/javascript', body: source }); return;
    }
    if (url.pathname.startsWith('/deps/')) {
      const base = resolve('node_modules'); const file = resolve(base, url.pathname.slice(6));
      if (!file.startsWith(base + '/') || !/\.(js|mjs)$/.test(file)) throw new Error('Invalid dependency route');
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(file, 'utf8') }); return;
    }
    throw new Error(`Unexpected network request: ${url.pathname}`);
  });
  await page.goto('http://graph.test/');
  const ui = page.frames().find(frame => frame !== page.mainFrame())!;
  await expect.poll(() => ui.locator('#summary').textContent()).toContain('1');
  return { page, ui, calls, logs, sent, barrier: () => page.evaluate(() => (window as unknown as Host).barrier()), notify: async (method: string, params: unknown) => {
    await page.evaluate(({ method, params }) => (window as unknown as Host).notify(method, params), { method, params });
  } };
}
beforeAll(async () => {
  const cached = '/Users/tang-codeing/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CONTACT_UPLOAD_CHROMIUM ?? (existsSync(cached) ? cached : undefined) });
});
afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close())); });
afterAll(async () => { await browser?.close(); });
async function completed(ui: Frame) { await expect.poll(() => ui.locator('#progress').textContent()).toContain('加载完成'); }

it.each(['p1', 'p2'])('shows identity hints from either endpoint without professional opt-in or graph edges: %s', async id => {
  const claim = { claim_id: 'dup-private-id', kind: 'relation', status: 'unverified', subject_id: 'p1', target_id: 'p2', relation_type: 'possible_duplicate', reason: 'possible_duplicate', value: { subject_name: '陈晓甲', target_name: '陈晓乙', reasons: ['same_name', 'email'] } };
  const data = { ...root, items: [{ entity_id: id, name: `人物${id}`, label: 'Person' }] };
  const h = await open(call => {
    const d = detail(String(call.arguments.entity_id), [], null, call.arguments.claim_limit === 20 ? [claim, { claim_id: 'career', kind: 'field', subject_id: id, status: 'unverified', field_path: 'properties.skills', value: '隐藏职业线索' }] : []);
    if (call.arguments.evidence_limit === 10) d.pagination.unverified_claims = { offset: Number(call.arguments.claim_offset ?? 0), total: 21, next_offset: call.arguments.claim_offset ? null : 20 };
    return result(d);
  }, { query: '陈晓', mode: 'keyword' }, data);
  await completed(h.ui);
  await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('身份待核对');
  const visible = await h.ui.locator('#detail').innerText();
  expect(visible).toContain('线索记录名称：陈晓甲 ↔ 陈晓乙');
  expect(visible).toContain('姓名相同'); expect(visible).toContain('邮箱相同');
  expect(visible).not.toContain('dup-private-id'); expect(visible).not.toContain('隐藏职业线索');
  expect(await h.ui.locator('[data-edge]').count()).toBe(0);
  await h.ui.locator('#detail .pager').filter({ hasText: '待核实线索' }).getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => h.calls.at(-1)?.arguments.claim_offset).toBe(20);
  expect(h.calls.at(-1)?.arguments.claim_limit).toBe(20);
  expect(await h.ui.locator('[data-node]').count()).toBe(1);
});

it('shows endpoint names, distinct jobs and Chinese evidence labels instead of internal identifiers', async () => {
  const personId = 'p_b3512f79cccd43eab17f3902724c50bb';
  const relations = ['运维工程师', '质量工程师'].map((role, i) => ({ ...edge(i), source_id: personId,
    properties: { role: { roleName: role } } }));
  const h = await open(call => {
    const d = detail(String(call.arguments.entity_id), call.arguments.entity_id === 'o1' ? relations : []);
    if (call.arguments.entity_id === personId) d.entity.properties.name = '金政文';
    if (call.arguments.evidence_limit === 10) d.evidence = [{ subject_kind: 'relation', subject_id: 'r0',
      field_path: 'properties.role.roleName', quote: '岗位依据', source_type: 'manual' }] as never[];
    return result(d);
  });
  await completed(h.ui);
  await h.ui.locator('#node-list button').filter({ hasText: '云杉智造' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('岗位依据');
  const visible = await h.ui.locator('#detail').innerText();
  expect(visible).toContain('金政文 → 云杉智造');
  expect(visible).toContain('运维工程师'); expect(visible).toContain('质量工程师');
  expect(visible).toContain('当前任职未知');
  expect(visible).toContain('职位'); expect(visible).toContain('关系'); expect(visible).toContain('证据');
  expect(visible).not.toContain(personId); expect(visible).not.toContain('o1');
  expect(visible).not.toContain('properties.'); expect(visible).not.toContain('relations');
  expect(await h.ui.locator('#detail .record').count()).toBe(3);
});

it('uses unnamed labels without exposing ID suffixes when endpoint names are unavailable', async () => {
  const personId = 'p_00112233445566778899aabbccddeeff';
  const h = await open(call => {
    if (call.arguments.entity_id === personId) throw new Error('unavailable endpoint');
    return result(detail('o1', [{ ...edge(1), source_id: personId }]));
  });
  await expect.poll(() => h.ui.locator('#progress').innerText()).toContain('部分失败');
  await h.ui.locator('#node-list button').filter({ hasText: '云杉智造' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('任职于');
  const visible = await h.ui.locator('body').innerText();
  expect(visible).not.toContain(personId); expect(visible).not.toContain('ccddeeff');
  expect(visible).not.toContain(' / name');
  expect(await h.ui.locator('#detail').innerText()).toContain('云杉智造');
});

it('automatically reads all root pages, names incoming endpoints and never traverses their relations', async () => {
  const h = await open(call => {
    if (call.arguments.entity_id === 'o1') return result(detail('o1',
      call.arguments.relation_offset === 20 ? [edge(20)] : Array.from({ length: 20 }, (_, i) => edge(i)),
      call.arguments.relation_offset === 20 ? null : 20));
    return result(detail(String(call.arguments.entity_id), [edge(99)]));
  });
  await completed(h.ui);
  expect(await h.ui.locator('[data-edge]').count()).toBe(21);
  expect(await h.ui.locator('[data-node]').count()).toBe(22);
  expect(h.calls.filter(c => c.arguments.entity_id === 'o1')).toHaveLength(2);
  expect(h.calls.filter(c => c.arguments.entity_id !== 'o1').every(c => c.arguments.relation_limit === 1 && c.arguments.claim_limit === 0)).toBe(true);
  expect(await h.ui.locator('body').innerText()).not.toContain('secret-phone');
  await h.ui.locator('#node-list button').filter({ hasText: '人物p0' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('工程师');
  expect(await h.ui.locator('[data-edge]').count()).toBe(21);
  expect(h.logs).toEqual([]);
});
it('does not confuse missing arguments with no claims, then automatically loads late opt-in claims', async () => {
  const c = { claim_id: 'c1', kind: 'relation', status: 'unverified', subject_id: 'o1', target_id: 'p1', relation_type: 'affiliation', reason: 'ambiguous_context', source: { quote: '测试证据' } };
  const h = await open(call => result(detail(String(call.arguments.entity_id), [], null,
    call.arguments.claim_limit === 20 ? [c] : [])), null);
  await expect.poll(() => h.ui.locator('#progress').textContent()).toContain('待核实线索未加载');
  expect(h.calls.every(c => c.arguments.claim_limit === 0)).toBe(true);
  await h.notify('ui/notifications/tool-input', { arguments: { query: '云杉', include_unverified: true } });
  await completed(h.ui);
  expect(await h.ui.locator('[data-edge]').count()).toBe(1);
  expect(await h.ui.locator('[data-edge]').getAttribute('data-status')).toBe('unverified');
});
it('retains successful pages on failure and resumes only the failed offset', async () => {
  let failed = false;
  const h = await open(call => {
    if (call.arguments.entity_id !== 'o1') return result(detail(String(call.arguments.entity_id)));
    if (call.arguments.relation_offset === 20 && !failed) { failed = true; throw new Error('upstream'); }
    return result(detail('o1', [edge(call.arguments.relation_offset === 20 ? 20 : 0)],
      call.arguments.relation_offset === 20 ? null : 20));
  });
  await expect.poll(() => h.ui.locator('#progress').textContent()).toContain('部分失败');
  expect(await h.ui.locator('[data-edge]').count()).toBe(1);
  await h.ui.locator('#retry').click(); await completed(h.ui);
  expect(await h.ui.locator('[data-edge]').count()).toBe(2);
  expect(h.calls.filter(c => c.arguments.entity_id === 'o1' && (c.arguments.relation_offset ?? 0) === 0)).toHaveLength(1);
});
it('never interprets hostile names as HTML and keeps disallowed links and private relations out', async () => {
  const name = '<img src=x onerror="window.hacked=1">';
  const h = await open(call => result({ ...detail(String(call.arguments.entity_id),
    [{ ...edge(1), relation_type: 'spouseOf' }]), entity: { entity_id: 'o1', label: 'Organization', properties: { name } } }));
  await completed(h.ui);
  expect(await h.ui.locator('[data-edge]').count()).toBe(0);
  expect(await h.ui.locator('#node-list').innerText()).toContain(name);
  expect(await h.ui.locator('img').count()).toBe(0);
  expect(h.logs).toEqual([]);
});

it('stops before the next request and continues without repeating successful pages', async () => {
  let release!: (v: unknown) => void;
  const h = await open(call => call.arguments.entity_id === 'o1' && (call.arguments.relation_offset ?? 0) === 0
    ? new Promise(resolve => { release = resolve; }) : result(detail(String(call.arguments.entity_id))));
  await expect.poll(() => h.calls.length).toBe(1);
  await h.ui.locator('#stop').click(); release(result(detail('o1', [edge(0)], 20)));
  await expect.poll(() => h.ui.locator('#progress').textContent()).toContain('已停止');
  expect(h.calls).toHaveLength(1);
  await h.ui.locator('#resume').click(); await completed(h.ui);
  expect(h.calls.filter(c => c.arguments.entity_id === 'o1')).toHaveLength(2);
});
it('ignores stale responses and serializes a new host query until the old call ends', async () => {
  let release!: (v: unknown) => void;
  let active = 0, maxActive = 0;
  const h = await open(async call => {
    active++; maxActive = Math.max(maxActive, active);
    const value = call.arguments.entity_id === 'o1' ? await new Promise(resolve => { release = resolve; })
      : result(detail(String(call.arguments.entity_id)));
    active--; return value;
  });
  await expect.poll(() => h.calls.length).toBe(1);
  await h.notify('ui/notifications/tool-input', { arguments: { name: '新查询' } });
  await h.notify('ui/notifications/tool-result', result({ ...root, items: [{ entity_id: 'p2', name: '新人物', label: 'Person' }] }));
  expect(h.calls).toHaveLength(1);
  release(result(detail('o1', [edge(0)]))); await completed(h.ui);
  expect(maxActive).toBe(1);
  expect(await h.ui.locator('[data-edge]').count()).toBe(0);
  expect(await h.ui.locator('#node-list').innerText()).not.toContain('云杉');
});
it('uses SDK request timeout and offers retry rather than remaining in loading forever', async () => {
  const h = await open(() => new Promise(() => {}));
  await expect.poll(() => h.calls.length).toBe(1);
  await h.page.clock.fastForward(31_000);
  await expect.poll(() => h.ui.locator('#progress').textContent()).toContain('部分失败');
  expect(await h.ui.locator('#retry').isEnabled()).toBe(true);
});
it.each([result({ found: false }), result({ ...detail('o1'), pagination: {} }),
  result(detail('o1', [], 0))])('marks unavailable records, invalid responses and non-progressing cursors as partial', async bad => {
  const h = await open(() => bad);
  await expect.poll(() => h.ui.locator('#progress').textContent()).toContain('部分失败');
  expect(await h.ui.locator('[data-node]').count()).toBe(1);
  expect(await h.ui.locator('[data-edge]').count()).toBe(0);
});
it('uses original search filters for next/previous pages and preserves old results on search failure', async () => {
  let fail = true;
  const data = { ...root, next_offset: 1 };
  const h = await open(call => {
    if (call.name === 'search_contacts') {
      if (fail) { fail = false; return { isError: true, content: [] }; }
      return result(call.arguments.offset === 1 ? { ...root, items: [{ entity_id: 'p2', name: '第二页', label: 'Person' }] } : data);
    }
    return result(detail(String(call.arguments.entity_id)));
  }, { query: '云杉', mode: 'keyword', limit: 1 }, data);
  await completed(h.ui); await h.ui.locator('#search-next').click();
  await expect.poll(() => h.ui.locator('#notice').innerText()).toContain('上一查询结果');
  expect(await h.ui.locator('#node-list').innerText()).toContain('云杉智造');
  await h.ui.locator('#search-next').click(); await completed(h.ui);
  expect(h.calls.filter(c => c.name === 'search_contacts').at(-1)?.arguments).toEqual({ query: '云杉', mode: 'keyword', limit: 1, offset: 1 });
  await h.ui.locator('#search-prev').click(); await completed(h.ui);
  expect(await h.ui.locator('#node-list').innerText()).toContain('云杉智造');
});
it('aligns relation evidence, preserves the graph while paging, and opens only explicit safe links', async () => {
  const h = await open(call => {
    if (call.arguments.entity_id !== 'o1') return result(detail(String(call.arguments.entity_id)));
    const d = detail('o1', [edge(1)]);
    if (call.arguments.evidence_limit === 10) {
      d.evidence = [{ subject_kind: 'relation', subject_id: 'r1', field_path: 'properties.role.roleName',
        quote: '岗位依据', source_type: 'web', source_url: 'https://source.example/evidence' },
        { subject_kind: 'entity', subject_id: 'o1', field_path: 'properties.telephone', quote: 'private-phone' },
        { subject_kind: 'relation', subject_id: 'private', field_path: 'properties.role.roleName', quote: 'family-secret' }] as never[];
    }
    return result(d);
  });
  await completed(h.ui); await h.ui.locator('[data-edge]').focus(); await h.ui.locator('[data-edge]').press('Enter');
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('岗位依据');
  expect(await h.ui.locator('#detail').innerText()).not.toContain('private-phone');
  expect(await h.ui.locator('#detail').innerText()).not.toContain('family-secret');
  await h.ui.locator('#detail button').filter({ hasText: '打开来源' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('https://source.example/evidence');
  expect(await h.ui.locator('[data-edge]').count()).toBe(1);
});
it('keeps the latest selection when an older detail request resolves after reselecting the loaded root', async () => {
  let release!: (v: unknown) => void;
  const h = await open(call => {
    if (call.arguments.entity_id === 'p1' && call.arguments.evidence_limit === 10) return new Promise(resolve => { release = resolve; });
    return result(detail(String(call.arguments.entity_id), call.arguments.entity_id === 'o1' ? [edge(1)] : []));
  });
  await completed(h.ui);
  await h.ui.locator('#node-list button').filter({ hasText: '云杉智造' }).click();
  await expect.poll(() => h.ui.locator('#detail h3').textContent()).toBe('云杉智造');
  await h.ui.locator('#node-list button').filter({ hasText: '人物p1' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await h.ui.locator('#node-list button').filter({ hasText: '云杉智造' }).click();
  release(result(detail('p1')));
  await expect.poll(() => h.sent.length).toBe(h.calls.length);
  await h.barrier();
  await expect.poll(() => h.ui.locator('#detail h3').textContent()).toBe('云杉智造');
});
it('does not label the previous graph complete while a queued search is still awaiting its result', async () => {
  let releaseRoot!: (v: unknown) => void, releaseSearch!: (v: unknown) => void;
  const h = await open(call => new Promise(resolve => {
    if (call.name === 'search_contacts') releaseSearch = resolve; else releaseRoot = resolve;
  }), { query: '云杉', mode: 'keyword' }, { ...root, next_offset: 1 });
  await expect.poll(() => h.calls.length).toBe(1); await h.ui.locator('#search-next').click();
  releaseRoot(result(detail('o1')));
  await expect.poll(() => typeof releaseSearch).toBe('function');
  expect(await h.ui.locator('#progress').textContent()).not.toContain('加载完成');
  releaseSearch(result({ ...root, items: [], total: 0 }));
  await expect.poll(() => h.ui.locator('#summary').textContent()).toContain('匹配 0');
});
it('loads every root on a fifty-hit page but never follows a shared neighbor into another hop', async () => {
  const data = { ...root, total: 50, items: Array.from({ length: 50 }, (_, i) => ({ entity_id: `p${i}`, name: `人物${i}`, label: 'Person' })) };
  const h = await open(call => {
    const id = String(call.arguments.entity_id);
    const r = { relation_id: `r-${id}`, source_id: id, target_id: id === 'shared' ? 'hidden' : 'shared', relation_type: 'affiliation', properties: {}, metadata: {} };
    return result(detail(id, [r]));
  }, {}, data);
  await completed(h.ui);
  expect(await h.ui.locator('[data-node]').count()).toBe(51);
  expect(await h.ui.locator('[data-edge]').count()).toBe(50);
  expect(h.calls).toHaveLength(51);
  expect(h.calls.filter(c => c.arguments.entity_id === 'shared')).toHaveLength(1);
  expect(h.calls.some(c => c.arguments.entity_id === 'hidden')).toBe(false);
}, 15_000);
it.each(['javascript:alert(1)', 'data:text/html,private'])('never offers an executable source link for %s', async url => {
  const h = await open(call => {
    const d = detail(String(call.arguments.entity_id));
    d.evidence = [{ subject_kind: 'entity', subject_id: 'o1', field_path: 'properties.name', quote: '来源文本', source_url: url }] as never[];
    return result(d);
  });
  await completed(h.ui); await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('来源文本');
  expect(await h.ui.locator('#detail button').filter({ hasText: '打开来源' }).count()).toBe(0);
  expect(h.logs).toEqual([]);
});
it('keeps detail collection offsets independent and never removes graph edges when evidence is paged', async () => {
  const h = await open(call => {
    const d = detail(String(call.arguments.entity_id), call.arguments.entity_id === 'o1' ? [edge(99)] : []);
    if (call.arguments.evidence_limit === 10) {
      const eo = Number(call.arguments.evidence_offset ?? 0), ro = Number(call.arguments.relation_offset ?? 0);
      d.evidence = Array.from({ length: eo === 0 ? 2 : 1 }, () => ({ subject_kind: 'entity', subject_id: 'o1', field_path: 'properties.name',
        value: '云杉智造', source_type: 'file', file_name: 'fixture.pdf', page: 1, locator_status: 'located', quote: `证据页${eo}` })) as never[];
      d.relations = ro === 0 ? Array.from({ length: 7 }, (_, i) => edge(i)) : [edge(7)];
      d.pagination.evidence = { offset: eo, total: 3, next_offset: eo === 0 ? 2 : null };
      d.pagination.relations = { offset: ro, total: 8, next_offset: ro === 0 ? 7 : null };
    }
    return result(d);
  });
  await completed(h.ui); await h.ui.locator('#node-list button').filter({ hasText: '云杉智造' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('证据页0');
  await h.ui.locator('#detail .pager').filter({ hasText: '证据' }).getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('证据页2');
  await h.ui.locator('#detail .pager').filter({ hasText: '关系' }).getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => h.calls.at(-1)?.arguments.relation_offset).toBe(7);
  expect(h.calls.at(-1)?.arguments.evidence_offset).toBe(2);
  expect(h.calls.at(-1)?.arguments.claim_offset).toBe(0);
  expect(await h.ui.locator('[data-edge]').count()).toBe(1);
});

it('loads company detail on selection, pages history and opens the selected report', async () => {
  const reports = Array.from({length:11},(_,i) => ({
    assessment_id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    generated_at:'2026-10-12T00:00:00Z',collected_at:'2026-10-11T00:00:00Z',
    overall_opportunity:'中',recommended_product:null,
  }));
  const h = await open(call => {
    if (call.name === 'get_contact') {
      const base = detail(String(call.arguments.entity_id));
      if (!call.arguments.include_company_context) return result(base);
      const offset = Number(call.arguments.report_offset ?? 0);
      return result({...base,company_context:{state:'ok',warnings:[],
        link:{state:'confirmed',organization_id:'o1',credit_code:'synthetic',basis:'manual',
          version:1,candidates:[],warnings:[]},
        has_profile:true,report_count:11,latest_report_at:reports[0].generated_at,
        profile:{legal_name:'云杉智造',credit_code:'synthetic',basic_profile:{industry:'装备制造'},
          collected_at:'2026-10-11T00:00:00Z',stale:false},
        latest_report:reports[0],reports:{items:reports.slice(offset,offset+10),total:11,
          next_offset:offset===0?10:null,complete:true}}});
    }
    if (call.name === 'get_assessment_report') return result({
      assessment_id:call.arguments.assessment_id,status:'completed',legal_name:'云杉智造',
      markdown:'# 第十一份历史报告',generated_at:reports[10].generated_at,
      collected_at:reports[10].collected_at,overall_opportunity:'中',recommended_product:null,
      dynamic_signal_freshness:'current',source_status:{qcc:'completed',doubao_search:'completed',ark:'completed'},
    });
    throw new Error(`Unexpected tool ${call.name}`);
  });
  await completed(h.ui);
  expect(h.calls.some(c => c.name==='get_assessment_report')).toBe(false);
  expect(h.calls.filter(c => c.name==='get_contact')
    .every(c => c.arguments.include_company_context!==true)).toBe(true);
  await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('装备制造');
  await h.ui.getByRole('button',{name:'报告下一页',exact:true}).click();
  await expect.poll(() => h.calls.some(c => c.name==='get_contact' && c.arguments.report_offset===10)).toBe(true);
  await h.ui.getByRole('button',{name:`查看报告 ${reports[10].assessment_id}`,exact:true}).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('第十一份历史报告');
  expect(h.calls.find(c => c.name==='get_assessment_report')?.arguments)
    .toMatchObject({assessment_id:reports[10].assessment_id});
  expect(await h.ui.locator('#node-list button').count()).toBe(1);
  expect(h.calls.filter(c => c.arguments.report_offset===10)
    .every(c => Number(c.arguments.relation_offset ?? 0)===0)).toBe(true);
});

const reportId = '10000000-0000-4000-8000-000000000001';
function companyFixture(state = 'confirmed') {
  const item = {assessment_id:reportId,generated_at:'2026-10-12T00:00:00Z',collected_at:'2026-10-11T00:00:00Z',overall_opportunity:'中',recommended_product:null};
  return {state:'partial',warnings:['合成资料限制'],link:{state,candidates:[{legal_name:'候选名字'}]},has_profile:true,report_count:null,
    profile:{legal_name:'云杉智造',basic_profile:{industry:'装备制造',telephone:'hidden-phone'},collected_at:item.collected_at,stale:true},
    latest_report:item,reports:{items:[item],total:null,next_offset:null,complete:false}};
}
it('shows candidates without exposing unconfirmed profiles or reports', async () => {
  const h = await open(call => result({...detail(String(call.arguments.entity_id)), ...(call.arguments.include_company_context ? {company_context:companyFixture('candidate')} : {})}));
  await completed(h.ui); await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('候选关联，尚未确认');
  const visible = await h.ui.locator('#detail').innerText();
  expect(visible).toContain('候选名字'); expect(visible).not.toContain('装备制造');
  expect(await h.ui.getByRole('button',{name:`查看报告 ${reportId}`,exact:true}).count()).toBe(0);
});
it('retries report failures and renders hostile report strings only as text', async () => {
  let attempts = 0;
  const hostile = '<img src=x onerror="window.hacked=1"><script>bad()</script>';
  const h = await open(call => {
    if(call.name === 'get_assessment_report') {
      if (++attempts === 1) throw new Error('synthetic failure');
      return result({assessment_id:reportId,status:'completed',markdown:hostile,generated_at:'2026-10-12T00:00:00Z'});
    }
    return result({...detail(String(call.arguments.entity_id)), ...(call.arguments.include_company_context ? {company_context:companyFixture()} : {})});
  });
  await completed(h.ui); await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('装备制造');
  expect(await h.ui.locator('#detail').innerText()).toContain('历史报告数量：未知');
  expect(await h.ui.locator('#detail').innerText()).toContain('资料已过期');
  expect(await h.ui.locator('#detail').innerText()).not.toContain('hidden-phone');
  await h.ui.getByRole('button',{name:`查看报告 ${reportId}`,exact:true}).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('报告读取失败');
  await h.ui.getByRole('button',{name:`查看报告 ${reportId}`,exact:true}).click();
  await expect.poll(() => h.ui.locator('#detail pre').textContent()).toBe(hostile);
  expect(await h.ui.locator('#detail img, #detail script').count()).toBe(0);
  expect(await h.ui.locator('[data-node]').count()).toBe(1);
});
it('discards late reports after selecting another node and keeps its base archive', async () => {
  let release!: (v:unknown) => void;
  const h = await open(call => {
    if(call.name==='get_assessment_report') return new Promise(resolve => {release=resolve;});
    return result({...detail(String(call.arguments.entity_id),call.arguments.entity_id==='o1'?[edge(1)]:[]), ...(call.arguments.include_company_context?{company_context:companyFixture()}: {})});
  });
  await completed(h.ui); await h.ui.locator('#node-list button').filter({hasText:'云杉智造'}).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('装备制造');
  await h.ui.getByRole('button',{name:`查看报告 ${reportId}`,exact:true}).click();
  await expect.poll(() => typeof release).toBe('function');
  await h.ui.locator('#node-list button').filter({hasText:'人物p1'}).click();
  release(result({assessment_id:reportId,status:'completed',markdown:'迟到报告'}));
  await expect.poll(() => h.ui.locator('#detail h3').textContent()).toBe('人物p1');
  await h.barrier(); expect(await h.ui.locator('#detail').innerText()).not.toContain('迟到报告');
});
it('preserves the basic organization archive when company detail fails', async () => {
  const h = await open(call => {if(call.arguments.include_company_context) throw new Error('context unavailable'); return result(detail(String(call.arguments.entity_id)));});
  await completed(h.ui); await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#notice').innerText()).toContain('档案读取失败');
  expect(await h.ui.locator('#detail h3').textContent()).toBe('云杉智造');
});

it('ignores slow organization context after selecting a person', async () => {
  let release!: (v:unknown) => void;
  const h = await open(call => {
    if(call.arguments.include_company_context) return new Promise(resolve => { release = resolve; });
    return result(detail(String(call.arguments.entity_id),call.arguments.entity_id==='o1'?[edge(1)]:[]));
  });
  await completed(h.ui); await h.ui.locator('#node-list button').filter({hasText:'云杉智造'}).click();
  await expect.poll(() => typeof release).toBe('function');
  await h.ui.locator('#node-list button').filter({hasText:'人物p1'}).click();
  release(result({...detail('o1'),company_context:companyFixture()}));
  await expect.poll(() => h.ui.locator('#detail h3').textContent()).toBe('人物p1');
  await h.barrier(); expect(await h.ui.locator('#detail').innerText()).not.toContain('装备制造');
  expect(h.calls.filter(c=>c.arguments.entity_id==='p1').every(c=>c.arguments.include_company_context!==true)).toBe(true);
});
