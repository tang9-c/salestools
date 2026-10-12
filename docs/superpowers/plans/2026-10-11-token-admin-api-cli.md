# Token Admin API + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在本机通过独立 CLI 管理 MCP Token，免除 Kubernetes 日常访问。

**Architecture:** 现有 Express 服务增加独立鉴权的管理 Router，复用 TokenService 和 SQLite。Node 标准库单文件 CLI 通过 HTTPS 访问；不新增服务或数据库表。

**Tech Stack:** Node 24、TypeScript、Express 5、Zod、node:crypto、node:sqlite、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-11-token-admin-api-cli.md`（执行前完整阅读）。

## Global Constraints

- 禁止在本地执行任何构建操作；native/full-suite/页面 bundle/生产容器 gate 使用 `.github/workflows/contact-upload-validation.yml` 的远程 Ubuntu runner。
- 第一版只有一个运维管理员身份，不新增网页、管理 MCP、OAuth、RBAC、数据库迁移或依赖。
- 保留现有容器 CLI 作为紧急恢复入口。Token 没有有效期，禁用前持续有效。新建 Token 不撤销旧 Token。
- 普通 MCP Token 不可管理 Token；管理员密钥不能直接调用 MCP；不降低 Worker 边界。
- 已授权执行本地实现与提交；发布仍是后续动作，不提交工作区已有无关修改。

## 文件与职责

| 文件 | 变更 |
| --- | --- |
| `src/auth/admin-auth.ts` | 新增摘要校验，固定长度比较 |
| `src/admin/token-router.ts` | 新增三个接口、严格参数/正文限制、管理限流 |
| `src/config.ts`、`.env.example` | 可选摘要配置及映射 |
| `src/db/token-repository.ts`、`src/auth/token-service.ts` | 新增 listPage，保留现有 list/create/disable 行为 |
| `src/mcp/http-app.ts`、`src/index.ts` | 挂载管理 Router、复用 Host 校验和服务实例 |
| `src/logging/logger.ts` | 固定字段审计 |
| `tools/salestools-admin.mjs` | 无依赖独立 CLI |
| `tests/admin-auth.test.ts`、`tests/admin-token-api.test.ts`、`tests/admin-cli.test.ts` | 新增边界、API、CLI 测试 |
| `tests/config.test.ts`、`tests/http-security.test.ts` | 现有配置与 MCP 边界回归 |
| `README.md`、`docs/operations/token-admin.md` | 操作、初始配置、结果未知和回滚说明 |

### Task 1: 独立认证与有界列表

**Interfaces:** `verifyAdminKey(plaintext:string, expectedHash:string):boolean`；`TokenRepository.listPage(offset:number,limit:number):{items:TokenMetadata[],nextOffset:number|null}`；TokenService 提供同签名代理。AppConfig 新增 `tokenAdminKeySha256?:string`。

- [x] 写 `tests/admin-auth.test.ts` 测试，再执行并观察失败：
```ts
const key = 'A'.repeat(43);
const hash = createHash('sha256').update(key).digest('hex');
expect(verifyAdminKey(key, hash)).toBe(true);
expect(verifyAdminKey('B'.repeat(43), hash)).toBe(false);
expect(verifyAdminKey(key, '')).toBe(false);
```
- [x] 在 `tests/config.test.ts` 加入未配置/空白禁用、有效摘要、无效摘要拒绝；沿用 valid fixture：`expect(() => loadConfig({...valid,TOKEN_ADMIN_KEY_SHA256:'invalid'})).toThrow()`。
- [x] 实现摘要校验：输入密钥须为 43 位 base64url；摘要须为 64 位小写 hex；`createHash('sha256').update(plaintext).digest()` 与 `Buffer.from(expectedHash,'hex')` 作 timingSafeEqual。无效格式直接 false，不依赖普通 TokenService.verify。
- [x] 配置在 CONFIG_KEYS、configSchema、AppConfig 映射保持一致：空白映射 undefined，其余严格验证；`.env.example` 只放空值，不能放真实摘要。
- [x] 用内存 DatabaseSync 写分页集成测试：同时间多行稳定排序；limit=1 逐页遍历；末页 nextOffset=null；输出没有 tokenHash；旧 list 顺序与旧 CLI 保持兼容。
- [x] listPage SQL：`SELECT user_id,enabled,created_at FROM tokens ORDER BY created_at,user_id,token_hash LIMIT ? OFFSET ?`，绑定 limit+1 与 offset；多出一行则 nextOffset=offset+limit，返回前 limit 行。方法内也校验分页范围，不能只依赖 HTTP。
- [x] 验证：`npx vitest run tests/admin-auth.test.ts tests/config.test.ts tests/admin-token-api.test.ts`（测试文件中先加入 repository 用例）；`npm run typecheck`。本机若 sqlite runtime 不支持，用 Node24，不触发 native 编译。
- [x] 单独提交认证与分页，审查未暴露 Token hash、未更改旧 Token 行为。

### Task 2: 管理 API 和审计

**Interfaces:** `createTokenAdminRouter({keyHash,service,audit,now?}):Router`；service 消费 `create(userId):string`、`disable(userId):boolean`、`listPage(offset,limit)`；audit 消费设计文档的固定字段。createHttpApp 增加末尾可选 Router 参数，旧五参调用不变。

- [x] 在 `tests/admin-token-api.test.ts` 使用 Express + 本地随机端口、内存 TokenRepository 和真实 TokenService 建立测试；共享凭据 `randomBytes(32).toString('base64url')`，不使用生产配置。先验证未实现时失败：
```ts
const response = await fetch(base + '/admin/v1/tokens', {
  method: 'POST', headers: {Authorization:`Bearer ${adminKey}`, 'Content-Type':'application/json'},
  body: JSON.stringify({userId:'test-sales'})
});
expect(response.status).toBe(201);
const created = await response.json();
expect(service.verify(created.token)).toEqual({userId:'test-sales'});
expect(response.headers.get('cache-control')).toBe('no-store');
```
- [x] 新 Router 依次处理 no-store/requestId、未认证限流、Bearer 管理鉴权、拒绝 Origin、认证后限流，再进入 GET 或受限 JSON POST。限流为固定窗口常量空间，按设计给出 Retry-After，测试使用注入 now，不 sleep。
- [x] Zod 严格定义 userId、分页和正文；实现设计规定的状态码，禁止 JSON parse 默认 HTML 错误回显。无效/压缩正文、错误 Content-Type、数组正文、超大正文、重复 query 都有测试。
- [x] 实现 POST create、GET list、POST disable-user，调用既有服务方法；response 包含 requestId，日志只写白名单字段。异常统一固定码，不传原始 message；认证失败按分钟窗口输出汇总计数（下一窗口有请求时输出，不建后台 timer）。
- [x] 在 JsonlLogger 增加 `logAdminTokenOperation` 固定字段序列化，日志写失败不得把成功数据库操作变成 HTTP 失败。测试恶意 userId 控制符拒绝、Token/adminKey/hash 不在审计文本中。
- [x] `src/index.ts` 有摘要才创建 Router；`createHttpApp` 在现有精确 Host 校验后挂载 `/admin/v1`，无配置时显式对 `/admin` 返回404。MCP/upload 原中间件顺序不动；管理 Host 拒绝使用专用固定码。
- [x] 补权限测试：业务 Token 访问管理401；管理员密钥访问MCP401；无配置404；携带 Cookie/query/body 凭据不授权；Origin403；禁用测试用户全部 Token 后 verify=null；重复禁用 disabled=false；已有上传会话不再授权；已开始请求不要求取消。
- [x] 补故障测试：create 抛错500；audit 抛错仍保留成功响应；所有错误无密钥回显；限流不影响 /healthz 或 /mcp。调用 `/mcp` 使用现有 HTTP security fixture，确认未改变协议行为。
- [x] 验证：`npx vitest run tests/admin-token-api.test.ts tests/http-security.test.ts tests/contact-upload-session-http.test.ts`、`npm run typecheck`；独立提交 API。

### Task 3: 单文件 CLI

**Interfaces:** `tools/salestools-admin.mjs` 导出 `runAdminCli(args,{home,fetch,stdout,stderr}):Promise<number>` 供测试；命令入口使用 process.argv、os.homedir、原生 fetch。home 为依赖注入，不能修改系统 HOME；输出回调用于不泄露凭据的测试。主模块判断使用 pathToFileURL。

- [x] 建立 `tests/admin-cli.test.ts`，动态 import mjs（必要时使用带说明的 @ts-expect-error，不增加全局类型忽略）。fake fetch 记录调用次数和 headers，输出收集器记录 stdout/stderr；每例用临时 home，结束只清理该临时目录。
- [x] 先写关键失败测试：
```ts
expect(await runAdminCli(['token','disable','sales-a'], io)).toBe(2);
expect(fetchMock).not.toHaveBeenCalled();
// io 是上述临时目录、fetch 和输出收集器组成的注入对象。
```
- [x] 实现严格参数解析：setup --url；token create USER；token list [--limit N --offset N]；token disable USER --all。未知命令/选项、重复参数、空 userId 不发送请求。共享接口字段值原样传递。
- [x] setup 独占创建 0700 目录和0600配置，拒绝已有/符号链接配置；生成密钥，stdout 仅显示摘要和部署步骤。读取配置检查 version、url、adminKey、所有权/权限；报错不包含配置内容。检测配置父目录符号链接，避免写往意外位置。
- [x] 请求统一 HTTPS origin、`redirect:'error'`、`AbortSignal.timeout(15000)`、Bearer header、JSON；不重试。响应只解析规定 schema，截断/非 JSON/未知字段不原样输出；限制响应读取到1MiB，超过停止读取并按未知结果处理。
- [x] create stdout 仅密钥，stderr 提示保存；list/disable 只输出白名单 JSON。HTTP明确拒绝退出1；写请求网络/5xx/非法成功响应退出3并提示结果未知；参数配置退出2。非写请求网络失败退出1。stdout 写失败退出3，保留“可能已创建”提示。
- [x] 测试 setup 不覆盖、文件权限、符号链接拒绝、HTTP URL拒绝、重定向拒绝、token 只出现在成功stdout、日志不泄密、429提示、超时只请求一次、500未知、异常正文不回显，以及 --all 的显式范围。使用本地 HTTPS 测试/可注入 fetch 验证，不添加生产 HTTP 绕过开关。
- [x] 验证 `node --check tools/salestools-admin.mjs`、`npx vitest run tests/admin-cli.test.ts`；独立提交 CLI。

### Task 4: 文档、远程 CI 与验收

- [x] 新建 `docs/operations/token-admin.md`，复制设计中的三个命令和 setup 步骤；写明共享管理员身份、无过期时间、全用户禁用、创建结果未知恢复步骤、权限与首次 Secret 配置。README 增加入口链接，不建议本地构建。
- [x] 明确手动轮换配置步骤：备份原配置于0600文件；生成新的32字节密钥及配置；在Sealos只更换摘要；滚动更新完成后执行list；失败回滚旧摘要与配置。不能打印管理员明文到shell命令或日志。
- [x] 执行本地 `npm run typecheck`、上述定向解释器测试、`git diff --check`，审查普通接口行为保持不变；不运行 npm run build/dev 或 cargo/docker 构建。
- [ ] 发布前经现有 Git/CI 流程执行远程 `.github/workflows/contact-upload-validation.yml` 完整检查，使用合成凭据与临时数据库；无需单独新增工作流。验证 standalone CLI 无 node_modules 也能 `node --check` 并输出帮助。
- [ ] 用户授权上线后才部署：先不配置摘要，验证 /admin404 与业务可用；本机setup生成配置，在Sealos注入摘要后验证list。用专用测试用户创建Token，MCP initialize成功，列表无明文，再disable --all并验证新请求401；不输出测试Token到验收文档。
- [ ] 保存 tested SHA、镜像版本、API状态及脱敏审计证据，明确是否真实部署。回滚删除摘要，不删数据库；测试Token需显式禁用。最终提交文档与验收记录。

## 自审结论

- 不新增数据库迁移、安装器、网页、管理MCP或令牌恢复机制；现有功能未移除。
- 覆盖管理/业务凭据隔离、HTTP输入限制、分页、审计、限流、回执丢失、CLI本机密钥和部署回滚。
- 单共享管理员、无单枚撤销、无自动重放是明确边界；不能在实施中暗改为普通Token管理权限。
- Task 1–3 已完成并提交；Task 4 的文档和本地验证完成，远程 CI、部署和真实验收仍未执行。

## 执行记录（2026-10-11 America/Los_Angeles）

- 隔离工作区：`/Users/tang-codeing/.codex/worktrees/token-admin/salestools`，分支 `codex/token-admin-api-cli`，基线 `f442eb551e0baf6068a67903dd2cd9c5b4704657`。
- 提交：`48cdc3f` 认证/分页；`0444cec` API；`5568a49` CLI。
- 认证失败预算只作用于无效凭据，先验证合法凭据，防止攻击者消耗认证失败预算挡住合法管理员。计数最多121，日志不是精确攻击统计。
- setup 独占创建文件，写入失败清理本次创建的文件；已存在配置不改动。
- 新增41项管理员专项测试（2认证/分页、21 API、18 CLI；配置测试另新增1项），加现有鉴权/上传测试，本次指定7文件共171项通过。注意以命令输出总数为准。
- Node 24.19.0 下通过171项；`tsc --noEmit`、`node --check`、CLI帮助和diff检查通过。没有执行本地构建。
- 初次集成测试有测试清理数据库重复关闭，以及隔离工作区缺失Python环境导致预检503，均已查明并修复测试/运行环境后重跑。Host测试改用node:http，避免Node fetch忽略自定义Host造成假结果。
- 完整suite/native/容器门禁与线上实测必须在远程执行；当前未推送、未创建生产管理员密钥、未修改线上配置。
