import { App } from '@modelcontextprotocol/ext-apps';
import { parseJSONRPCMessage, type Transport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { object, records, toGraph, displayTitle, professionalRelations, type SearchInput, type SearchPage,
  type ContactDetail, type GraphEdge } from './contact-search-graph-model.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const graph = document.getElementById('graph') as unknown as SVGSVGElement;
const summary = el('summary'), progress = el('progress'), notice = el('notice'), panel = el('detail');
const app = new App({ name: 'salestools-contact-search-graph', version: '1.0.0' });
type Collection = 'relations' | 'unverified_claims';
type Load = { id: string; collection: Collection | 'name'; offset: number; done: boolean; failed: boolean; message?: string };
type DetailRequest = { id: string; offsets: { evidence: number; relations: number; unverified_claims: number }; edge?: GraphEdge };
let page: SearchPage | null = null, input: SearchInput | null = null, hostInput: SearchInput | null = null;
let materials: ContactDetail[] = [], loads: Load[] = [];
let selected: ContactDetail | null = null, selection: DetailRequest | null = null;
let pendingDetail: DetailRequest | null = null, pendingSearch: { args: SearchInput; previous: boolean } | null = null;
let readingDetail: { request: DetailRequest; version: number } | null = null;
let requestVersion = 0, detailVersion = 0, running = false, paused = false, connected = false;
let searching = false;
let waitingResult = false, searchedOffsets: number[] = [];
let view = { x: 0, y: 0, width: 1000, height: 510 }, extent = { width: 1000, height: 510 };
let selectedEdge: GraphEdge | undefined;
const limit = { evidence: 10, relations: 20, unverified_claims: 20 };

// The default transport logs personal records; retain its validated message contract without logging.
class PrivateHostTransport implements Transport {
  onclose?: Transport['onclose']; onerror?: Transport['onerror']; onmessage?: Transport['onmessage'];
  private readonly receive = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    let message: JSONRPCMessage;
    try { message = parseJSONRPCMessage(event.data); }
    catch { this.onerror?.(new Error('Invalid host message')); return; }
    this.onmessage?.(message);
  };
  async start() { window.addEventListener('message', this.receive); }
  async send(message: JSONRPCMessage) { window.parent.postMessage(message, '*'); }
  async close() { window.removeEventListener('message', this.receive); this.onclose?.(); }
}
function searchInput(value: unknown): SearchInput {
  const v = object(value), keys = ['query', 'name', 'organization_id', 'job_title', 'skill', 'include_unverified', 'mode', 'offset', 'limit'];
  if (Object.keys(v).some(k => !keys.includes(k))) throw new Error('Invalid query');
  for (const k of keys.slice(0, 5)) if (v[k] !== undefined && typeof v[k] !== 'string') throw new Error('Invalid query');
  if (v.include_unverified !== undefined && typeof v.include_unverified !== 'boolean') throw new Error('Invalid query');
  if (v.mode !== undefined && !['keyword', 'semantic', 'hybrid'].includes(String(v.mode))) throw new Error('Invalid query');
  if (v.include_unverified === true && (typeof v.query !== 'string' || !v.query.trim() || v.mode !== undefined && v.mode !== 'keyword')) throw new Error('Invalid claim query');
  for (const [k, max, min] of [['offset', 10000, 0], ['limit', 50, 1]] as const) {
    if (v[k] !== undefined && (!Number.isSafeInteger(v[k]) || Number(v[k]) < min || Number(v[k]) > max)) throw new Error('Invalid query');
  }
  return v as SearchInput;
}
function output(result: unknown): Record<string, unknown> {
  const r = object(result);
  if (r.isError) throw new Error('Tool failed');
  if (r.structuredContent) return object(r.structuredContent);
  const text = records(r.content).find(c => c.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Missing result');
  return object(JSON.parse(text));
}
function searchPage(value: unknown): SearchPage {
  const r = object(value);
  if (!Array.isArray(r.items) || r.items.length > 50 || !Number.isSafeInteger(r.total) || Number(r.total) < 0
    || !['keyword', 'semantic', 'hybrid'].includes(String(r.mode_used)) || !Array.isArray(r.warnings)
    || !r.warnings.every(w => typeof w === 'string') || r.items.some(i => typeof object(i).entity_id !== 'string' || !object(i).entity_id)) throw new Error('Invalid search response');
  if (r.next_offset != null && (!Number.isSafeInteger(r.next_offset) || Number(r.next_offset) < 0)) throw new Error('Invalid cursor');
  return r as SearchPage;
}
async function readDetail(args: Record<string, unknown>): Promise<ContactDetail> {
  const r = output(await app.callServerTool({ name: 'get_contact', arguments: args }, { timeout: 30_000 }));
  if (r.found === false) throw new Error('Unavailable contact');
  if (object(r.entity).entity_id !== args.entity_id || !Array.isArray(r.relations) || !Array.isArray(r.evidence)
    || !Array.isArray(r.unverified_claims) || !Array.isArray(r.conflicts)) throw new Error('Invalid detail response');
  if (r.relations.some(v => ['relation_id', 'source_id', 'target_id', 'relation_type'].some(k => typeof object(v)[k] !== 'string' || !object(v)[k]))) throw new Error('Invalid relation');
  for (const k of ['evidence', 'relations', 'unverified_claims']) {
    const p = object(object(r.pagination)[k]);
    if (!Number.isSafeInteger(p.total) || Number(p.total) < 0 || !('next_offset' in p)
      || (p.next_offset !== null && (!Number.isSafeInteger(p.next_offset) || Number(p.next_offset) < 0))) throw new Error('Invalid pagination');
  }
  return r;
}
function nextOffset(d: ContactDetail, collection: string, current: number): number | null {
  const next = object(object(d.pagination)[collection]).next_offset;
  if (next == null) return null;
  if (typeof next !== 'number' || next <= current) throw new Error('Non-progressing cursor');
  return next;
}
function text(parent: Element, tag: string, value: unknown, className?: string): HTMLElement {
  const item = document.createElement(tag); item.textContent = readable(value);
  if (className) item.className = className;
  parent.append(item); return item;
}
function readable(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string').join('、');
  return '';
}
function button(parent: Element, title: string, action: () => void, disabled = false) {
  const b = text(parent, 'button', title) as HTMLButtonElement; b.disabled = disabled; b.onclick = action; return b;
}
const labels: Record<string, string> = { worksFor: '任职于', alumniOf: '就读 / 校友', memberOf: '参与', clientOrganization: '项目客户', affiliation: '关联' };
const nodeLabels = { Person: '人物', Organization: '机构', Project: '项目', Unknown: '关联节点' };
const collectionLabels = { evidence: '证据', relations: '关系', unverified_claims: '待核实线索', name: '名称' };
function fieldLabel(path: unknown): string {
  const key = readable(path).replace(/^properties\./, '').replace(/\[\d+\]$/, '');
  return ({ name: '名称', legalName: '法定名称', jobTitle: '职位', skills: '技能',
    'role.roleName': '职位', role: '角色', startDate: '开始时间', endDate: '结束时间' } as Record<string, string>)[key] ?? '字段依据';
}
function relationText(edge: GraphEdge): string {
  const meta = object(edge.record.metadata), props = object(edge.record.properties);
  const role = readable(object(props.role).roleName);
  const status = meta.employment_status === 'current' ? `现任（截至 ${readable(meta.status_as_of) || '未注明'}）`
    : meta.employment_status === 'ended' ? '已结束' : '当前任职未知';
  return `${labels[edge.type]}${edge.status === 'unverified' ? ' · 待核实关联' : edge.type === 'worksFor' ? ` · ${status}` : ''}${role ? ` · ${role}` : ''}`;
}
function svg(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) item.setAttribute(k, v);
  return item;
}
function applyView() { graph.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`); }
function render() {
  if (!page) return;
  addClaims();
  const state = toGraph(page, materials, input?.include_unverified === true);
  if (!loads.some(l => l.collection !== 'name' && !l.done && !l.failed && (l.collection !== 'unverified_claims' || input?.include_unverified))) {
    for (const n of state.nodes.filter(n => !n.matched)) if (!loads.some(l => l.id === n.id && l.collection === 'name') && !materials.some(d => object(d.entity).entity_id === n.id)) {
      loads.push({ id: n.id, collection: 'name', offset: 0, done: false, failed: false });
    }
  }
  summary.textContent = `匹配 ${page.total} 个节点 · 本页 ${page.items.length} 个 · 关联补充 ${state.nodes.filter(n => !n.matched).length} 个`;
  const conditionLabels: Record<string, string> = { query: '关键词', name: '姓名', organization_id: '机构', job_title: '职位', skill: '技能', include_unverified: '包含待核实线索', mode: '搜索方式', offset: '起始位置', limit: '每页条数' };
  el('conditions').textContent = input ? `搜索条件：${Object.entries(input).map(([k, v]) => {
    const value = k === 'organization_id' ? state.nodes.find(n => n.id === v)?.title ?? '已选择机构'
      : k === 'mode' ? ({ keyword: '关键词', semantic: '语义', hybrid: '混合' } as Record<string, string>)[String(v)]
      : typeof v === 'boolean' ? v ? '是' : '否' : String(v);
    return `${conditionLabels[k]}：${value}`;
  }).join(' · ') || '默认关键词搜索'}${page.warnings.length ? ' · 搜索结果存在限制，请核对文字查询结果' : ''}` : '原查询参数尚未收到';
  const active = loads.filter(l => l.collection !== 'unverified_claims' || input?.include_unverified);
  const failures = active.filter(l => l.failed);
  const finished = page.items.filter(i => active.filter(l => l.id === i.entity_id && l.collection !== 'name').every(l => l.done)).length;
  let status = waitingResult || searching || pendingSearch ? '正在等待搜索结果；当前显示上一查询结果' : !page.items.length ? '本次库内查询未找到匹配记录' : failures.length ? `部分失败：${failures.map(l => `${state.nodes.find(n => n.id === l.id)?.title ?? '关联节点'} / ${collectionLabels[l.collection]} · ${l.message ?? '读取失败'}`).join('、')}`
    : active.every(l => l.done) ? `一跳关系加载完成${state.edges.length ? '' : ' · 未返回职业范围内的直接关联'}` : paused ? '已停止加载；关系尚未完整，可继续加载' : '一跳关系加载中';
  status += ` · 命中节点 ${finished}/${page.items.length}`;
  if (!input) status += ' · 原查询参数尚未收到，待核实线索未加载';
  if (active.some(l => l.collection === 'name' && !l.done)) status += ' · 部分端点名称尚未加载';
  progress.textContent = status;
  for (const [id, disabled] of [['stop', paused || !connected || !active.some(l => !l.done && !l.failed)],
    ['resume', !paused || !connected], ['retry', !failures.length || !connected],
    ['search-prev', !input || !searchedOffsets.length || !!pendingSearch || searching || waitingResult || !connected],
    ['search-next', !input || page.next_offset == null || !!pendingSearch || searching || waitingResult || !connected]] as const) el<HTMLButtonElement>(id).disabled = disabled;
  graph.replaceChildren();
  const defs = svg('defs'), marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#71887e' })); defs.append(marker); graph.append(defs);
  const counts = [0, 0, 0], positions = new Map<string, { x: number; y: number }>();
  for (const node of state.nodes) {
    const col = node.label === 'Person' ? 0 : node.label === 'Organization' ? 1 : 2;
    positions.set(node.id, { x: 170 + col * 320, y: 55 + counts[col]++ * 95 });
  }
  extent = { width: 1000, height: Math.max(510, Math.max(...counts) * 95 + 40) };
  for (const edge of state.edges) {
    const from = positions.get(edge.source)!, to = positions.get(edge.target)!;
    const line = svg('path', { d: `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + (from.x === to.x ? 80 : 0)} ${(from.y + to.y) / 2 - 28} ${to.x} ${to.y}`,
      fill: 'none', stroke: edge.status === 'unverified' ? '#b18340' : '#71887e', 'stroke-width': '2',
      'stroke-dasharray': edge.status === 'unverified' ? '6 5' : '', 'marker-end': 'url(#arrow)',
      'data-edge': edge.id, 'data-status': edge.status, tabindex: '0', role: 'button', 'aria-label': relationText(edge) });
    const choose = () => selectNode(rootsFor(edge), edge);
    line.addEventListener('click', choose); line.addEventListener('keydown', e => { if (['Enter', ' '].includes((e as KeyboardEvent).key)) { e.preventDefault(); choose(); } });
    const title = svg('title'); title.textContent = relationText(edge); line.append(title); graph.append(line);
    const caption = svg('text', { x: String((from.x + to.x) / 2), y: String((from.y + to.y) / 2 - 18),
      fill: edge.status === 'unverified' ? '#996e2c' : '#5a716a', 'font-size': '11', 'text-anchor': 'middle', 'pointer-events': 'none' });
    caption.textContent = `${labels[edge.type]}${edge.status === 'unverified' ? '（待核实）' : ''}`; graph.append(caption);
  }
  const list = el('node-list'); list.replaceChildren();
  for (const node of state.nodes) {
    const pos = positions.get(node.id)!;
    const g = svg('g', { transform: `translate(${pos.x - 125} ${pos.y - 30})`, 'data-node': node.id });
    g.append(svg('rect', { width: '250', height: '60', rx: '8', fill: node.label === 'Person' ? '#e9f4ef' : node.label === 'Organization' ? '#eff1e2' : '#edf0f5', stroke: '#bacdc3' }));
    const t = svg('text', { x: '12', y: '25', fill: '#153b35', 'font-size': '14' }); t.textContent = node.title.length > 16 ? `${node.title.slice(0, 16)}…` : node.title;
    const full = svg('title'); full.textContent = node.title; t.append(full); g.append(t);
    const hint = svg('text', { x: '12', y: '46', fill: '#5a716a', 'font-size': '11' }); hint.textContent = `${nodeLabels[node.label]} · ${node.matched ? '搜索命中' : '关联补充'}`; g.append(hint);
    g.addEventListener('click', () => selectNode(node.id)); graph.append(g);
    const li = document.createElement('li'); const b = button(li, node.title, () => selectNode(node.id));
    const rootLoads = active.filter(l => l.id === node.id && l.collection !== 'name');
    const loadState = rootLoads.some(l => l.failed) ? '部分失败' : rootLoads.every(l => l.done) ? '加载完成' : paused ? '已停止' : '加载中';
    text(b, 'small', `${nodeLabels[node.label]} · ${node.matched ? `搜索命中 · ${loadState}` : '关联补充'}`); list.append(li);
  }
  applyView();
  if (selected && selection) renderDetail();
}
function rootsFor(edge: GraphEdge): string {
  const root = page?.items.find(i => i.entity_id === edge.source || i.entity_id === edge.target);
  return edge.status === 'unverified' ? edge.source : root?.entity_id ?? edge.source;
}
function safeField(path: unknown) { return typeof path === 'string' && /^(properties\.)?(name|legalName|jobTitle|skills)(\[\d+\])?$/.test(path); }
function source(parent: Element, record: Record<string, unknown>) {
  text(parent, 'p', record.quote, 'quote');
  text(parent, 'p', `${readable(record.source_type)} ${readable(record.file_name)} ${readable(record.collected_at)}`, 'quote');
  const value = record.source_url ?? record.url;
  if (typeof value !== 'string') return;
  let url: URL; try { url = new URL(value); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  button(parent, '打开来源', () => { void app.openLink({ url: url.href }, { timeout: 30_000 }).then(r => {
    if (r.isError) text(parent, 'p', `宿主未打开来源，可复制：${url.href}`, 'source');
  }).catch(() => text(parent, 'p', `来源打开失败，可复制：${url.href}`, 'source')); });
}
function renderDetail() {
  if (!selected || !selection) return;
  panel.replaceChildren(); const entity = object(selected.entity), props = object(entity.properties);
  const names = new Map(toGraph(page ?? { items: [], total: 0, mode_used: 'keyword', warnings: [] },
    [...materials, selected], input?.include_unverified === true).nodes.map(n => [n.id, n.title]));
  names.set(selection.id, displayTitle(entity, page?.items.find(i => i.entity_id === selection!.id)));
  const name = (id: string) => names.get(id) ?? '名称未提供';
  text(panel, 'h3', name(selection.id));
  for (const key of ['jobTitle', 'skills']) if (readable(props[key])) text(panel, 'p', `${key === 'jobTitle' ? '职位' : '技能'}：${readable(props[key])}`);
  const edges = toGraph({ items: [{ entity_id: selection.id }], total: 1, mode_used: 'keyword', warnings: [] }, [selected], input?.include_unverified === true).edges;
  const allowed = new Set(edges.filter(e => e.status === 'recorded').map(e => e.record.relation_id));
  if (selectedEdge?.status === 'recorded') allowed.add(selectedEdge.record.relation_id);
  if (selectedEdge) text(panel, 'p', relationText(selectedEdge));
  for (const edge of edges) {
    const box = text(panel, 'div', '', 'record'); text(box, 'p', `${name(edge.source)} → ${name(edge.target)} · ${relationText(edge)}`);
    if (edge.status === 'unverified') { text(box, 'p', edge.record.reason); source(box, object(edge.record.source)); }
  }
  const evidence = records(selected.evidence).filter(e => selectedEdge
    ? e.subject_kind === 'relation' && e.subject_id === selectedEdge.record.relation_id
    : e.subject_kind === 'entity' && e.subject_id === selection!.id && safeField(e.field_path)
      || e.subject_kind === 'relation' && allowed.has(e.subject_id));
  if (selectedEdge?.status === 'unverified') { text(panel, 'p', selectedEdge.record.reason); source(panel, object(selectedEdge.record.source)); }
  if (selectedEdge?.status === 'recorded' && !evidence.length) text(panel, 'p', '当前证据页未包含该关系的证据');
  for (const e of evidence) { const box = text(panel, 'div', '', 'record'); text(box, 'p', fieldLabel(e.field_path)); source(box, e); }
  for (const c of records(selected.conflicts)) if (c.subject_kind === 'entity' && c.subject_id === selection.id && safeField(c.field_path)) {
    const box = text(panel, 'div', '字段冲突', 'record'); text(box, 'p', `${fieldLabel(c.field_path)}：${readable(c.value)}`); source(box, c);
  }
  if (input?.include_unverified) for (const c of records(selected.unverified_claims)) {
    if (c.subject_id !== selection.id || c.status !== 'unverified' || !(c.kind === 'relation' && professionalRelations.has(String(c.relation_type)) || c.kind === 'field' && safeField(c.field_path))) continue;
    if (edges.some(e => e.id === `claim:${c.claim_id}`)) continue;
    const box = text(panel, 'div', '待核实线索', 'record'); text(box, 'p', `${c.kind === 'relation' ? labels[String(c.relation_type)] : fieldLabel(c.field_path)}：${readable(c.value)} · ${readable(c.reason)}`); source(box, object(c.source));
  }
  for (const collection of ['evidence', 'relations', 'unverified_claims'] as const) {
    if (collection === 'unverified_claims' && !input?.include_unverified) continue;
    const p = object(object(selected.pagination)[collection]);
    const row = text(panel, 'div', '', 'pager'); text(row, 'span', `${collectionLabels[collection]} ${selection.offsets[collection]}/${readable(p.total)}`);
    const change = (offset: number) => { if (!selection) return; pendingDetail = { ...selection, offsets: { ...selection.offsets, [collection]: offset } }; detailVersion++; void pump(); };
    button(row, '上一页', () => change(Math.max(0, selection!.offsets[collection] - limit[collection])), selection.offsets[collection] === 0);
    button(row, '下一页', () => { try { const next = nextOffset(selected!, collection, selection!.offsets[collection]); if (next !== null) change(next); } catch { notice.textContent = '分页游标异常，不能继续读取。'; } }, p.next_offset == null);
  }
}
function selectNode(id: string, edge?: GraphEdge) {
  if (!connected) { notice.textContent = '宿主连接不可用，请在聊天查询详情。'; return; }
  if (pendingDetail?.id === id && pendingDetail.edge?.id === edge?.id
    || readingDetail?.request.id === id && readingDetail.version === detailVersion && readingDetail.request.edge?.id === edge?.id) return;
  selectedEdge = edge;
  detailVersion++;
  if (selection?.id === id && selected) { pendingDetail = null; selection.edge = edge; notice.textContent = ''; renderDetail(); return; }
  pendingDetail = { id, offsets: { evidence: 0, relations: 0, unverified_claims: 0 }, edge };
  notice.textContent = '正在读取所选档案…'; void pump();
}
function accept(p: SearchPage, args: SearchInput | null) {
  requestVersion++; detailVersion++; page = p; input = args; waitingResult = false; paused = false;
  materials = []; loads = p.items.map(i => ({ id: i.entity_id, collection: 'relations', offset: 0, done: false, failed: false }));
  selected = null; selection = pendingDetail = null; selectedEdge = undefined;
  panel.textContent = '选择节点或关系查看来源。'; notice.textContent = '';
  view = { x: 0, y: 0, width: 1000, height: 510 }; render(); void pump();
}
function addClaims() {
  if (!page || !input?.include_unverified) return;
  for (const i of page.items) if (!loads.some(l => l.id === i.entity_id && l.collection === 'unverified_claims')) {
    loads.push({ id: i.entity_id, collection: 'unverified_claims', offset: 0, done: false, failed: false });
  }
}
async function pump() {
  if (running || !connected) return;
  running = true;
  try {
    while (connected) {
      const version = requestVersion;
      if (pendingSearch) {
        const operation = pendingSearch; pendingSearch = null;
        searching = true; render();
        try {
          const p = searchPage(output(await app.callServerTool({ name: 'search_contacts', arguments: { ...operation.args } }, { timeout: 30_000 })));
          if (version !== requestVersion) continue;
          const offset = input?.offset ?? 0;
          if (operation.previous) searchedOffsets.pop(); else searchedOffsets.push(offset);
          accept(p, operation.args);
        } catch { if (version === requestVersion) { paused = true; notice.textContent = '搜索失败；保留的是上一查询结果，请重试翻页。'; } }
        finally { searching = false; render(); }
        continue;
      }
      if (pendingDetail) {
        const operation = pendingDetail, ticket = detailVersion; pendingDetail = null;
        readingDetail = { request: operation, version: ticket };
        try {
          const d = await readDetail({ entity_id: operation.id, evidence_offset: operation.offsets.evidence, evidence_limit: 10,
            relation_offset: operation.offsets.relations, relation_limit: 20, claim_offset: operation.offsets.unverified_claims,
            claim_limit: input?.include_unverified ? 20 : 0 });
          if (version !== requestVersion || ticket !== detailVersion) continue;
          selected = d; selection = operation; selectedEdge = operation.edge; notice.textContent = ''; renderDetail();
        } catch { if (version === requestVersion && ticket === detailVersion) {
          notice.replaceChildren(); text(notice, 'span', '所选档案读取失败或不可用；保留此前成功详情。');
          button(notice, '重试详情', () => { pendingDetail = operation; detailVersion++; void pump(); });
        } } finally { readingDetail = null; }
        continue;
      }
      if (!page || paused || waitingResult) break;
      addClaims();
      let load = loads.find(l => !l.done && !l.failed && (l.collection !== 'unverified_claims' || input?.include_unverified));
      if (!load) break;
      const l = load;
      try {
        const d = await readDetail({ entity_id: l.id, evidence_limit: 1,
          relation_limit: l.collection === 'relations' ? 20 : 1, relation_offset: l.collection === 'relations' ? l.offset : 0,
          claim_limit: l.collection === 'unverified_claims' ? 20 : 0, claim_offset: l.collection === 'unverified_claims' ? l.offset : 0 });
        if (version !== requestVersion) continue;
        const next = l.collection === 'name' ? null : nextOffset(d, l.collection, l.offset);
        materials.push({ entity: d.entity, relations: l.collection === 'relations' ? d.relations : [],
          unverified_claims: l.collection === 'unverified_claims' ? d.unverified_claims : [] });
        if (next === null) l.done = true; else l.offset = next;
      } catch (error) { if (version === requestVersion) {
        l.failed = true;
        l.message = error instanceof Error && error.message === 'Unavailable contact' ? '档案现已不可用'
          : error instanceof Error && error.message === 'Non-progressing cursor' ? '分页游标异常' : '读取失败或超时';
      } }
      if (version === requestVersion) render();
    }
  } finally { running = false; render(); }
}
el('stop').onclick = () => { paused = true; render(); };
el('resume').onclick = () => { paused = false; void pump(); };
el('retry').onclick = () => { loads.forEach(l => l.failed = false); paused = false; void pump(); };
function searchMove(previous: boolean) {
  if (!page || !input || waitingResult) return;
  const offset = previous ? searchedOffsets.at(-1) : page.next_offset;
  if (offset === undefined || offset === null) return;
  pendingSearch = { args: { ...input, offset }, previous };
  render(); void pump();
}
el('search-prev').onclick = () => searchMove(true); el('search-next').onclick = () => searchMove(false);
el('fit').onclick = () => { view = { x: 0, y: 0, ...extent }; applyView(); };
function zoom(factor: number) { view = { x: view.x + view.width * (1 - factor) / 2, y: view.y + view.height * (1 - factor) / 2,
  width: Math.max(100, Math.min(50000, view.width * factor)), height: Math.max(100, Math.min(50000, view.height * factor)) }; applyView(); }
el('zoom-in').onclick = () => zoom(.8); el('zoom-out').onclick = () => zoom(1.25);
let drag: { x: number; y: number; vx: number; vy: number } | null = null;
graph.addEventListener('pointerdown', e => { if (e.target !== graph) return; drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; graph.setPointerCapture(e.pointerId); });
graph.addEventListener('pointermove', e => { if (!drag) return; const box = graph.getBoundingClientRect(); view.x = drag.vx - (e.clientX - drag.x) * view.width / box.width; view.y = drag.vy - (e.clientY - drag.y) * view.height / box.height; applyView(); });
graph.addEventListener('pointerup', () => drag = null); graph.addEventListener('pointercancel', () => drag = null);
app.ontoolinput = params => {
  try {
    const args = searchInput(params.arguments);
    const first = hostInput === null; hostInput = args;
    if (first && page && input === null) { input = args; render(); void pump(); }
    else if (page) { requestVersion++; detailVersion++; waitingResult = true; paused = true; pendingDetail = null; notice.textContent = '等待新的搜索结果；当前图为上一查询结果。'; render(); }
  } catch { hostInput = null; notice.textContent = '原查询参数异常，请在聊天重新搜索。'; }
};
app.ontoolresult = params => {
  try { const p = searchPage(output(params)); searchedOffsets = []; accept(p, hostInput); }
  catch { paused = true; notice.textContent = '搜索结果失败或格式异常，保留此前图谱；请在聊天重新搜索。'; render(); }
};
app.onclose = () => { connected = false; requestVersion++; paused = true; notice.textContent = '宿主连接已断开，请在聊天重新打开图谱。'; render(); };
app.onteardown = () => { connected = false; requestVersion++; paused = true; return {}; };
app.removeRequestHandler('ping'); app.setRequestHandler('ping', () => ({}));
if (window.parent === window) {
  progress.textContent = '请在支持 MCP App 的聊天中打开；普通网页不能查询联系人。';
  for (const b of document.querySelectorAll('button')) b.disabled = true;
} else {
  void app.connect(new PrivateHostTransport(), { timeout: 30_000 }).then(() => {
    connected = true; if (!page) progress.textContent = '等待宿主重发搜索结果；若没有结果，请在聊天重新搜索。';
    void pump();
  }).catch(() => { progress.textContent = 'MCP 宿主连接失败或超时，请在聊天查询或重新打开图谱。'; });
}
