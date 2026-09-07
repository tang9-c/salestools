# salestools 快速入门

这份指南只覆盖 Codex 客户端的 MCP 注册和五个工具的完整使用流程。它假设 salestools 服务端已经部署，并且你已经拿到服务端的 HTTPS 地址和个人 Bearer Token。

## 你需要准备什么

- Codex CLI 已安装并能正常运行。
- salestools MCP 地址， `https://oojyeijszmwy.sealosbja.site/mcp`。
- 管理员为你创建的 Token。Token 明文只在创建时显示一次。
- 你的销售用户标识，例如 `sales-qx`。

MCP 注册不会替你部署服务端，也不会创建 Token。服务端地址和 Token 缺一不可。

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

正式评估会把证据拆成多个受字节上限保护的方舟请求。单批失败或达到最大批次数后仍有材料未处理时，已成功批次仍会生成报告，但来源状态显示 `ark=partial`，审计缺口会列出失败批次或容量剩余数量。

部署侧相关配置为：

```ini
ARK_REQUEST_MAX_BYTES=12288
MAX_ARK_BATCHES=8
MAX_ARK_CALLS=16
MAX_TOTAL_UPSTREAM_CALLS=32
```

`MAX_ARK_CALLS` 计算实际请求尝试次数，不是批次数；一次失败后的重试还会消耗一次。不要只提高 `MAX_ARK_BATCHES` 而不同时确保 Ark 和总调用预算足够。

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
