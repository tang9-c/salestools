---
name: salestools-contact-management
description: Find contacts in the Salestools library, Zoho CRM or public web; browse their relationship graph; import resumes, business cards or text; and maintain evidence-backed contact records and possible duplicates.
---

# Salestools 联系人管理

先识别用户要查共享库、CRM 还是网页，或要导入/维护资料。以当前 MCP 工具声明为准；本地已开发不证明远端已部署，不虚构工具、参数、ID 或结果。

## 按意图选择工具与参考

| 意图 | 首选操作 | 何时读取参考 |
| --- | --- | --- |
| 在联系人库找姓名、公司、岗位或技能 | `search_contacts`，优先展示联系人图谱 App。 | 要翻页、核对证据、查未核实线索或项目客户时读 [库内搜索与图谱](references/library-search.md)。 |
| 看某人档案、问已有关系 | 用真实 `entity_id` 调用 `get_contact`；关系问答用 `ask_contacts`。 | 同上；多候选无法区分时先请用户选定。 |
| 查 Zoho CRM 公司联系人 | `discover_contacts(source:"zoho")`。 | 调用前读 [Zoho 查询与入库](references/zoho-discovery.md)。 |
| 查公开网页联系人 | `discover_contacts(source:"web")`；明确要两源才用 `all`。 | 调用或续页前读 [网页发现与快照分页](references/web-discovery.md)。 |
| 导入简历或名片 | `open_contact_upload`，在 App 选文件、预览和确认。 | 操作前读 [导入与恢复](references/import-workflow.md)。 |
| 从文字提取/保存联系人 | `import_contacts_text`，复用预览与确认。 | 同上；不需要上传或 Docling。 |
| 修改、合并、归档、恢复或审核线索 | 先 `get_contact` 核对版本，再调用对应写工具。 | 操作前读 [维护与身份核对](references/record-maintenance.md)。 |
| 企业关联、背景或历史报告 | 现有工具的企业上下文功能。 | 读 [企业关联与历史](references/company-context.md)。 |

只读取当前任务需要的参考，不默认加载全部文档。企业研究或产品评估使用 [客户体检 skill](../salestools-customer-assessment/SKILL.md)。

“综合查找”未限定来源时，先查库；有明确目标公司再查网页，最后核对相关档案。用户指定来源或顺序时遵从；项目客户或学校关键词不自动作为招聘目标公司。

## 默认优先 UI

- 搜索用 `search_contacts` 附带的图谱，文件导入用 `open_contact_upload`；用户不必额外说“打开 UI”。聊天只补充关键结论与警告，不默认输出 JSON 或重复全部详情。
- 宿主需要手动展开时提示用户；调用成功不证明界面已显示。UI 不可用时提供真实工具结果的文字/表格，上传可用工具返回的备用链接。
- 文字入口、CRM 候选确认等没有独立 App 的操作在聊天完成。Zoho 同步后需要浏览关系，可再用公司关键词搜索图谱；说明这是库内搜索范围，不等于本次 CRM 全量结果。
- 不为浏览图谱打开上传 App，也不反复创建会话。UI 优先不改变保存或合并授权。

## 关键边界

- 正式图谱事实不等于人工核实。`jobTitle`、CRM 更新时间或没有离职日期都不能证明现任；核对对应 `worksFor` 的状态、时间和证据。
- 同名、同机构或联系方式匹配只提示可能重复，不自动合并。身份线索长期保留；审核方法见维护参考。
- `discover_contacts` 不返回电话、邮箱；Zoho 和已配置的网页快照同步可能写图谱。用户要求“不保存”时先确认部署支持，现有工具没有单次关闭同步参数。
- 只查看或提取资料不授权正式写入。明确授权保存后按导入参考执行；新建有效资料不必先解决疑似重复。
- 来源失败、未查到或分页未完成不等于不存在。保留不确定性，不自动新增档案来填补查询缺口。

## 完成标准

搜索报告实际命中范围、来源与警告；档案核对引用真实记录与证据；导入只有提交成功并回读才能称已入库；Zoho 查询完整性与图谱同步成功分别说明。
向用户展示人物、公司和岗位名称，内部 ID 仅用于工具调用、来源核对或用户明确需要时展示。
