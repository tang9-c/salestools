# Task 2 SDK 验证报告

当前状态：任务2已实现并通过本地解释器测试；下文保留首次阻塞证据及批准后恢复记录。远程CI、生产生命周期接入及真实CRM/宿主验收仍待后续任务。

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

## 2026-10-13 批准后恢复与交付

用户已批准最小SDK依赖修补；控制器已批准元数据文件名SHA-256及参数值encodeURIComponent。补丁清单位于`patches/zoho-sdk-4.0.0.json`，脚本`scripts/patch-zoho-sdk.mjs`先校验4.0.0版本及全部10个原文件SHA-256再写入，重复执行接受完整已修补字节；未知变更/版本、漏补丁均失败。脚本不构建或联网。清单覆盖CRM/OAuth retry.limit=0、SDK各处独立named logger、SDKLogger仅配置该专用logger、Utility与Converter一致的不可逆文件名及HTTP参数值编码。

package.json的postinstall确保普通npm ci自动应用；Dockerfile两stage在npm ci前复制脚本与清单。开发采用npm ci --ignore-scripts后显式执行npm run postinstall。局部环境曾出现ENOSPC，未删除用户数据；以npm ci --ignore-scripts --offline --maxsockets=1成功重装后重新执行修补，并重新运行全部Task2验证。offline命令的0 vulnerabilities不是审计证据。

在线`npm audit --json`现为7项（moderate 2 / high 2 / critical 3），与原基线一致。SDK范围override固定form-data 3.0.5，SDK/form-data两项新增high已消除，未修改其他基线依赖。

新增`src/upstream/zoho/client.ts` exports：ZohoClient、ZohoAccount、ZohoCallContext、ZohoCursor、ZohoSDKBridge/ZohoSDKPage、OfficialZohoSDKBridge、MemoryZohoTokenStore、verifyZohoSDKPatch。三个读接口与brief一致，返回snakecase白名单。生产仅官方PRODUCTION区域；测试通过protected environmentFor子类选择localhost，不向环境配置开放任意地址。

所有实例共享实际SDK Promise链。每个连接独立内存TokenStore和0700目录；官方initialize重建账号上下文，避免switchUser继承store/path。close拒绝新调用，并等待真实在途操作结束后清理目录。等待者同时响应signal与deadline定时器，返回不释放SDK锁，过期出队不执行初始化。SDK配置实例getTimeout与每个OAuth Token实例getResponse局部闭包均读取同一绝对deadline；无全局原型改写。业务瞬时错误最多重试一次，权限/授权错误不重试。

最新 focused 验证：`npx vitest run tests/zoho-client.test.ts tests/zoho-sdk-integration.test.ts tests/zoho-sdk-patch.test.ts`共20/20通过；`npm run typecheck`退出0；`node scripts/patch-zoho-sdk.mjs`退出0；`node --test scripts/validate-zoho-sdk-budget.mjs`退出0（真实单次SDK发送现为1次，约300ms含模块加载）。

最终联合回归同时包含`tests/config.test.ts tests/zoho-contact-contracts.test.ts`，5文件70/70通过；既有SQLite ExperimentalWarning未变化。`npm run postinstall`实际执行安装hook并通过幂等检查，`git diff --check`通过。

真实SDK集成测试并未mock SDK/got/传输：localhost合成CRM/OAuth服务，SDK真实初始化、metadata读取/写入、记录解析。已覆盖空目录首次fields与related_lists、scope拒绝、不查询users/org、递归只读SDK安装文件树、两连接各自字段文件且不串Connection_a/b、filename为64位hex且文件内容无合成Token/联系人、close清理；同ClientID不同refresh各自Token、有效Access复用、过期刷新一次、重启重新刷新、授权撤销不循环。实际挂起CRM/OAuth socket通过got超时收尾；冷启动metadata消耗deadline后，后续传输按实时剩余时间限制（修复前120ms deadline耗时219ms红灯，修复后绿灯）。参数值含&/+/\#时，服务端criteria/page_token完整且没有额外参数。真实CRM持续503仅两次业务请求，复用一个accessToken。

补丁测试覆盖要求先补、幂等、文件tamper/hash失配、错误版本、缺脚本失败以及SDK OFF不替换/静默应用默认winston日志。注入适配器测试覆盖switch/request不交错、取消后在途锁、过期排队跳过、失败链恢复、白名单Owner邮箱禁出、criteria语法字符转义、page/page_token互斥、空字段保留及不可写临时目录只令Zoho不可用。

生命周期边界：Task2导出check-only的verifyZohoSDKPatch供Task4在配置Zoho连接时启动调用；本任务没有改index或接工具/服务。首次SDK使用也强制校验，漏修补不能发CRM请求。Task4必须完成启动降级及close调用，当前不宣称应用生命周期已接入。

本地未构建、运行dev/native/docker、读取真实.env/凭证/联系人、push/merge/publish。metadata modules scope在标准Accounts/Contacts路径没有实际触发，文档保留为允许的只读初始化权限；没有声称真实组织权限或宿主容量已验收。远程CI安装/构建兼容性及真实CRM对照仍未完成。
