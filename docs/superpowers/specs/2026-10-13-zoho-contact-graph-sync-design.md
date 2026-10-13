# Zoho 联系人图谱增量同步设计

状态：用户已确认范围，开发中；不合并、不发布。

## 目标

`discover_contacts` 获取主体已确认的 Zoho 联系人后，沿用 CONTACT_GRAPH_ENABLED 同步到现有图谱。CRM 仍只读，不请求电话、邮箱或微信，不调用 LLM，不写网页快照，不新增表、队列、配置、管理页面或通用字段优先级系统。

## 行为

- 开关关闭不写；needs_confirmation/failed 且无联系人不写；partial 只同步已取得记录，不删除缺失记录。
- 稳定来源键：人=连接ID+Contacts记录ID；公司=连接ID+Accounts记录ID；任职=连接ID+Contacts记录ID+Accounts记录ID。连接ID必须稳定，不用姓名、职位、关键词或采集时间作身份键。
- 复用 source_mapping.source_json 保存上次CRM白名单值与来源时间。比较时忽略本次collected_at；相同内容不追加证据、不升档案版本。Owner变化只更新来源信息。
- 新建Person与Organization及worksFor。空职位不清空旧值，职位/姓名仅有Zoho依据时更新，保留旧证据；存在人工或其他来源依据则保留已有展示值，新增矛盾证据并沿用冲突展示。不新增字段策略引擎。
- CRM任职employment_status=unknown；日期无依据留空，不称已核实当前在职。客户Owner和联系人Owner只作CRM来源信息，不建立上下级或权限关系。
- 较旧结果不覆盖较新的CRM来源状态，优先比较双方可用modified_at，缺失时比较collected_at。变化回退A→B→A也须保留历史；每次同步用独立operation_id而非全内容哈希作永久操作ID。
- 映射跟随现有人工合并结果；已归档记录不自动恢复。不同来源/连接同名或同名同机构资料保留独立实体，生成长期possible_duplicate线索，不自动合并，不形成正式边；双方可查，同对不重复，已处理不重开。
- 允许CRM线索import_id为空，保留文件导入约束；在原contact_claims表迁移，保留数据/索引/外键，读写/审核支持空导入关联，不伪造import_jobs。来源证据增加zoho类型及连接/模块/记录定位字段。
- 每批节点、关系、映射、线索同一事务提交，失败回滚；按既有256KiB帧限制分批。查询成功不因同步失败丢结果，通过warnings和Markdown明确部分或失败；不存在静默全部成功。
- 节点实质内容变化设置现有索引待更新并触发现有索引器；Owner等来源元数据不使语义内容版本变化。关键词可搜，配置向量时沿用现有索引更新。

## 接口边界

新增内部图谱操作sync_zoho_contacts，不新增公共MCP工具。输入为operation_id、actor、collected_at、companies（现有ZohoCompany白名单结构）。输出created/updated/unchanged/archived（联系人计数）及entity_ids（需索引的Person）。共享图谱写入失败警告使用ZOHO_GRAPH_SYNC_FAILED；部分批次已成功用ZOHO_GRAPH_SYNC_PARTIAL。不扩展MCP顶层结构，正常同步摘要置于warnings/Markdown。源查询本身的status/complete含义保持不变，图谱失败不能伪装为CRM失败。

## 验收

首次入库和回读/搜索；完全重复无新增或升版本；职位变化保留依据；Owner仅更新来源；空值不清空；迟到结果/A→B→A；多公司同记录保留归属；同名长期线索；迁移旧库；审核拒绝及合并；归档不恢复；部分查询/同步失败；关闭开关/待确认不写；字节分批；索引更新。Rust/native/全套/App/容器只在现有远程CI编译验证，不使用生产密钥。
