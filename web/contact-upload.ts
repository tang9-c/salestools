import { App } from '@modelcontextprotocol/ext-apps';
import { parseJSONRPCMessage, type Transport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import type { ImportCandidate, ContactEvidence, ReviewItem } from '../src/contracts/index.js';
import type { MatchSuggestion } from '../src/contacts/identity-match.js';

type Session = { sessionId: string; bearer: string; base_url: string };
type Preview = { import_id: string; status: string; version: number; total_candidates: number;
  candidates: ImportCandidate[]; warnings: string[]; match_suggestions: MatchSuggestion[];
  match_suggestions_truncated: boolean; processed_block_ids: string[]; unprocessed_block_ids: string[];
  coverage_available: boolean; confirmation?: { allowed: boolean; reasons: string[] };
  source?: Record<string, unknown> | null; offset: number; limit: number };
type Phase = 'waiting' | 'uploading' | 'extracting' | 'review' | 'committed' | 'failed';
type Retry = 'start' | 'preview' | 'receipt' | null;
const status = document.querySelector<HTMLElement>('#status')!;
const review = document.querySelector<HTMLElement>('#review')!;
const previewBox = document.querySelector<HTMLElement>('#preview')!;
const manual = document.querySelector<HTMLElement>('#manual')!;
const taskId = document.querySelector<HTMLElement>('#task-id')!;
const fileName = document.querySelector<HTMLElement>('#file-name')!;
const recovery = document.querySelector<HTMLElement>('#recovery')!;
const commit = document.querySelector<HTMLButtonElement>('#commit')!;
const defer = document.querySelector<HTMLButtonElement>('#defer')!;
const resume = document.querySelector<HTMLButtonElement>('#resume')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const exit = document.querySelector<HTMLButtonElement>('#exit')!;
const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const cameraInput = document.querySelector<HTMLInputElement>('#camera')!;
let session: Session | null = null;
let app: App | null = null;
let importId = '';
let version = 0;
let receiptVersion: number | null = null;
let busy = false;
let generation = 0;
let retryAction: Retry = null;
const externalSessionKey = 'contact-upload-session';

// The SDK's default postMessage transport logs full packets, including session
// credentials. Keep its public Transport contract and schema validation without logs.
class PrivateHostTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private readonly receive = (event: MessageEvent): void => {
    if (event.source !== window.parent) return;
    let message: JSONRPCMessage;
    try { message = parseJSONRPCMessage(event.data); }
    catch { this.onerror?.(new Error('Invalid host message')); return; }
    this.onmessage?.(message);
  };
  async start(): Promise<void> { window.addEventListener('message', this.receive); }
  async send(message: JSONRPCMessage): Promise<void> { window.parent.postMessage(message, '*'); }
  async close(): Promise<void> { window.removeEventListener('message', this.receive); this.onclose?.(); }
}

function say(message: string, phase: Phase): void {
  status.textContent = message;
  document.body.dataset.state = phase;
}
function remember(value: unknown): void {
  if (typeof value !== 'string' || !value) return;
  importId = value;
  taskId.hidden = false;
  taskId.textContent = `导入任务编号：${importId}。可复制到聊天中继续核对。`;
}
function selectFiles(enabled: boolean): void { fileInput.disabled = cameraInput.disabled = !enabled; }
function offerRetry(action: Retry): void {
  retryAction = action;
  retry.hidden = !action;
  retry.disabled = !action;
  retry.textContent = action === 'receipt' ? '重试确认回执' : action === 'start' ? '继续识别已接收文件' : '重新加载预览';
}
function current(ticket: number): boolean { return ticket === generation && session !== null; }
function loseSession(message: string): void {
  generation++;
  session = null;
  receiptVersion = null;
  selectFiles(false);
  commit.disabled = true;
  defer.hidden = resume.hidden = true;
  exit.disabled = true;
  offerRetry(null);
  say(message, 'failed');
  recovery.textContent = '请在聊天中使用上方任务编号查询进度，或重新打开上传入口建立新会话。App 刷新无法恢复原会话。';
}
class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
function friendly(error: unknown): string {
  if (!(error instanceof ApiError)) return '连接中断，请检查网络后重试。';
  if (error.httpStatus === 401 || error.httpStatus === 403) return '上传会话已失效、退出或被撤销，请在聊天中重新打开上传入口。';
  if (error.code === 'UPLOAD_SESSION_CAPACITY') return '服务上传会话容量暂时已满，请稍后在聊天中重新打开上传入口。';
  if (['CAPACITY_FULL', 'TEMP_CAPACITY_FULL', 'UPLOAD_SESSION_CAPACITY', 'UPLOAD_HANDOFF_CAPACITY'].includes(error.code)) {
    return '服务容量暂时已满，请稍后重试；入口容量不足时请在聊天中重新打开上传入口。';
  }
  const messages: Record<string, string> = {
    CONTACT_RATE_LIMITED: '操作过于频繁，请等待一分钟后重试当前步骤；不要重复上传已接收的文件。',
    UNSUPPORTED_FILE: '文件格式不支持，请选择 PDF、JPEG 或 PNG 图片。',
    FILE_TOO_LARGE: '文件过大，请压缩文件或选择更小的 PDF／图片。',
    ENCRYPTED_PDF: 'PDF 已加密，请先解除密码后重新选择。',
    PDF_PAGE_LIMIT: 'PDF 页数过多，请拆分为较小文件后重新选择。',
    IMAGE_PIXELS_EXCEEDED: '图片尺寸过大，请缩小图片后重新选择。',
    INVALID_DOCUMENT: '文件无法读取，请重新导出 PDF 或拍摄清晰图片。',
    UPLOAD_ALREADY_USED: '此会话已经接收文件，请继续核对原任务，或在聊天中重新打开入口。',
    MANUAL_REVIEW_REQUIRED: '存在可能重复或不完整的资料，请在聊天中人工核对。',
    IMPORT_COMMIT_FAILED: '提交未能确认，请在聊天中使用任务编号查询结果。',
  };
  return messages[error.code] ?? '处理未完成，请使用任务编号在聊天中查询，或重试当前步骤。';
}
function failure(error: unknown, action: Retry = null): void {
  commit.disabled = true;
  if (error instanceof ApiError && [401, 403].includes(error.httpStatus)) { loseSession(friendly(error)); return; }
  say(friendly(error), 'failed');
  offerRetry(action);
}
async function api(path: string, options: RequestInit = {}, credential = session): Promise<Response> {
  if (!credential) throw new ApiError('UPLOAD_SESSION_UNAUTHORIZED', 401);
  const headers = new Headers(options.headers);
  if (credential.bearer) headers.set('Authorization', `Bearer ${credential.sessionId}.${credential.bearer}`);
  else if (credential.sessionId) headers.set('X-Upload-Session', credential.sessionId);
  const response = await fetch(`${credential.base_url}${path}`, {
    ...options, headers, credentials: credential.bearer ? 'omit' : 'same-origin',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { code?: string; import_id?: string };
    if (session === credential) remember(data.import_id);
    throw new ApiError(data.code ?? 'REQUEST_FAILED', response.status);
  }
  return response;
}

const names: Record<string, string> = {
  name: '姓名／名称', alternateName: '别名', description: '简介', telephone: '电话', email: '邮箱',
  address: '地址', url: '网址', sameAs: '其他主页', jobTitle: '职位', skills: '技能', legalName: '法定名称',
  nativePlace: '籍贯', hobbies: '兴趣', maritalStatus: '婚姻情况', instantMessaging: '即时通信',
  platform: '平台', accountId: '账号', contactPoint: '联系方式', contactType: '联系方式归属',
  givenName: '名字', familyName: '姓氏', additionalName: '其他名字', honorificPrefix: '称谓', honorificSuffix: '称谓后缀',
  birthDate: '出生日期', deathDate: '逝世日期', gender: '性别', nationality: '国籍', birthPlace: '出生地',
  homeLocation: '居住地', workLocation: '工作地点', knowsAbout: '熟悉领域', knowsLanguage: '语言', award: '奖项',
  hasOccupation: '职业', hasCredential: '资质', faxNumber: '传真', image: '图片地址',
  disambiguatingDescription: '辨识说明', identifier: '标识', propertyID: '标识类别', value: '值',
  credentialCategory: '资质类别', educationalLevel: '教育程度', role: '任职', roleName: '职务', startDate: '开始日期', endDate: '结束日期',
  Person: '人物', Organization: '机构', Project: '项目',
  missing_evidence: '缺少可定位证据', quote_mismatch: '引用与原文不一致', ambiguous_context: '上下文不明确',
  invalid_shape: '信息格式待核对', ambiguous_owner: '所属人物不明确', structured_heading: '仅根据章节标题推测',
  missing_direct_statement: '缺少直接陈述', worksFor: '任职于', alumniOf: '毕业于', memberOf: '参与',
  located: '已定位原文', unavailable: '无法定位原文', not_applicable: '无需原文定位',
  self_phone: '本人电话相同', email_match: '邮箱相同', instant_messaging: '即时通信账号相同', same_name: '姓名相同，身份待核对', name_with_organization: '姓名与同一机构相同，可能重复',
  file: '文件', web: '网页', manual: '人工资料',
};
function label(key: string): string { const simple = key.replace(/^(properties|extensions|metadata)\./u, ''); return names[simple] ?? simple; }
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join('；');
  if (typeof value === 'object') return Object.entries(value).filter(([key]) => key !== '@type')
    .map(([key, item]) => { const text = valueText(item); return text ? `${label(key)}：${text}` : ''; }).filter(Boolean).join('，');
  return String(value);
}
// Every untrusted filename, OCR quote, model value, warning and server field is a text node.
function line(parent: HTMLElement, tag: string, text: string): HTMLElement {
  const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
}
function fields(parent: HTMLElement, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    const text = valueText(value); if (text) line(parent, 'p', `${label(key)}：${text}`);
  }
}
function evidence(parent: HTMLElement, proof: ContactEvidence): void {
  line(parent, 'p', `${label(proof.field_path)}证据：${proof.quote ?? valueText(proof.value)}${proof.page ? `（第 ${proof.page} 页）` : ''}；${label(proof.locator_status)}${proof.file_name ? `；文件：${proof.file_name}` : ''}${proof.source_url ? `；来源：${proof.source_url}` : ''}`);
}
function reviewItem(parent: HTMLElement, item: ReviewItem): void {
  line(parent, 'p', `待核对：${item.kind === 'field' ? `${label(item.field_path)}：${valueText(item.value)}` : `${item.source_candidate_id} ${label(item.relation_type)} ${item.target_candidate_id}；${valueText(item.properties)}`}；${label(item.reason)}${item.page ? `；第 ${item.page} 页` : ''}${item.quote ? `；原文：${item.quote}` : ''}`);
}
function render(first: Preview): void {
  previewBox.replaceChildren();
  const sourceName = first.source?.file_name ?? first.source?.filename;
  if (typeof sourceName === 'string') line(previewBox, 'p', `原始文件：${sourceName}`);
  const processed = [...new Set(first.processed_block_ids ?? [])];
  const unprocessed = [...new Set(first.unprocessed_block_ids ?? [])];
  line(previewBox, 'p', first.coverage_available === true
    ? `提取覆盖：已处理 ${processed.length} 个文本块；未处理 ${unprocessed.length} 个文本块。`
    : '提取覆盖未知：缺少完整的处理记录，无法核实原件的已处理／未处理范围。');
  if (unprocessed.length) line(previewBox, 'p', `尚未处理：${unprocessed.join('、')}。原件提取不完整，请在聊天中核对。`);
  for (const warning of new Set(first.warnings)) line(previewBox, 'p', `任务警告：${warning}`);
  for (const candidate of first.candidates) {
    const item = document.createElement('article'); item.className = 'item'; previewBox.append(item);
    line(item, 'h3', `${label(candidate.label)}：${candidate.properties?.name ?? '未识别姓名／名称'}`);
    fields(item, candidate.properties ?? {});
    if (candidate.label === 'Person') fields(item, candidate.extensions ?? {});
    line(item, 'p', candidate.can_commit ? '可作为入库候选；请核对以下证据。' : '资料不足，不能直接入库。');
    for (const warning of candidate.warnings ?? []) line(item, 'p', `候选警告：${warning}`);
    for (const proof of candidate.evidence ?? []) evidence(item, proof);
    for (const relation of candidate.relation_suggestions ?? []) {
      line(item, 'p', `关系建议：${relation.source_candidate_id} ${label(relation.relation_type)} ${relation.target_candidate_id}；${valueText(relation.properties)}${relation.uncertain ? '；关系不确定' : ''}${relation.review_reason ? `；${label(relation.review_reason)}` : ''}`);
      for (const proof of relation.evidence) evidence(item, proof);
    }
    for (const field of candidate.review_items ?? []) reviewItem(item, field);
  }
  if (!first.candidates.length) line(previewBox, 'p', '未识别到可导入联系人。');
  for (const suggestion of first.match_suggestions) {
    line(previewBox, 'h3', `可能重复：${suggestion.candidateName || suggestion.candidateId} ↔ ${suggestion.existingName || '已有联系人'}（${suggestion.entityId}）`);
    for (const reason of suggestion.reasons ?? []) line(previewBox, 'p', `匹配线索：${reason.kind === 'email' ? '邮箱相同' : label(reason.kind)}：${reason.value}`);
    if (suggestion.existingUpdatedAt) line(previewBox, 'p', `已有联系人更新时间：${suggestion.existingUpdatedAt}`);
    if (suggestion.candidateSourceDate) line(previewBox, 'p', `候选资料采集时间：${suggestion.candidateSourceDate}`);
    if (suggestion.existingJobTitle) line(previewBox, 'p', `已有职位：${suggestion.existingJobTitle}`);
    for (const difference of suggestion.fieldDifferences ?? []) {
      line(previewBox, 'p', `字段差异：${label(difference.fieldPath.replace(/^(properties|extensions)\./, ''))}；已有：${valueText(difference.existingValue)}；新资料：${valueText(difference.candidateValue)}。合并默认保留已有值，替换需明确确认。`);
    }
    for (const [heading, sources] of [['候选资料来源', suggestion.candidateSources], ['已有资料来源', suggestion.existingSources]] as const) {
      for (const source of sources ?? []) line(previewBox, 'p', `${heading}：${label(source.sourceType)}；${source.fileName ?? source.sourceUrl ?? '未标注名称'}；采集时间：${source.collectedAt}`);
    }
  }
  for (const reason of first.confirmation?.reasons ?? []) line(previewBox, 'p', `需要人工核对：${reason}`);
  if (first.match_suggestions.length) line(previewBox, 'p', '请在聊天中选择：合并到已有联系人、新建独立联系人或跳过本次候选。信息不足时可暂不决定；匹配线索不代表已确认同一人。');
  review.hidden = false;
}
async function loadPreview(ticket: number, reconfirm = false): Promise<void> {
  commit.disabled = true;
  offerRetry(null);
  let first: Preview;
  for (;;) {
    first = await (await api('/contact-upload/import')).json() as Preview;
    if (!current(ticket)) return;
    remember(first.import_id);
    if (['ready_for_review', 'committed', 'failed', 'cancelled'].includes(first.status)) break;
    say('正在提取联系人，请稍候…', 'extracting');
    await new Promise(resolve => setTimeout(resolve, 1800));
    if (!current(ticket)) return;
  }
  version = first.version;
  receiptVersion = null;
  render(first);
  defer.hidden = first.status !== 'ready_for_review';
  resume.hidden = true;
  commit.disabled = first.confirmation?.allowed !== true;
  manual.textContent = first.status === 'committed' ? '联系人已写入共享联系人库。'
    : commit.disabled ? '请使用任务编号在聊天中人工核对，确认导入暂不可用。'
      : reconfirm ? '预览已更新，请重新核对全部资料，再点击确认导入。' : '请核对全部识别资料，确认后写入共享联系人库。';
  if (first.status === 'committed') say('导入完成。', 'committed');
  else if (['failed', 'cancelled'].includes(first.status)) say('识别未完成，请在聊天中使用任务编号查询或重新打开上传入口。', 'failed');
  else say(reconfirm ? '预览已更新，请重新核对后确认。' : '识别完成，请核对预览。', 'review');
}
async function startImport(ticket: number): Promise<void> {
  const result = await (await api('/contact-upload/import', { method: 'POST' })).json() as { import_id?: string };
  if (!current(ticket)) return;
  remember(result.import_id);
  await loadPreview(ticket);
}
async function start(): Promise<void> {
  const match = /^#code=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (match || location.pathname === '/contact-upload') {
    session = { sessionId: '', bearer: '', base_url: location.origin };
    recovery.textContent = '尚未确认的外部页面可在 Cookie 会话有效期间刷新并继续原任务；会话失效后请回到聊天使用任务编号。';
    if (match) {
      const exchanged = await (await api('/contact-upload/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: match[1] }) })).json() as { session_id?: string };
      if (!exchanged.session_id || !/^[A-Za-z0-9_-]{43}$/.test(exchanged.session_id)) throw new ApiError('UPLOAD_SESSION_UNAUTHORIZED', 401);
      // Store only the selector; authentication remains in the per-session HttpOnly cookie.
      sessionStorage.setItem(externalSessionKey, exchanged.session_id);
      history.replaceState(null, '', location.pathname);
    }
    session.sessionId = sessionStorage.getItem(externalSessionKey) ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(session.sessionId)) throw new ApiError('UPLOAD_SESSION_UNAUTHORIZED', 401);
    exit.disabled = false;
    const ticket = generation;
    try { await startImport(ticket); return; }
    catch (error) {
      if (!current(ticket)) return;
      if (!(error instanceof ApiError) || error.code !== 'UPLOAD_REQUIRED') { failure(error, 'start'); return; }
    }
  } else {
    const ticket = generation;
    recovery.textContent = '当前 App 入口建立新会话。刷新或关闭后无法恢复原会话；请保留任务编号，在聊天中查询原任务或重新打开入口。';
    app = new App({ name: 'Salestools 联系人上传', version: '1.0.0' });
    app.removeRequestHandler('ping');
    app.setRequestHandler('ping', () => ({}));
    app.onclose = () => loseSession('App 连接已断开，请回到聊天继续处理。');
    app.onteardown = () => {
      const revoke = session ? api('/contact-upload/exit', { method: 'POST' }) : null;
      loseSession('App 已关闭，请回到聊天继续处理。');
      // The host must receive its protocol acknowledgement even if revocation
      // is slow or unreachable. Keep the transport open until the host unmounts.
      if (revoke) void revoke.catch(() => undefined);
      return {};
    };
    await app.connect(new PrivateHostTransport());
    if (ticket !== generation) return;
    const result = await app.callServerTool({ name: 'create_contact_upload_session', arguments: {} });
    const value = result.structuredContent as Session | undefined;
    if (ticket !== generation) {
      // A session created during teardown must never become usable by this page.
      if (value?.sessionId && value.bearer && value.base_url) {
        void api('/contact-upload/exit', { method: 'POST' }, value).catch(() => undefined);
      }
      return;
    }
    if (!value?.sessionId || !value.bearer || !value.base_url) {
      const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') ?? '';
      if (text.includes('CAPACITY')) throw new ApiError('UPLOAD_SESSION_CAPACITY', 429);
      throw new ApiError('UPLOAD_SESSION_UNAUTHORIZED', 401);
    }
    session = value;
    exit.disabled = false;
  }
  selectFiles(true);
  say('请选择一份文件。', 'waiting');
}
async function upload(file: File): Promise<void> {
  if (busy || !session || fileInput.disabled) return;
  busy = true;
  const ticket = generation;
  selectFiles(false);
  offerRetry(null);
  fileName.textContent = `已选择文件：${file.name}`;
  let accepted = false;
  try {
    say('正在上传并检查文件…', 'uploading');
    const body = new FormData(); body.append('file', file);
    await api('/contact-files', { method: 'POST', body });
    if (!current(ticket)) return;
    accepted = true;
    say('正在提取联系人…', 'extracting');
    await startImport(ticket);
  } catch (error) {
    if (!current(ticket)) return;
    // A definite rejected upload can be selected again. An ambiguous transport failure
    // must first recover the session's fixed import; it never blindly re-uploads the file.
    const rejected = !accepted && error instanceof ApiError && !['UPLOAD_ALREADY_USED'].includes(error.code);
    failure(error, rejected ? null : importId ? 'preview' : 'start');
    if (rejected && session) selectFiles(true);
  } finally {
    fileInput.value = cameraInput.value = '';
    busy = false;
  }
}
async function confirm(previewVersion: number): Promise<void> {
  if (busy || !session) return;
  busy = true;
  const ticket = generation;
  commit.disabled = true;
  offerRetry(null);
  receiptVersion = previewVersion;
  say('正在写入联系人…', 'review');
  try {
    const result = await (await api('/contact-upload/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_version: previewVersion }) })).json() as { import_id: string; status: string; version: number };
    if (!current(ticket)) return;
    if (result.status !== 'committed' || result.import_id !== importId || !Number.isSafeInteger(result.version)) throw new Error('Invalid receipt');
    remember(result.import_id);
    receiptVersion = null;
    manual.textContent = '联系人已写入共享联系人库。';
    defer.hidden = resume.hidden = true;
    say('导入完成。', 'committed');
  } catch (error) {
    if (!current(ticket)) return;
    if (error instanceof ApiError && error.code === 'PREVIEW_VERSION_CHANGED') {
      receiptVersion = null;
      try { await loadPreview(ticket, true); }
      catch (refreshError) { if (current(ticket)) failure(refreshError, 'preview'); }
    } else if (!(error instanceof ApiError)) {
      say('连接中断，尚未收到确认回执。可点击重试确认回执，使用同一版本查询原次确认结果。', 'failed');
      manual.textContent = '请保留任务编号；若回执仍不可恢复，请在聊天中查询原任务。';
      offerRetry('receipt');
    } else {
      receiptVersion = null;
      failure(error);
      manual.textContent = '请在聊天中使用上方导入任务编号查询结果。';
    }
  } finally { busy = false; }
}
async function retryCurrent(): Promise<void> {
  if (busy || !session || !retryAction) return;
  const action = retryAction;
  if (action === 'receipt' && receiptVersion !== null) { await confirm(receiptVersion); return; }
  busy = true;
  const ticket = generation;
  offerRetry(null);
  try {
    say('正在重新加载原任务…', 'extracting');
    if (action === 'preview') await loadPreview(ticket);
    else await startImport(ticket);
  } catch (error) {
    if (current(ticket)) {
      if (action === 'start' && error instanceof ApiError && error.code === 'UPLOAD_REQUIRED') {
        selectFiles(true); say('服务尚未接收文件，请重新选择文件。', 'waiting');
      } else failure(error, importId ? 'preview' : action);
    }
  } finally { busy = false; }
}
async function leave(): Promise<void> {
  if (!session || exit.disabled) return;
  // Invalidate asynchronous callbacks immediately, while retaining the credential
  // only long enough for the authorized server-side revocation request.
  generation++;
  selectFiles(false); commit.disabled = true; exit.disabled = true; offerRetry(null);
  say('正在退出上传会话…', 'failed');
  const pending = api('/contact-upload/exit', { method: 'POST' });
  if (!session.bearer) sessionStorage.removeItem(externalSessionKey);
  session = null; receiptVersion = null;
  try { await pending; say('已退出上传会话。', 'failed'); }
  catch { say('已关闭本页操作；服务端退出未确认，请回到聊天查询任务。', 'failed'); }
  finally {
    recovery.textContent = '请保留任务编号。退出不撤销已经写入的联系人；需要继续时请回到聊天重新打开上传入口。';
    if (app) { app.onclose = undefined; await app.close().catch(() => undefined); app = null; }
  }
}
fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) void upload(fileInput.files[0]); });
cameraInput.addEventListener('change', () => { if (cameraInput.files?.[0]) void upload(cameraInput.files[0]); });
commit.addEventListener('click', () => { if (!commit.disabled) void confirm(version); });
retry.addEventListener('click', () => { if (!retry.disabled) void retryCurrent(); });
exit.addEventListener('click', () => { void leave(); });
defer.addEventListener('click', () => {
  if (busy || !session || document.body.dataset.state !== 'review') return;
  commit.disabled = true;
  defer.hidden = true;
  resume.hidden = false;
  offerRetry(null);
  manual.textContent = '暂不决定，尚未入库。保留任务编号，可在聊天中继续核对；预览按现有保留规则处理，上传会话仍可能到期。';
});
resume.addEventListener('click', () => {
  if (busy || !session || resume.hidden) return;
  busy = true;
  const ticket = generation;
  resume.hidden = true;
  void loadPreview(ticket, true).catch(error => { if (current(ticket)) failure(error, 'preview'); })
    .finally(() => { busy = false; });
});
const startupGeneration = generation;
void start().catch(error => { if (startupGeneration === generation) failure(error); });
