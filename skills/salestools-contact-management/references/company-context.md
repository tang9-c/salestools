# 企业关联、背景与报告历史

仅在用户需要联系人任职企业背景、组织关联或历史报告时读取。企业体检调用遵循 [客户体检 skill](../../salestools-customer-assessment/SKILL.md)。

## 读取

工具支持时可在 search_contacts、get_contact、get_company_profile 传 include_company_context:true。
仅 confirmed 关联用于跨库画像、统计或事实回答；同名 candidate 仍须核对，信用代码须有效且有主体证据。学校不是雇主，unknown 任职不代表现任。

get_contact 历史报告分页独立使用 report_offset/report_limit，并跟随 reports.next_offset；不能用证据/关系页码代替。stale 资料可展示但须注明时效，不绕过 ask_company 新鲜度要求。

ask_contacts 企业背景与 ask_company 库内联系人/项目可引用确认资料，保留 context_citations，不推断采购权或现任。同一文件重复导入不算独立来源；保留实际截断、范围和 warnings。

## 人工关联

存在 link_company 工具且用户明确要求时，先读组织与关联版本。
confirm 传真实 organization_id、credit_code、operation_id、expected_link_version、expected_organization_version 和 note；actor 由认证提供，不作为输入。
unlink 使用当前版本与说明，省略 credit_code；revoked 抑制自动重新关联。身份冲突先重新核对，不自动改绑或合并组织。

## 报告与更新

get_assessment_report(include_related_updates:true) 返回生成后的关联更新，原正文不变。
说明 related_updates 的 scope、truncated、warnings；since 是报告生成时间，记录时间不等于事件时间。
UUID 不证明组织归属；App 报告只从当前节点目录打开，ask_company 指定报告须匹配主体。

浏览已有档案/历史不启动新的外部研究或正式评估。动态或库外问题可按用户意图走现有定向追问。
工具提供 App 时优先在 UI 浏览；宿主未实际验收不能用浏览器模拟测试冒称可用。
