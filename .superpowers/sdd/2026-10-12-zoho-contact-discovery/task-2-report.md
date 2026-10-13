# Task 2 阻塞报告

状态：BLOCKED，未实现或接入生产适配器。锁定官方 SDK 4.0.0 后，真实 CRM 传输已经违反任务的最多两次尝试预算，按任务原文要求停止。没有放宽预算，没有 REST、新进程或全局原型补丁。

## 可复现的真实 SDK 边界证据

独立验收脚本：`scripts/validate-zoho-sdk-budget.mjs`。

执行 `node --test scripts/validate-zoho-sdk-budget.mjs`，退出 1，1 项失败：

```
Expected at most 2 HTTP attempts; actual SDK attempts: 3
duration_ms 3884.276375
```

脚本创建仅含合成数据的 localhost HTTP 服务，持续返回 503，调用锁定 SDK 的真实 `Initializer.initialize`、`SDKConfigBuilder.timeout(100)` 与 `APIHTTPConnector.fireRequest`。SDK、got 和 HTTP 均未被 mock；没有真实凭证。服务观测到同一次 SDK GET 发送三次 HTTP 请求。脚本最终关闭服务器并清理临时 resourcePath。

初始红灯命令 `npx vitest run tests/zoho-client.test.ts` 同样失败（actual 3 > 2，3823ms）。经控制器要求，证据已移至独立 node:test 验收脚本，避免正常 Vitest suite 永久红。没有生产适配器，也没有虚构绿灯。

SDK 源码原因：`lib/routes/controllers/api_http_connector.js` 的 `fireRequest` 只将 SDK timeout 写入 got requestDetails，未配置 retry，直接 `return got(this.url, requestDetails)`。其依赖 got 11.8.6 对 GET/503 的默认重试为两次，即总共三次发送；业务层再重试一次将可达六次。SDKConfigBuilder 没有 retry 配置项。

本次 100ms 配置约 3.8 秒后返回：timeout 针对各次传输，不能约束 got 重试退避和整个 SDK 操作。立即返回503不触发传输timeout，因此仅剩100ms的共享 deadline 也不能限制本次内部重试。挂起 CRM / OAuth 两类完整超时验收尚未执行，不能声称符合120秒要求。

## 其他关切与最小修复点

- `SDKLogger.initialize(OFF)` 内部调用共享 winston 默认 logger 的 `configure({ silent: true, transports: [...] })`，会替换传输并静默其他使用默认 winston 的应用日志。验收脚本独立 node 进程中使用此配置，仅用于避免测试日志输出；生产不能直接照搬。SDK HTTP toString 当前会替换 Authorization 值，但仍记录请求URL、参数，不能当作已经关闭请求明细日志。生产的局部日志隔离方案尚未验证。
- `Initializer.switchUser()` 直接继承当前 store/resourcePath，不能只调用 switchUser 就声称每连接路径/TokenStore隔离。需要切换时真实重初始化独立路径和store，且验证所有缓存。
- Utility 存在静态 `apiSupportedModule`、`moduleAPIName` 等内存状态，独立 resourcePath 不足以证明内存缓存账号隔离。autoRefreshFields=false 路径不必经过 apiSupportedModule 缓存；本次没有证明发生字段串用，也没有宣称隔离验收通过。
- 可选最小修复是由上游 SDK 在 CRM requestDetails 提供或固定 `retry: { limit: 0 }`，并支持局部SDK logger。也可以单独审批精确受控的依赖修补；本任务明确禁止未经批准的补丁，因此未实施。更换版本同样需重新验证传输预算、隔离及冷启动，不能凭版本号认定修复。

## 安装与依赖增量审计

执行 `npm install --ignore-scripts --save-exact @zohocrm/nodejs-sdk-8.0@4.0.0`，成功新增73包，未执行安装脚本或任何本地构建。package.json及lock精确锁定4.0.0。

`npm audit --json` 退出1，总计9项（moderate 2 / high 4 / critical 3）。控制器提供的基线为7项；增量为SDK链的2项high：

- `form-data@3.0.4`，GHSA-hmw2-7cc7-3qxx，multipart字段名/文件名CRLF注入，修复版本3.0.5，SDK精确依赖3.0.4。
- `@zohocrm/nodejs-sdk-8.0`，通过form-data被计为high，npm报告fixAvailable=false。这是同一条底层advisory产生的两个包级计数，不是两个新增独立漏洞。

其余基线包级项为 @modelcontextprotocol/client、@vitest/mocker、hono、proxy-addr、source-map-js、tinypool、vitest。本次未运行audit fix或修改其他依赖。合成固定字段不能代表已排除form-data漏洞全部可达性。

## 最新验证与交付范围

- `npm run typecheck`：退出0。
- `npx vitest run tests/config.test.ts tests/zoho-contact-contracts.test.ts`：退出0，50/50通过；仅既有SQLite experimental warning。
- 独立SDK预算验收：退出1，预期暴露结构缺陷。
- 未运行本地build/dev/native/docker，未读取真实.env、Token、CRM联系人，未push/merge/publish。
- 新接口/exports：无；生产`src/upstream/zoho/client.ts`尚未创建，服务/wiring尚未接入。
- TokenStore、冷启动metadata scopes、只读安装目录、两连接字段隔离、CRM/OAuth挂起超时和生产close清理等完整验收未完成，不能标记Task2通过。

提交范围仅SDK锁定依赖、独立失败验收脚本及本报告。控制器需要先裁决SDK修复路径，才能恢复Task2实现。
