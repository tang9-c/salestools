# salestools 快速入门

这份指南覆盖联系人本地文件上传、共享图谱，以及 Codex 客户端的 MCP 注册和原有五个工具。它假设 salestools 服务端已经部署，并且你已经拿到服务端的 HTTPS 地址和个人 Bearer Token。

## 你需要准备什么

- Codex CLI 已安装并能正常运行。
- salestools MCP 地址， `https://oojyeijszmwy.sealosbja.site/mcp`。
- 管理员为你创建的 Token。Token 明文只在创建时显示一次。
- 你的销售用户标识，例如 `sales-qx`。

MCP 注册不会替你部署服务端，也不会创建 Token。服务端地址和 Token 缺一不可。

## 批量上传本地联系人文件

联系人导入功能启用后，可在本仓库目录运行上传 CLI。它只接受本地 PDF、JPG、JPEG、PNG 文件，每个文件最多 20 MB。先构建，再设置完整上传地址与个人 Token，最后依次列出文件路径：

```bash
npm run build
export CONTACT_UPLOAD_URL='https://你的服务域名/contact-files'
export CONTACT_UPLOAD_TOKEN='粘贴管理员提供的 Token'
npm run contacts:upload -- ./简历.pdf ./名片.png
```

CLI 逐个上传并输出 JSON：`accepted` 列出已接收的本地路径和 `file_id`，`unuploaded` 列出失败文件及尚未尝试的文件。容量满额时以非零状态结束；请记录已接收的 `file_id`，待服务端释放名额后自行重试 `unuploaded` 中的路径。上传不会自动发起联系人抽取、等待名额或续传。Token 只从 `CONTACT_UPLOAD_TOKEN` 环境变量读取，不要作为命令行参数传入。

上传成功后，在启用了 `CONTACT_GRAPH_ENABLED=true` 的服务中，使用返回的 `file_id` 调用 `import_contacts`，并自定一个以后重试仍保持不变的 `operation_id`。再用 `get_contact_import` 查看状态、候选和短证据。核对姓名、单位、任职时间、联系方式及可能重复的人之后，使用 `commit_contact_import` 的 `choices` 为每个候选选择 `create`、`merge` 或 `skip`；合并还需目标 `entity_id` 和当前版本。关系同样要核对，必要时填写 `relation_choices`。提交时使用预览返回的 `preview_version`，且 `operation_id` 固定为 `contact-import:<import_id>`。不准备提交时可用 `cancel_contact_import`；系统不会因号码相同而自动合并，也不会把 OCR 推测直接写成正式档案。

无真实姓名和手机号的简历也可审核入库：候选须有已定位的技能等业务字段证据，或有明确归属、已选择的任职／就读关系及其短引文。审核后用同一 `commit_contact_import` 创建匿名 `Person`，不要填写“未知姓名”等占位 `name`。通过 `search_contacts({query:"公司名"})` 或 `search_contacts({query:"学校名"})` 查找已确认 `worksFor`／`alumniOf` 关系中的匿名人物；结果的 `name` 为 `null`，`display_name` 是由稳定 ID 派生的界面文字。使用返回的 `entity_id` 调用 `get_contact` 查看资料和证据。确认真实姓名后，用 `save_contact` 在同一 `entity_id` 上补录 `name` 与证据。只看到机构名、没有明确人物归属时，不选择机构关系；同一批次出现多名无名人物且没有各自独立的字段证据时，系统也不会分配机构关系。不同简历不会自动合并，原件及完整 OCR 文本不会持久化到图谱。

预览将已定位字段放在 `properties`，缺证据、求职意向或归属不明的线索放在 `review_items`；栏目支持的关系会带 `uncertain=true` 和原因。一个字段待核实不会阻断其他有证据字段。提交创建／合并的人物后，这些线索及未选择的关系保存为该人物的 `unverified_claims`；跳过的候选仍可从 `get_contact_import` 找回。只有 `relation_choices` 明确选择的关系进入正式图谱，项目客户不应当作雇主。

默认搜索与 `ask_contacts` 只使用正式图谱事实。需要寻找尚未核实的线索时，显式调用 `search_contacts({query:"学校或技能关键词",mode:"keyword",include_unverified:true})`，检查每条结果的 `match_status` 和 `claim_id`；`confirmed` 表示正式图谱命中，不一定经过人工审核。待核实查询不支持 semantic／hybrid，也不会进入语义向量。用 `get_contact({entity_id:"…",claim_offset:0,claim_limit:20})` 独立分页查看 `unverified_claims` 的值、原因和短来源。

核对后调用 `review_contact_claim`，提供 `claim_id`、`action:"confirm"` 或 `"reject"`、稳定的 `operation_id`、当前人物的 `expected_entity_version`。确认必须附 1–500 字符的 `confirmation_note`；必要时提供 `corrected_value`，未关联机构的关系还须提供已创建机构的 `target_id`。确认会生成手工审核证据，不冒充原文件引文；拒绝仅改变线索状态。每次审核后重新读取版本，重试同一次操作时保留原参数与 `operation_id`。两段任职须分别审核并保留独立关系。同一文件仍出现多个可提交人物片段时，先核对身份再用 `merge_contacts` 明确选择保留字段；待核实线索会随人物合并转到保留的档案，随后仍需逐条审核。

图谱中查人使用 `search_contacts`（姓名、关键词、组织、职位、技能，可分页）；查看完整档案和证据使用 `get_contact`；问配偶、亲子或任职等问题使用 `ask_contacts`，同名或证据不足会要求澄清或拒答。`get_contacts` 保持原有公开网页搜索与快照语义，不是共享图谱查询。语义/混合检索只有在服务端另配 `ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`、`ARK_EMBEDDING_CREDENTIAL` 后可用；未配置时选 `mode=keyword`。失败索引可用 `retry_contact_index` 指定 `entity_id` 和稳定的 `operation_id` 重试。

发布前的质量评测会上传 12 份虚构样本并创建联系人，因此只在使用**一次性数据库**的隔离测试服务上运行。给评测进程设置 `CONTACT_EVAL_MCP_URL`（以 `/mcp` 结尾）、`CONTACT_EVAL_UPLOAD_URL`（同源、以 `/contact-files` 结尾）和 `CONTACT_EVAL_TOKEN`，并提供 `CONTACT_EVAL_DEPLOY_REVISION`、`CONTACT_EVAL_DOCLING_VERSION`、`CONTACT_EVAL_OCR_VERSION` 以记录版本；模型元数据读取 `ARK_API_URL`、`ARK_MODEL`、`ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`，也可使用对应的 `CONTACT_EVAL_*` 覆盖项。运行 `npm run contacts:evaluate`，查看 `docs/validation/contact-management-quality.md`；退出码 0 表示全部门槛通过，1 表示已验证失败，2 表示配置不完整。评测端无需读取或打印模型凭据；服务端的模型凭据请只保存在其本地环境中。

## 1. 在终端保存 Token

在当前终端会话中设置环境变量：

```bash
export SALESTOOLS_MCP_URL='https://oojyeijszmwy.sealosbja.site/mcp'
export SALESTOOLS_MCP_TOKEN='粘贴管理员提供的 Token'
```

不要把 Token 写入 Git、聊天记录、截图或提交到配置文件。关闭终端后，如果环境变量没有持久化，需要重新设置。

## 2. 在 Codex 注册 salestools

```bash
codex mcp add salestools \
  --url "$SALESTOOLS_MCP_URL" \
  --bearer-token-env-var SALESTOOLS_MCP_TOKEN
```

检查注册结果：

```bash
codex mcp list
```

如果已经存在同名配置，先查看配置；确认需要替换时再删除并重新添加：

```bash
codex mcp get salestools
codex mcp remove salestools
codex mcp add salestools \
  --url "$SALESTOOLS_MCP_URL" \
  --bearer-token-env-var SALESTOOLS_MCP_TOKEN
```

重新打开 Codex 会话，使新的 MCP 配置生效。向 Codex 发送“列出 salestools 可用工具”，应能看到：

```text
get_company_profile
get_contacts
submit_assessment
get_assessment_status
get_assessment_report
```

若管理员开启共享图谱，还应看到 `search_contacts`、`get_contact`、`ask_contacts`、`import_contacts`、`get_contact_import` 和 `commit_contact_import` 等联系人工具。看不到时先让管理员检查 `CONTACT_GRAPH_ENABLED` 与独立图谱库路径；这不影响上列原有工具。

## 3. 先查企业基础画像

在 Codex 中输入自然语言请求：

> 请使用 salestools 查询“深圳市海明润超硬材料股份有限公司”的基本情况，地域提示为“深圳”。

Codex 应调用 `get_company_profile`，输入等价于：

```json
{
  "query": "深圳市海明润超硬材料股份有限公司",
  "region_hint": "深圳"
}
```

重点查看：

- `candidates`：候选法定主体、统一社会信用代码和匹配依据。
- `basic_profile`：行业、地区、企业类型、规模线索和经营风险摘要。
- `source_status`：企查查来源是否成功。

只有一个明确匹配主体时，继续确认 `legal_name` 和 `credit_code`。如果有多个候选，不要让 Codex 自动选择，先人工确认法定主体。

## 4. 查询关键岗位人员

确认要研究的企业后，在 Codex 中输入：

> 请使用 salestools 查询这家企业公开网页中的关键岗位人员，地域提示为“深圳”，并列出当前联系人和历史联系人。

Codex 应调用 `get_contacts`，输入等价于：

```json
{
  "query": "深圳市海明润超硬材料股份有限公司",
  "region_hint": "深圳"
}
```

结果包括企业负责人、研发/技术、数字化/IT、采购和质量负责人，以及可追溯的来源 URL 和发布日期。`historical_contacts` 只是历史任职证据，不代表此人已经离职或当前仍在任。

本工具不返回邮箱、电话等直接联系方式；没有明确职位的专利发明人或招投标联系人不会列出。查询同一企业关键词和地域时，30 天内会复用缓存，不会重复查询上游；不同地域或简称不会自动合并。

## 5. 提交正式销售评估

只有在你确认法定名称和统一社会信用代码，并且明确需要正式评估时，才向 Codex 输入：

> 我已确认法定主体为“深圳市海明润超硬材料股份有限公司”，统一社会信用代码为“这里填已核实的 18 位代码”。请使用 salestools 提交正式销售评估。

Codex 应调用 `submit_assessment`，输入等价于：

```json
{
  "legal_name": "深圳市海明润超硬材料股份有限公司",
  "credit_code": "已核实的18位统一社会信用代码",
  "force_refresh": false
}
```

记录返回的 `assessment_id`。常见返回状态：

- `processing`：任务已提交，等待资料采集和整理。
- `completed`：命中 30 天内的已完成报告，通常会带 `cache_hit: true`。

新任务返回的 `estimated_minutes` 为 `5-40`，这是按真实 Ark 分批耗时给出的宽区间，不是 SLA，也不包含前方其他任务的排队时间。

如果只是想读取已有报告，不要反复提交同一任务。

## 6. 轮询评估状态

当上一步返回 `status: "processing"` 时，向 Codex 输入：

> 请使用 salestools 查询评估任务 `<assessment_id>` 的状态。

Codex 应调用 `get_assessment_status`：

```json
{
  "assessment_id": "上一步返回的 UUID"
}
```

间隔一段时间再查询，直到状态变为 `completed` 或 `failed`。不要修改或猜测 `assessment_id`。

## 7. 读取销售评估报告

状态变为 `completed` 后，向 Codex 输入：

> 请使用 salestools 读取评估任务 `<assessment_id>` 的完整报告，并先告诉我推荐产品、综合机会、来源状态和需要销售核实的问题。

Codex 应调用 `get_assessment_report`：

```json
{
  "assessment_id": "上一步返回的 UUID"
}
```

阅读报告时按这个顺序使用：

1. 看客户摘要和推荐产品。
2. 看七项产品机会及其证据、阻碍和缺口。
3. 查看“销售建议”中的首轮访谈问题。
4. 核对关键证据的来源和采集时间。
5. 将 `待核实`、预算、需求和决策权问题带入下一次客户沟通。

“机会”是公开证据支持的跟进判断，“置信度”是证据支持程度；两者都不是成交概率。报告中的“未发现”也不等于客户没有需求。

## 一次完整使用路径

```text
Codex 注册 MCP
      ↓
get_company_profile：确认企业主体
      ↓ 人工确认 legal_name + credit_code
get_contacts：准备关键岗位线索
      ↓ 明确要求正式评估
submit_assessment：提交异步任务
      ↓ status = processing
get_assessment_status：轮询
      ↓ status = completed
get_assessment_report：读取报告并准备拜访
```

## 常见问题

### 方舟为什么显示 `partial`？

正式评估会把去重后的全部证据拆成多个受字节上限保护的方舟请求。单批失败或总调用预算耗尽时，已成功批次仍会生成报告，但来源状态显示 `ark=partial`，审计缺口会列出失败批次或未处理数量。

部署侧相关配置为：

```ini
ARK_REQUEST_MAX_BYTES=12288
MAX_ARK_CALLS=16
MAX_TOTAL_UPSTREAM_CALLS=32
```

`MAX_ARK_CALLS` 计算实际请求尝试次数，不是批次数；一次失败后的重试还会消耗一次。材料数量较多时，应确保 Ark 和总调用预算足够，否则超出预算的批次会明确标记为未处理。

### Codex 看不到 salestools 工具

确认 `codex mcp list` 中存在 `salestools`，然后检查环境变量仍在当前终端：

```bash
test -n "$SALESTOOLS_MCP_URL" && echo 'URL 已设置'
test -n "$SALESTOOLS_MCP_TOKEN" && echo 'Token 已设置'
```

设置变量后重新打开 Codex 会话。

### 返回 401 或 403

通常是 Token 缺失、已禁用或复制错误。重新设置正确 Token；不要把 Token 放进 URL 或工具参数中。

### 返回 404 或连接失败

检查 URL 是否包含正确的 `/mcp` 路径，生产环境必须使用 HTTPS，并确认网络可以访问该域名。

### 正式评估一直是 processing

使用原始 `assessment_id` 调用 `get_assessment_status`。任务完成前不要重复提交；如果最终为 `failed`，根据返回信息稍后重新提交。

### 找不到联系人

先查看 `warnings` 和 `collected_at`。空结果可能表示公开网页没有满足证据要求的人员，也可能表示资料覆盖不足；不要把空数组理解为企业没有相关岗位。

## 工具速查表

| 工具 | 什么时候使用 | 关键输入 |
| --- | --- | --- |
| `get_company_profile` | 初步了解企业或确认主体 | `query`、可选 `region_hint` |
| `get_contacts` | 查公开关键岗位姓名和职位 | `query`、可选 `region_hint` |
| `submit_assessment` | 主体确认后启动正式评估 | `legal_name`、`credit_code`、可选 `force_refresh` |
| `get_assessment_status` | 查询异步任务是否完成 | `assessment_id` |
| `get_assessment_report` | 读取完成报告或失败状态 | `assessment_id` |
