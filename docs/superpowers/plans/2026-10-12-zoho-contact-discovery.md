# Zoho 多账号联系人查询实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 `discover_contacts`，按公司获取多个 Zoho 连接中的全部关联联系人，一次返回姓名、职位及负责人，不返回联系方式。

**Architecture:** 保留公开网页服务和快照；新增一个 Zoho SDK 适配器和一个公司联系人查询服务。所有 SDK 操作串行执行，结果使用独立 `zoho` 区域，不入图谱、不建表。

**Tech Stack:** 现有 Node.js、TypeScript、Zod、Vitest；官方 `@zohocrm/nodejs-sdk-8.0`。

执行时精确锁定经过测试的 SDK npm 版本；官方 main 当前 package 为 4.0.0，若采用它则固定 `4.0.0` 并核对对应源码，不继续把旧版 README 当作所有版本的实现保证。

**Spec:** [设计文档](../specs/2026-10-12-zoho-contact-discovery-design.md)，第 1–10 节。本计划不实现第 11 节的非 Zoho 联系方式遮蔽。

## 全局约束

- 不修改其他未提交改动；执行前确认 Git 状态，尤其 `src/mcp/contact-search-tools.ts` 等现有改动。
- 禁止本地构建、native 编译和 `npm run dev`；本地只运行解释器测试、类型检查和 diff 检查，构建使用远程 CI。
- 不读取真实 `.env`、不打印凭证；凭证以 `.env` 配置，示例仅空值。
- 内部接入采用 Self Client 授权码流程；首次授权由账号授权人员执行。当前仅生产环境，Refresh Token 按连接绑定账号、组织与区域，不跨连接借用。
- 所有 MCP 用户共用已配置连接的查询权限；不增加用户映射或授权系统。
- 总时限固定 120 秒，包含串行等待；不设 10 人或其他应用总人数截断。
- 不逐人拉详情，不查询电话、邮箱、备注、附件、邮件、子表等额外资料；不透传 SDK 原对象。
- 不新增数据库、任务、管理页面或持久化 CRM 缓存。完成本计划不自动发布、部署或提交用户无关改动。

## 任务 1：配置与结果契约

**文件：** 修改 `src/config.ts`、`.env.example`、`src/mcp/tool-schemas.ts`；新增 `src/contracts/zoho-contact.ts`、`tests/zoho-contact-contracts.test.ts`；补充 `tests/config.test.ts`。

**接口：**

```ts
type ZohoConnection = {
  id: string; name: string; region: 'CN' | 'US' | 'EU' | 'IN' | 'AU' | 'CA';
  clientId: string; clientSecret: string; refreshToken: string;
};
type ZohoQuery = {
  query: string; connectionIds?: string[];
  accountRecords?: Array<{ connectionId: string; accountId: string }>;
};
```

输出固定 `status: completed | needs_confirmation | partial | failed`、`complete`、`connections`、`companies`、`warnings`、`collected_at`。公司含 `connection_id`、`account_id`、`company_name`、`account_owner`、`contacts`；联系人含 `record_id`、`name`、`title`、`contact_owner`、`modified_at`。负责人只含 `id`、`name`，空值允许为 null。连接状态含 `completed | needs_confirmation | failed | partial`、候选及脱敏错误码。

候选固定 `{ account_id, company_name, account_owner }`；连接状态增加 `search_complete: boolean`，用于明确候选搜索是否完整。联系人和客户来源由所在公司及连接定位，不额外创建图谱 ID。

- [ ] 先写契约测试：超过 10 人可解析；Zoho 联系人对象中的 `email`、`phone` 被 strict Schema 拒绝；旧网页结果仍满足原 Schema。
- [ ] 运行 `npx vitest run tests/zoho-contact-contracts.test.ts tests/config.test.ts`，确认新增断言失败。
- [ ] 增加 Zod 契约及可选 Zoho 配置。连接标识只接受小写字母开头、字母数字下划线组成的标识；如 `crm_a` 映射 `ZOHO_CRM_A_*`。无连接配置返回空列表，缺项/重复/未知区域给不含凭证的错误。
- [ ] 扩展 discover 输入 `source` 默认 `web`、`zoho_accounts`、`zoho_account_records`。拒绝 web 请求附带 Zoho 选择参数、重复选择项及选择项不属于选定连接的情况。保留原网页 query/region 输入行为，不修改现有公共联系人 Schema 的人数限制。
- [ ] 同组测试通过后运行类型检查；只暂存本任务明确修改的文件，提交一个独立契约改动。

## 任务 2：SDK 只读适配器与账号隔离

**文件：** 新增 `src/upstream/zoho/client.ts`、`tests/zoho-client.test.ts`；修改 `package.json`、`package-lock.json`。

**接口：**

```ts
type ZohoCallContext = { deadlineAt: number; signal: AbortSignal };
type ZohoCursor = { page: number } | { pageToken: string };
// 每个方法返回已按字段白名单投影的值。
// searchAccountsPage(connectionId, query, page, context)
//   -> { accounts: ZohoAccount[], moreRecords: boolean }
// getAccount(connectionId, accountId, context) -> ZohoAccount
// getContactsPage(connectionId, accountId, cursor, context)
//   -> { contacts: ZohoContact[], moreRecords: boolean, nextPageToken: string | null }
```

`ZohoAccount` 对应任务 1 客户候选，`ZohoContact` 对应任务 1 联系人结构；`page` 为正整数，`per_page` 固定 200。服务和适配器共享 context，禁止各页重新计算新的 120 秒期限。

- [ ] 用注入的 SDK 调用替身写测试：两个并发请求的 switch/request 不交错；失败后下一请求仍可执行；Owner 内嵌邮箱不出适配器；客户搜索正确转义特殊字符。
- [ ] 运行 `npx vitest run tests/zoho-client.test.ts` 验证失败。
- [ ] 安装并锁定官方 SDK 依赖，确认安装不触发本地构建；通过小型内存 TokenStore 管理运行期 Token，不使用默认文件或 MySQL 存储。源码按官方 `RecordOperations`、关联记录操作、初始化和 `switchUser()` 接口实现，不复制未经验证的方法名。
- [ ] 在系统临时目录创建 0700 的 SDK 根目录，为每连接建立独立 resourcePath；适配器 `close()` 在当前串行操作收尾后清理目录，由应用关闭逻辑调用。初始化不可写时只令 Zoho 不可用，不阻断 web。关闭 SDK 请求明细日志，元数据文件不包含 Token 或联系人数据。
- [ ] 用锁定 SDK 的真实初始化/解析代码、可控测试 HTTP 替身做冷启动集成测试：空 resourcePath 首次调用、元数据 scopes、只读安装目录、两连接字段文件隔离及 close 清理。不能仅用完全 mock 的 SDK 声称已覆盖元数据行为。SDK 数据中心/请求替身仅用于测试，生产不开放任意地址配置。
- [ ] 适配器单例使用一个 Promise 链串行保护 SDK 操作：

```ts
private tail: Promise<unknown> = Promise.resolve();
private serial<T>(context: ZohoCallContext, operation: () => Promise<T>): Promise<T> {
  const run = this.tail.then(() => {
    if (context.signal.aborted || Date.now() >= context.deadlineAt) {
      throw new Error('ZOHO_DEADLINE_EXCEEDED');
    }
    return operation();
  });
  this.tail = run.then(() => undefined, () => undefined);
  return run;
}
```

- [ ] 排队等待返回用 context.signal 的中止监听完成拒绝，清理监听；即便调用方已经返回，tail 仍绑定实际 run，不能绑定等待者的超时 Promise。覆盖过期出队不执行 operation、超时后仍在途时另一连接不切换的测试。
- [ ] 每次 switch/init 使用 `SDKConfigBuilder.timeout(Math.min(15000, context.deadlineAt - Date.now()))`；剩余时间非正则不操作。Token 实例的 getResponse 做局部委托封装，把 `timeout: { request: 剩余时间上限 }`、`retry: { limit: 0 }` 传给原 SDK 方法，关闭 findUser；不能只设置 CRM 超时而漏掉独立 OAuth got 请求。加 CRM 请求挂起和刷新挂起两个真实传输超时测试；测明锁定 SDK 内建重试次数，若它超过约定业务调用上限须停止报告，不放宽时间限制或修改全局 got/SDK 原型。
- [ ] 用固定字段白名单投影账号和联系人；联系人列表使用 `per_page=200`，遵循 page/page_token 互斥；单次瞬时错误最多业务重试一次，权限/授权错误不重试。不启用非必要 SDK 后台刷新及用户查询。
- [ ] 同组测试通过，运行类型检查并提交适配器改动。远程 CI 验证 SDK 安装及运行兼容性；如 SDK 无法满足隔离或真实请求超时，报告具体限制，不静默改成 REST 或新增进程。
- [ ] 增加 SDK TokenStore 测试：有效 Access Token 复用、过期刷新一次、重启后基于配置 Refresh Token 刷新、同 Client ID 的不同连接不串 Token、授权撤销不循环刷新、不触发默认凭证文件落盘。

## 任务 3：公司确认、全量分页与部分失败

**文件：** 新增 `src/contacts/zoho-contact-service.ts`、`tests/zoho-contacts.test.ts`。

**接口：** `ZohoContactService.get(input: ZohoQuery)` 返回任务 1 的 Zoho 输出；依赖任务 2 客户端、可注入时间源。服务不依赖 ContactLibrary、快照仓库或 Ark。

- [ ] 用客户端替身写测试：唯一完整名称匹配、简称候选、多客户、无匹配、0 人、201 人、2001 人、重复页、第二连接失败、第二页失败、过期排队、记录选择与 query 不符。
- [ ] 增加搜索完整性测试：第二页同名客户不判唯一；到 2000 条仍 moreRecords 时 search_complete=false，不自动获取联系人；搜索失败有候选则允许用户选择，无候选明确 failed。
- [ ] 运行 `npx vitest run tests/zoho-contacts.test.ts` 验证失败。
- [ ] 按设计顺序先收集所有选定连接候选。只有规范化名称唯一完全匹配才自动确定；一处存在歧义，返回 `needs_confirmation`，不开始任何 Zoho 全量联系人读取。按用户确认的连接与记录再次调用时，不查询未选择记录。
- [ ] 公司搜索逐页读取至完成或 Search Records 2000 条限制；search_complete=false 的已见匹配不算唯一。用户记录选择重新检查存在、连接及读取权限，并按规范化名称包含 query 判断，不要求完全相等；非子串品牌简称用候选全名重新提交。测试简称确认成功、其他公司 ID 拒绝、全名重试成功，以及 complete 仅指显式选择范围。
- [ ] 逐连接逐客户连续分页，以接口完成信号停止；超过 2000 人使用下一页 Token。检测重复游标/不前进分页，返回 partial 而不是无限循环。去重键 `${connectionId}:${recordId}`，不按姓名去重。
- [ ] 结果累积后一次返回；单页或连接失败保留所得结果。所有连接成功才 `complete=true`，空结果也是成功；时限到期为 partial 或 failed，不假装全量。无管理人姓名显示“未提供”，空姓名显示“姓名未提供”，不推断当前在职。
- [ ] 服务入口创建 `deadlineAt = Date.now() + 120000` 和中止控制器；总定时器到期后中止调用者等待、冻结结果副本并返回当时 partial/failed，不等待在途 SDK 收尾。finally 清理定时器；每个 await 后及重试/新页前检查 context，不能在返回后追加结果。测试用可控时钟和不立即完成的底层请求分别证明按时返回、禁止后续业务调用和不串账号。
- [ ] 日志只包含连接标识、阶段、页数、数量、耗时及脱敏错误码。通过测试、类型检查后提交此任务。

## 任务 4：接入工具与端到端验收

**文件：** 修改 `src/index.ts`、`src/mcp/tools.ts`、`README.md`、`docs/PRD.md`；新增 `src/contacts/zoho-contact-renderer.ts`、`tests/zoho-contact-renderer.test.ts`、`tests/zoho-discover-tools.test.ts`；补充 `tests/contacts.test.ts`。

- [ ] 先写工具测试，校验 web 原路径完全兼容、zoho 独立结果、all 单源失败不抹去另一来源、未配置 Zoho 时 web 正常且 zoho 明确不可用。
- [ ] 运行 `npx vitest run tests/zoho-discover-tools.test.ts tests/contacts.test.ts` 验证失败。
- [ ] 在 index 创建 SDK 单例和 Zoho 服务，通过现有 McpServices 注入；web 继续调用原 `getContacts`。输出 Schema 为旧网页结果与可选 `zoho` 区域的兼容扩展，zoho-only 返回旧区域空值及真实 Zoho 结果，不伪造网页来源。
- [ ] 实现纯函数 `renderZohoContacts(result)` 返回 Markdown；Zoho/all 的 content 使用文本渲染，structuredContent 使用原契约数据，web-only 保持现状。按公司分组输出客户负责人一次及全部姓名/职位/联系人负责人；候选同时给确认所需 connection_id/account_id（仅候选操作处显示），正常联系人表不输出内部 ID。对 Markdown 表格管道、换行及链接文字转义，不让业务字段形成可执行或伪造内容。
- [ ] 渲染测试覆盖 201 人数量一致、空结果、候选、partial/failed、负责人不同/空值和特殊字符；工具测试确认 content 不是内部 ID 密集 JSON，structuredContent 保留完整来源标识，all 保留网页来源结果与警告。
- [ ] 不修改 `src/mcp/contact-search-tools.ts` 的现有未提交图谱 App 改动。不把 Zoho 写入网页快照、SQLite 或图谱；工具说明明确来源和完整性。
- [ ] 更新 README 与 PRD：环境变量、最小只读 scopes、公司候选确认、全部联系人一次返回、共享连接权限及没有电话邮箱。记录 search scope `ZohoSearch.securesearch.READ`；关闭 findUser 时不额外申请 users/org 权限。
- [ ] 在 README 补充首次授权操作：对应区域 API Console → Self Client → 只读 scopes → 短期授权码 → POST 请求体交换 Refresh Token → 服务端环境配置；不展示真实 Token，不提供把凭证写进 URL/shell 历史的示例。说明授权撤销后的重新授权、Sealos 环境注入、生产环境限制及外部客户须使用 Server-based OAuth 的边界。授权人员操作不成为 MCP 工具或授权页面。
- [ ] 同步文档 scopes：除业务只读及搜索权限外加入首次 SDK 初始化的 `ZohoCRM.settings.fields.READ`、`ZohoCRM.settings.modules.READ`、`ZohoCRM.settings.related_lists.READ`，不要申请 settings.ALL、users/org 或写权限。README 说明临时 resourcePath、启动不可写的 Zoho 降级和关闭清理。
- [ ] 运行新增测试和既有配置、MCP 契约测试、`npm run typecheck`、`git diff --check`；完整测试及构建使用现有远程 CI，不启动发布。
- [ ] 用户提供专用测试授权后，查询获准公司，逐连接对照 CRM UI 数量、姓名、职位、两类负责人；在真实 MCP 宿主确认完整响应无电话邮箱，并记录 SHA、连接化名、数量和脱敏结果。不能只用 mock 声称真实验收成功。

## 收尾

- [ ] 自查设计第 1–10 节覆盖；单独列明未完成的真实验收或 SDK 限制。
- [ ] 文档与代码 diff 不包含用户无关改动，合并及发布另行取得指示。
