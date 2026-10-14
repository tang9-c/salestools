# 库内搜索、关系图谱与问答

## 搜索与 UI

`search_contacts` 附带联系人图谱 App，不需要另一个 opener。App 读取当前搜索页命中节点的全部直接职业关系及端点名称；详情不递归扩图。只为展示不在聊天重复批量 `get_contact`；形成结论或核对来源仍需工具证据。

加载失败不表示没有关系，图谱不是全库或 CRM 全量展示。虚线仅是原查询开启的职业待核实项。
`possible_duplicate` 在详情中双向展示，独立于职业线索开关，不画成正式边。

- 已知姓名、公司、岗位和技能按工具实际参数检索。有 `next_offset` 且任务需要更多结果时翻页；语义/混合回退关键词时保留警告。
- 综合查找给出公司/学校关键词、或用户要求包括未核实信息时，可用 `mode:"keyword",include_unverified:true`。用户只要正式事实时关闭；此标志需要非空 `query`，不能搭配 semantic/hybrid。
- 默认普通检索与 `ask_contacts` 使用正式事实。姓名相同不自动选一人。

## 档案与分页

用真实 `entity_id` 调用 `get_contact`。没有 ID 时先搜索定位；多个无法区分的候选请用户选择。网页/CRM 记录 ID 不能冒充图谱 ID。

各集合分页独立，沿返回的 `next_offset` 继续，未翻完时说明：
- `pagination.evidence` → `evidence_offset`
- `pagination.relations` → `relation_offset`
- `pagination.unverified_claims` → `claim_offset/claim_limit`

`match_status=confirmed` 表示正式图谱命中，不保证人工核实；`unverified` 是候选断言。
线索命中后保留全部 `claim_ids`，读取相应主体档案，不能只核对其中一条就称已证实。

## 项目客户不是雇主

按项目客户找人，用客户名关键词搜索；`label=Person` 且有 `matched_project_id` 才按项目参与路径解释。
分别读取 Person 与 Project，核对 `memberOf` 和 `clientOrganization` 两跳及来源；claim 可能分属两个主体。
需要包括未核实线索时显式开启并标出状态。

客户是否也是雇主须有独立 `worksFor`；缺少它只能说无法确认受雇。
学校 `alumniOf` 不代表雇主，也不自动证明毕业或学位。

## 问答

`ask_contacts` 用于既有直接正式关系，不用于召回未核实线索或代替新的网页研究。
`clarify` 时用候选让用户选定，再按真实 ID 重问；`answered/insufficient/failed` 保留原义与引用。
“现任”还须核对 `employment_status=current`、`status_as_of` 与证据。
共享库、CRM 与网页资料分别标明来源，不将相似姓名/岗位当成身份确认。
