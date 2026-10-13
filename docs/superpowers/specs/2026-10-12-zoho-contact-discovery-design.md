# Zoho 多账号客户联系人查询设计

日期：2026-10-12

状态：任务1–4已实现，远程完整CI（含生产容器验证）通过，已合并到本地main；真实CRM及真实MCP宿主验收尚未完成，未发布。

## 1. 目标与边界

扩展现有 `discover_contacts`：按公司查找 Zoho CRM 客户记录，再获取其关联的全部联系人，一次返回结果。

“全部”指关联联系人的人数，不是全部 CRM 字段。只返回姓名、职位、公司、客户负责人、联系人负责人及来源信息；不请求或返回联系人电话、邮箱，不返回负责人电话、邮箱。

已确认取舍：

- 使用官方 Node.js SDK 8.0。
- 可接入多个 Zoho 授权账号，连接凭证由 `.env` 管理。
- 所有 MCP 用户共享已配置连接的查询权限，不按 MCP 用户绑定 Zoho 账号。
- Zoho 不受现有每家公司 10 人限制；后端完成分页，一次返回，不要求用户逐页调用。
- 不自动入联系人图谱，不回写 Zoho，不自动合并跨连接同名联系人。
- 不包含备注、附件、邮件、活动、商机、子表或其他关联资料；不逐个联系人读取完整详情。
- 不增加管理页面、同步任务、新数据库表或新进程。

## 2. 官方资料与实际限制

参考资料：

- [Node.js SDK 8.0](https://github.com/zoho/zohocrm-nodejs-sdk-8.0/blob/main/versions/1.0.0/README.md)
- [Get Records](https://www.zoho.com/crm/developer/docs/api/v8/get-records.html)
- [Search Records](https://www.zoho.com/crm/developer/docs/api/v8/search-records.html)
- [Get Related Records](https://www.zoho.com/crm/developer/docs/api/v8/get-related-records.html)
- [Self Client 授权说明](https://www.zoho.com/developer/oauth/self-client/overview.html)
- [客户端类型选择](https://www.zoho.com/crm/developer/docs/api/v8/register-client.html)
- [Access Token 刷新要求](https://www.zoho.com/crm/developer/docs/api/v8/refresh.html)
- [SDK 请求超时配置源码](https://github.com/zoho/zohocrm-nodejs-sdk-8.0/blob/main/lib/routes/sdk_config_builder.js)
- [SDK OAuth 请求源码](https://github.com/zoho/zohocrm-nodejs-sdk-8.0/blob/main/lib/models/authenticator/oauth_token.js)
- [SDK 字段元数据处理源码](https://github.com/zoho/zohocrm-nodejs-sdk-8.0/blob/main/lib/utils/util/utility.js)

API 使用要点：

- `Accounts` 搜索定位客户；`Accounts/{id}/Contacts` 读取关联联系人。
- 搜索文本字段的 `equals` 可能表现为包含匹配；返回客户须在应用侧核对，不能把搜索命中等同于主体确认。
- 关联记录请求需要明确 `fields`；每页最多 200 条，超过 2000 条须按接口要求使用 `page_token`。以 `more_records` 和下一页信息判断完成，不能只取第一页。
- 分页 Token 属于授权用户及请求上下文，不能跨连接或变更查询参数复用。
- `Owner` 是 CRM 内部负责人，不是客户企业的所有者、实控人或联系人上级。
- Get Records 的详情与关联列表不同，部分复杂字段需要额外接口；本次采用字段白名单，避免“全部信息”的错误承诺。

SDK 使用要点：

- 使用 `@zohocrm/nodejs-sdk-8.0`，不采用已归档的 `zcrm-nodejs-sdk`。
- SDK 文档的多账号方式为 `switchUser()`，并要求同一时间仅一个授权用户发请求。所有 Zoho SDK 调用共用一个进程内串行执行入口，覆盖切换账号到请求完成，避免两个 MCP 请求交错使用凭证。
- SDK 可根据 Refresh Token 刷新 Access Token。静态凭证从 `.env` 加载；使用最小内存 TokenStore 保存运行期 Token，重启后重新刷新，不新增凭证数据库或落盘 Token 文件。
- 关闭非必要的 SDK 用户身份查询及后台字段刷新，避免隐式扩大权限、调用和跨账号上下文。相关配置名称及行为须在实现时通过 SDK 测试确认。
- 使用并精确锁定经验证的 SDK npm 版本。SDK 首次调用仍可能获取字段、模块和关联列表元数据；关闭后台刷新不能代替首次元数据初始化。
- 2026-10-12用户批准SDK 4.0.0最小依赖修补：关闭CRM/OAuth隐式got重试、隔离SDK专用logger、SDK范围override升级form-data至3.0.5。控制器进一步裁决元数据文件名从可逆Token片段Base64改为SHA-256、查询参数值从encodeURI改为encodeURIComponent，均属于原隔离/特殊字符要求的必要修复。使用已检入文本替换清单和原文件SHA-256，安装时幂等修补，版本或文件不符失败；启动校验只检查字节，不联网、不修改依赖。
- SDK `switchUser()`继承store/resourcePath，适配器逐次用官方`initialize()`重建当前上下文以保持每连接目录及内存TokenStore独立；调用保持进程全局串行。SDK配置实例的`getTimeout()`按共享deadline动态读取剩余时间，约束冷启动内部各次metadata/CRM传输，不修改任何全局原型。
- 应用启动时在系统临时目录用 `mkdtemp` 建立 SDK 运行根目录，每个连接使用独立子目录和 `resourcePath`，禁止使用 node_modules 或工作目录的默认路径。目录权限为 0700，关闭应用时清理；目录不可写时禁用 Zoho 并返回明确错误，不影响原网页功能。目录只保存 SDK 元数据，不保存 Token 或 CRM 联系人数据。
- SDK 日志采用关闭请求明细的配置，不沿用默认请求日志；冷启动验证同时检查元数据 scopes、路径隔离和无 Token 泄露。元数据读权限限定 `ZohoCRM.settings.fields.READ`、`ZohoCRM.settings.modules.READ`、`ZohoCRM.settings.related_lists.READ`，不申请 settings.ALL 或任何写权限。

## 3. MCP 输入与兼容性

保留 `discover_contacts` 工具，不新增一套查询工具。

新增输入：

```json
{
  "query": "公司名称",
  "source": "zoho",
  "zoho_accounts": ["crm_a", "crm_b"],
  "zoho_account_records": [
    { "connection_id": "crm_a", "account_id": "客户记录ID" }
  ]
}
```

- `source`：`web | zoho | all`，默认 `web`。
- `zoho_accounts`：可选；缺省查询全部已配置连接；未知连接返回输入错误，不静默忽略。
- `zoho_account_records`：可选；用于用户确认搜索候选后再次调用。指定时只查询这些客户记录，不再扩展到其他同名客户。
- 选定客户记录必须属于已选连接，并重新读取其名称和归属；记录不存在或无权限时不查询联系人。重新核验按下述“用户选择”规则，不再次要求 query 与客户全名完全一致。
- 原有 `query`、`region_hint` 保留；`region_hint` 不解释成 Zoho 数据中心。
- `source=web` 维持现有结果结构、电话邮箱禁出、人数限制及缓存行为。
- Zoho 新增结果在独立 `zoho` 区域返回，不把 CRM 联系人塞入现有网页快照或受 10 人限制的数组。
- `source=all` 分别返回网页与 Zoho 结果，互不替代；同名公司不自动跨来源合并。

## 4. 公司匹配与获取流程

1. 遍历已选连接，搜索 `Accounts` 的客户名称，只对外投影客户标识、名称、负责人以及必要的公司核对信息。公司搜索同样分页，按每页 200 条读取至 `more_records=false`，遵守 Search Records 的 2000 条搜索限制；达到限制而仍有后续、分页失败或超时，标记搜索不完整，不根据已见结果自动确认唯一客户。
2. 名称做 Unicode、空白规范化；不删除可能区分法定主体的地区或公司后缀。
3. 只有搜索完整、且只有一个规范化名称完全匹配的客户记录时，才能自动确定客户。只有简称命中、多个完全匹配记录或多个相似候选时，返回候选供用户确认；搜索不完整时显示已取得候选及限制，不宣称唯一或全量。没有取得任何候选的搜索失败按 failed 处理。
4. 不凭品牌、简称自动认定法定主体；Zoho 客户记录不是企查查的主体认证结果。
5. 有任一连接需要确认时，本次不开始 Zoho 联系人全量获取，先返回各连接候选及状态，避免用户误以为已经查询了全部来源。其他来源结果可独立返回。
6. 客户明确后，按每页 200 人连续读取关联 `Contacts`，保持同一连接、客户及 fields 不变。
7. 在每个客户结果组内按“连接标识＋联系人记录 ID”消除分页重复；同一联系人记录出现在不同客户组时，各组均保留，以忠实呈现原始客户归属。代价是同一记录可能在多个客户组重复展示，不另建关系结构。全部成功后统一组织为一次 MCP 响应。

用户选择规则：用户明确提供 `zoho_account_records` 即表示选择对应记录。重新核验该记录确实属于该连接、存在且可读，客户名称至少满足首次搜索的规范化包含关系；不要求全名等于 query。简称并非名称子串时，使用实际候选的客户全名重新提交 query 和记录 ID，不增加有状态确认会话。选择后的 complete 只针对明确选择的记录及连接，不代表覆盖首次搜索的所有潜在客户。

全局需要确认时，文本列出每个连接的状态及候选确认参数，包含其他连接已唯一匹配但尚未读取联系人的记录；提示将所有希望保留的记录一起提交。显式选择后 `connections` 只列实际选择的连接，仍校验声明的全部连接标识，不能把未查询连接标为完成。

字段白名单：

- 客户：`id`、`Account_Name`、`Owner`；必要核对字段只用于匹配，不扩大默认展示。
- 联系人：`id`、`Full_Name`、`First_Name`、`Last_Name`、`Title`、`Account_Name`、`Owner`、`Modified_Time`。
- 从 SDK 字段映射读取，不经过 LLM；姓名组合仅作显示兜底，不能编造职位。
- SDK 返回的 `Owner` 等对象可能含邮箱，因此必须投影成姓名和内部记录标识，不能透传原对象。
- 联系人职位为空仍保留；姓名为空保留记录并显示“姓名未提供”。负责人不可读或为空显示“未提供”。

## 5. 输出与来源

Zoho 区域包含：

- `status`：`completed | needs_confirmation | partial | failed`。
- `complete`：仅所有选定连接的全部分页成功时为 `true`。
- `connections`：连接标识、显示名称、执行结果、错误或候选。
- `companies`：客户名称、客户负责人、所属连接、客户记录标识、联系人数组。
- 每位联系人：姓名、职位、联系人负责人、CRM 记录标识、记录修改时间和来源。
- `warnings`：未完成分页、连接失败及可见范围限制。
- `collected_at`：本次采集时间。

没有匹配客户或客户没有关联联系人是成功的空结果，不能当作服务失败。来源只声明“Zoho CRM 记录”，不标为已核实当前在职。

聊天展示按公司分组：客户负责人显示一次，联系人显示姓名、职位及联系人负责人；不将内部 ID 密集展示给用户。结构化结果保留来源定位标识。

Zoho/all 调用的 MCP `content` 返回确定性 Markdown 文本，包含来源、完整性/错误提示、候选或按公司分组的完整联系人表；`structuredContent` 返回同一数据的 JSON。渲染不得删减联系人。web-only 保留原文本行为。不增加 App，也不要求调用方 LLM 自行把 JSON 改写成展示。Markdown 对单元格和候选中的特殊字符做转义。

不新增总人数截断。大量结果仍受服务时间与宿主响应容量约束；不能静默删人、让 LLM 挑选代表联系人或把局部结果标为全量。响应过大导致宿主不接受属于未完成交付，不能宣称验收成功。

## 6. 多来源身份处理

此前“姓名＋公司＋个人联系方式一致即可聚合”的想法不用于本轮：本轮不读取联系方式，缺少该判定依据。

- 同一连接同一联系人 ID 只表示同一 CRM 记录。
- 不同连接，即便姓名、公司相同，也保留独立来源记录，不自动认定同一人。
- 同一 CRM 组织使用多个授权账号时可能产生重复结果，本轮同样保留连接来源，不增加组织级身份识别。
- 负责人不成为联系人图谱节点或 `worksFor` 关系。

## 7. 配置与授权

```dotenv
ZOHO_CONNECTIONS=crm_a,crm_b

ZOHO_CRM_A_NAME=业务团队A
ZOHO_CRM_A_REGION=CN
ZOHO_CRM_A_CLIENT_ID=
ZOHO_CRM_A_CLIENT_SECRET=
ZOHO_CRM_A_REFRESH_TOKEN=

ZOHO_CRM_B_NAME=业务团队B
ZOHO_CRM_B_REGION=US
ZOHO_CRM_B_CLIENT_ID=
ZOHO_CRM_B_CLIENT_SECRET=
ZOHO_CRM_B_REFRESH_TOKEN=
```

连接标识使用简单 ASCII 标识，前缀确定性映射到环境变量；区域映射 SDK 生产数据中心。凭证缺项、重复连接或未知区域必须明确报配置错误。没有配置 Zoho 时，现有网页功能仍可使用。

采用 Accounts/Contacts 读取与搜索所需最小权限，包括 Search Records 文档要求的 `ZohoSearch.securesearch.READ`；不申请写权限。使用配置账号本身的可见范围，不能绕过 Zoho 权限。部署方明确接受所有 MCP 用户均可查询这些共享连接。

### 首次授权：Self Client 授权码流程

本次限定公司自行管理的 CRM 账号及内部后台接入，采用 Zoho 官方支持的 Self Client authorization code flow，不采用浏览器 JavaScript 客户端或 Client Credentials 流程。

1. 每个连接由对应 CRM 账号的授权人员在所在数据中心的 Zoho API Console 创建或选择 Self Client，获得 Client ID 和 Client Secret。
2. 指定 `ZohoCRM.modules.accounts.READ`、`ZohoCRM.modules.contacts.READ`、`ZohoSearch.securesearch.READ` 及 SDK 初始化所需的 `ZohoCRM.settings.fields.READ`、`ZohoCRM.settings.modules.READ`、`ZohoCRM.settings.related_lists.READ`，在需要选择组织时确认目标 CRM 组织及生产环境。关闭 findUser，不额外申请 users/org 权限。
3. 生成短期授权码，并在其有效期内向对应区域的 Zoho Accounts Token endpoint 换取 Access Token 和 Refresh Token。交换通过 POST 请求体提交凭证，不把凭证放入示例 URL、聊天、日志或 shell 历史。
4. 仅将 Client ID、Client Secret、Refresh Token 及对应区域写入服务端 `.env` 或部署环境变量；授权码不保存为运行配置。此配置不包含 Zoho 登录密码。
5. 每个连接的 Refresh Token 都须来自其正确授权账号、组织、区域及环境；不因多个连接使用同一 OAuth 应用就复用同一个 Refresh Token。

### 运行期刷新与部署

- SDK 使用 Refresh Token 按需获取和刷新短期 Access Token，并在内存 TokenStore 内保存 Token 及过期时间；同一连接在有效期内复用，不每次查询重新获取。
- 自定义内存 TokenStore 实现 SDK 的必要接口，明确阻止默认 Token 文件落盘；进程重启后从环境配置重新刷新。内存存储是本项目取舍，不是 Zoho 官方强制要求。
- 当前仅使用 PRODUCTION 数据环境；凭证不能跨数据中心、组织或生产/沙箱环境混用，不新增沙箱配置。
- 无效或被撤销的 Refresh Token 按连接明确失败，不无限重试，不自动借用另一连接凭证。重新授权或修改环境凭证后重启服务。
- Sealos 使用同名环境变量注入；真实 `.env` 不进入 Git、Docker build context 或镜像。
- 不建设 OAuth 回调页面或连接授权 UI。将来接入外部客户自有 CRM 时须另行设计 Server-based OAuth 授权流程，不要求外部客户直接提供 Refresh Token。
- 共用授权账号的 CRM 可见范围不是各 MCP 用户的 Zoho 权限；本版不声称继承每位销售的 CRM 权限。
- 普通npm ci通过postinstall自动修补；两处Docker npm ci之前复制补丁脚本及清单。ignore-scripts开发安装后显式执行`npm run postinstall`。任务4创建已配置的Zoho适配器前应调用`verifyZohoSDKPatch()`；失败只禁用Zoho并报告脱敏错误，不影响web-only。适配器首次SDK初始化也强制校验，未修补不能发CRM请求。

`.env` 不提交 Git；示例文件只放空值。日志仅记录连接标识、阶段、耗时、数量、页数与脱敏错误码，不记录 Token、完整 CRM 响应、联系人列表或负责人邮箱。

## 8. 失败、时间与完整性

- 无权限、授权撤销、配置错误不重复尝试；瞬时网络或服务错误最多重试一次。SDK 自动刷新 Token 与业务重试不得形成无限重试。
- 单连接失败不抹去其他连接结果；分页失败保留已取得联系人，并返回 `partial`、`complete=false` 和明确警告。
- 查询总时间上限首版固定为 120 秒，从 Zoho 服务入口计算 `deadlineAt`，覆盖排队、搜索、元数据、刷新、重试和联系人分页。每个适配器方法均接收同一调用上下文 `{ deadlineAt, signal }`；等待队列时可因截止时间结束调用，尚未执行的项目随后出队时跳过，不发请求。
- 每次进入 SDK 操作前设置 `SDKConfigBuilder.timeout(min(15000, 剩余毫秒))`，实际请求超时由 SDK 底层传输执行，不把 Promise.race 当作请求终止。OAuth 刷新不自动继承该配置，须对每连接 Token 实例的 `getResponse(url, requestDetails)` 做局部封装，传入同一剩余时间上限和 `retry.limit=0`，仍委托 SDK 原方法执行刷新；不修改全局原型或 OAuth 协议。SDK 内建重试行为通过锁定版本测试核对，不能与业务重试叠加成无界调用。
- 服务总截止时间到达后立即返回当时已取得结果及 partial/failed，冻结输出，阻止后续业务调用和结果写入。若某个 SDK 操作尚未完成，串行锁仍等待它结束；此时其他请求可以排队超时，不能切换账号与在途操作交错。单个 SDK 操作内可能包含自动元数据步骤，该收尾不表示用户仍须等待。初次测试须验证这些内部步骤最终受底层超时约束；无法满足时停在验收失败，不声称已达到 120 秒约定。
- 总定时器和工作路径检查先观察到截止时间时，共用一次性截止收尾，均保留已取得候选、联系人和真实截止错误；输入错误及其他异常不伪装成截止结果。
- 全部连接不可用且没有结果时为 `failed`；需要确认时为 `needs_confirmation`；部分不可用或未完成为 `partial`。
- 不新建后台任务、恢复游标或分页查询工具。超大客户不能在同步上限内完成时，如实提示，本轮不承诺任意规模的无限全量交付。
- Zoho 每次实时只读，不写网页缓存、不复用网页 30 天快照、不新增 CRM 数据存储。

## 9. 必要验证

- 原网页路径契约、缓存及 10 人限制不回归。
- 两个 Zoho 连接交错调用时，账号、Token、分页上下文不串用。
- 公司包含匹配、简称、多候选、重复客户记录必须进入确认路径；确认后仅查询选定记录。
- 0、1、超过 10、超过 200 人均完整返回；模拟超过 2000 人覆盖 Token 分页。
- 白名单结果不含电话、邮箱及 Owner 内嵌邮箱，不透传 SDK 原对象。
- 客户与联系人负责人不同、字段为空均正确展示；不产生任职关系。
- 同名跨连接记录保留；同记录分页重复不重复展示。
- 单连接失败、某页失败、授权撤销、串行等待超时及请求超时均如实标记完整性。
- 验证只读调用，不写 Zoho、SQLite 快照或联系人图谱。
- 使用获得授权的真实公司，逐连接对照 Zoho 界面关联联系人数量、姓名、职位和负责人；确认全部分页成功且 MCP 宿主实际收到完整结果。
- 公司搜索第二页存在同名记录、搜索达到 2000 条且未完成、搜索中途失败时不自动判断唯一；用户确认简称后按包含关系通过，非子串简称用候选全名重新确认。
- 排队超过 120 秒按时返回且不发请求；CRM 请求和 OAuth 刷新分别超时；返回后在途操作不能释放账号保护或修改已返回结果。
- 空临时目录、只读应用安装目录的首次 SDK 查询实际完成元数据初始化；连接目录独立、缺少元数据 scope 明确报错，关闭应用清理目录且不留下凭证文件。
- Markdown 与 structuredContent 联系人数量一致；文本不密集显示内部 ID，包含两类负责人及所有 partial/needs_confirmation 提示，特殊字符不会破坏表格。

验收仅在真实授权与测试公司准备好后进行；本设计研究未调用实际 CRM，也未验证真实字段权限或宿主大响应容量。

## 10. 延期内容

联系人入图谱、跨连接身份合并、电话邮箱读取、CRM 回写、实时同步、账号管理页面、后台全量任务及其他关联资料读取均不在本次范围。

## 11. 补充：其他来源联系方式的四位遮蔽

本节记录后续讨论确认的展示规则，适用于简历、名片、文字及网络来源已保存的专用联系方式字段；不改变 Zoho 查询的字段白名单，也不让公开网页 `discover_contacts` 开始返回联系方式。

### 范围与权限取舍

- 姓名、公司、职位和资料管理人等信息正常展示。
- 电话、邮箱、微信号、QQ 等专用联系方式字段统一部分遮蔽，对所有 MCP 用户一致，包括资料保存者。
- 不增加 MCP 授权、申请、批准、撤销或管理员解锁流程。
- 不为本规则增加 `userId ↔ CRM Owner` 对应表；CRM 负责人继续作为显示信息，不决定联系方式可见性。
- 数据库存储的原值保留，不因展示遮蔽修改原始数据或身份匹配依据。

### 确定性遮蔽规则

在后端输出边界处理，不把原值发给 App 再由前端替换：

1. 去除值首尾空白，以 Unicode 码点计算字符数。
2. 电话、微信号、QQ 等：长度大于 4 时，从 `floor((长度 - 4) / 2)` 的零基位置开始，将连续 4 个字符替换为 `****`，其他字符保留。
3. 邮箱：仅对 `@` 前的本地部分按上述规则处理，保留 `@` 及域名；没有可解析的邮箱分隔符时按普通字符串处理。
4. 被处理部分长度为 1–4 时，将其全部替换为同数量的星号，不保留原字符。空值仍为空，不生成虚假的联系方式。
5. 对每次输出从数据库原值生成遮蔽结果，不将遮蔽结果回写数据库或再次叠加处理。

示例：

| 类型 | 原值示例 | 对外显示 |
|---|---|---|
| 手机 | `13812345678` | `138****5678` |
| 邮箱 | `zhangsan@example.com` | `zh****an@example.com` |
| 微信 | `wx_zhangsan88` | `wx_z****an88` |
| 短标识 | `abc` | `***` |
| 短邮箱本地部分 | `ab@example.com` | `**@example.com` |

### 输出覆盖与已知风险

- 专用字段进入 MCP 返回、联系人详情、搜索结果、图谱 App、导出或 LLM 输入前，统一使用遮蔽值；不能在结构化结果、字段证据副本等位置同时附带该字段的原值。
- 本版不扫描、脱敏原始简历文本、名片图片、自由文本备注或证据摘录中的联系方式；该旁路处理明确延期，不因此改变原有资料读取行为。
- 部分遮蔽保留较多信息，可能被识别、匹配或还原，不能称为匿名化或可靠的防泄漏机制。
- 本节仅是专用字段的展示遮蔽，不是按持有人划分的访问控制，不提供“A 可以完整看自己的联系方式”的例外。

补充验收：上述示例、长度 0–4、奇偶长度、Unicode 字符及空值结果确定；各专用字段输出出口无原值；数据库原值未改写；原公开网页路径继续禁止联系方式；Zoho 结果继续不包含电话、邮箱及 Owner 内嵌邮箱。原文等旁路风险仍明确存在。
