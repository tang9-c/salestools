# Zoho 查询与入库

## 按公司找全部 CRM 联系人

先调用 `discover_contacts({query:"安达",source:"zoho"})`。简称可以检索，但命中不代表主体已确认。省略 `zoho_accounts` 会查询服务端配置的连接；限定连接时只能使用实际返回或已知配置的连接 ID，不是客户名称或 CRM Account ID。

返回 `zoho.status=needs_confirmation` 时展示各连接的候选公司名和客户负责人，让用户选定。用户已在本轮选定则继续，不重复询问。跨连接同名客户保留各自记录，重查时传所选的完整配对，例如：

```json
{
  "query": "用户选定的公司全称",
  "source": "zoho",
  "zoho_accounts": ["返回的连接ID"],
  "zoho_account_records": [
    {"connection_id": "返回的连接ID", "account_id": "对应客户记录ID"}
  ]
}
```

示例占位符不可直接提交。每个客户必须与原连接配对；多个已选记录全部传入，不把一个连接的 ID 用到另一连接。不要先走企查查主体认证来替代 CRM 候选确认。

服务端分页读取选定客户的联系人，一次返回已取得结果，不套用网页的 10 人限制。检查 `zoho.complete`、各连接 `status/search_complete/error_code` 和 `warnings`；超时或单连接失败可返回部分结果，不能称全部完成。`source:"all"` 的网页结果与嵌套 `zoho` 结果分别解释，不将两个来源状态混为一谈。

展示姓名、职位、公司、连接名称、联系人负责人、客户负责人和更新时间。空职位/负责人显示未提供；更新时间不是在职核验时间。总数是 CRM 记录数，不保证独立人数；同名同公司仍可有多条。保留姓名原文，不自动翻转姓与名；疑似系统记录标出而不悄悄丢弃。默认用可读表格，只有核对来源时才展示内部 ID。Zoho 不请求/返回/保存电话、邮箱或微信；Owner 不是本系统授权或任职角色。

## 图谱同步与重复查询

部署启用 `CONTACT_GRAPH_ENABLED` 且当前版本接入同步时，已确认并返回的 `completed/partial` 结果会同步图谱。无需另外上传或逐条 `save_contact`。`needs_confirmation/failed`、没有客户结果或未启用时不写；客户存在但联系人为零时仍可保存组织。

CRM 读取成功与图谱写入成功分开判断，以同步摘要和 warnings 为准。`ZOHO_GRAPH_SYNC_FAILED/PARTIAL`、归档跳过或超大记录警告须保留；计数不能当成独立联系人总人数，也不因 `complete=true` 就宣称全部入库。同步已提交但向量索引调度失败时可用关键词查询。

- 同一连接、同一 CRM 记录重复查询更新原映射；内容未变不重复增长档案版本或证据。空职位不清空旧值，迟到数据不回退新值，缺失记录不自动删除。
- 人工或其他来源支持的字段不被 CRM 自动覆盖；冲突来源保留。已归档档案不自动恢复，人工合并后的映射跟随存续档案。
- 跨连接同名、同公司不自动合并；`possible_duplicate` 是长期身份待核对线索，不是正式图谱边。处理它沿用主 skill 的合并或拒绝流程。
- `worksFor.employment_status=unknown`，无可靠日期则留空。正式关系只表示有 CRM 来源支持，不能称已核实现任。
- 来源定位是连接、Accounts/Contacts 模块与记录 ID，不编造可点击 CRM URL。

用户需要验证入库时，用 `search_contacts` 的关键词查询定位真实 `entity_id`，再 `get_contact` 核对来源与关系。查询结果没有图谱 ID 不等于未入库；不得把 CRM record_id 当 entity_id。查询无同步摘要时不凭配置假定成功，也不擅自通过手工导入补写。
