---
name: salestools-customer-assessment
description: Look up a Chinese company, answer evidence-backed questions about it, or run and read a seven-product sales assessment through Salestools MCP. Use for company research and sales assessment; contact search and imports belong to salestools-contact-management.
---

# Salestools 客户体检

以当前连接实际提供的 MCP 工具和返回结果为准。只编排调用、解释证据，不自行补算产品等级；缺少工具时说明缺失环节，不模拟结果。用户未明确要求正式评估时，先提供基础画像。

## 按意图选择工具

| 用户意图 | 工具与必要动作 |
| --- | --- |
| 初步了解、公司基本情况 | `get_company_profile`；简称可用于候选搜索，多候选请用户选定。 |
| 问具体问题、解释招聘证据、查近期变化 | `ask_company`；不要求先生成完整报告。调用前读 [定向追问](references/company-questions.md)。 |
| 正式体检、七产品机会、销售切入点 | 先用画像工具核验法定主体，再 `submit_assessment`。调用前读 [评估与报告](references/assessment-reports.md)。 |
| 查进度、读报告 | 用已有 `assessment_id` 调用状态或报告工具；结果含义与恢复见 [评估与报告](references/assessment-reports.md)。 |
| 找联系人、查 CRM、导入资料或看关系 | 使用 [联系人管理 skill](../salestools-contact-management/SKILL.md)，不为找人启动评估。 |

## 呈现与解释

- 有对应 MCP App 且宿主支持时优先展示 UI，聊天补充结论和警告。用户只要文字时遵从；没有 App 的工具使用可读文字，不把工具可供 App 调用误认为它自带界面。
- 基础画像先给确认主体、行业标签、规模与经营线索；正式报告先给综合机会、推荐产品及有证据的理由，再概括产品机会、阻碍和销售行动。
- 保留来源、采集时间、冲突与缺口。`partial` 只表示对应来源部分可用；失败原因按返回值说明，不猜测。
- 招聘可证明岗位或软件场景，不能单独证明采购意向；融资是公司活跃度或时机信号，不代表项目预算；行业标签只展示。
- 机会等级是销售适配判断，置信度是证据可靠性，均不是成交概率。“待核实”不强行改为推荐。
- 需要图谱中的企业资料、历史报告或报告生成后的关联更新时，读 [企业关联与历史](../salestools-contact-management/references/company-context.md)。

## 完成标准

画像已明确主体或列出待选候选；追问已给出有依据的回答及未答部分；评估提交已返回真实任务 ID。只有读取到完成报告才称报告已生成。等待、失败、来源缺口和未完成环节都应明确，不能承诺没有实际机制支持的后续自动通知。
