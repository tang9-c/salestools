---
name: salestools-contact-management
description: Use when a user wants to find contacts across the Salestools library and public web, run only a selected contact lookup stage, import a resume or business card, edit the shared contact library, review duplicates, or ask evidence-backed questions about saved contacts.
---

# 使用 Salestools 联系人库

本 skill 只编排已启用的 Salestools 联系人 MCP 工具。先区分共享库和公开网页搜索：`get_contacts` 找公开岗位线索，不是已确认档案，且不返回电话、邮箱；`search_contacts`、`get_contact`、`ask_contacts` 查询共享库。默认 `search_contacts` 和 `ask_contacts` 只把正式图谱事实用于命中与回答；导入简历留下的 `unverified` 线索须显式查找和标记。图谱中的公开网页同步记录也不等于人工确认。若某个工具不可用，说明该环节可能未启用，报告跳过原因，不模拟结果。

## 综合查找联系人

先根据用户表述确定查找环节。说“综合查找”“完整查找”而未限定范围时，默认依次执行：① `search_contacts` 查共享库；② `get_contacts` 查目标公司的公开网页岗位线索；③ 对相关的库内 `entity_id` 用 `get_contact` 核对档案和证据。用户指定仅查公开网页、仅查库、仅看档案，或指定多个环节与顺序时，只执行指定环节；查询本身不触发导入、合并或其他写入。只有用户要回答库内人物关系或任职问题时，才按下表使用 `ask_contacts`。

1. **库内检索**：把姓名、公司、岗位等已知条件交给 `search_contacts`；有 `next_offset` 且仍需更多候选时继续翻页。记录实际命中范围及警告，语义/混合检索回退为关键词时如实说明。姓名相同不能直接选定一人。
2. **公开线索**：有目标公司时用公司名及已知地区调用 `get_contacts`；仅有学校名不算已提供目标公司。按返回的线索、来源、`collected_at` 和警告呈现；结果可能来自缓存，不能称为实时全网结果，也不单凭岗位描述断言现任。缺少公司时跳过公开环节，继续执行已请求且可执行的档案核对，最后请用户提供公司以补查公开线索。公开阶段返回一次结果即结束；无结果表示本次未找到合格线索，不证明此人或岗位不存在。
3. **档案核对**：只对 `search_contacts` 返回的真实 `entity_id` 调用 `get_contact`，核对符合用户条件的库内候选、字段证据及关系；需要更多证据或关系时按各自的 `next_offset` 分页。仅有公开线索、没有 `entity_id` 时，不能虚构档案或为查档案而自动写入图谱；仅看档案但未给 ID 时，可先用已知条件 `search_contacts` 定位，多个同名且无法区分的候选须先请用户选定，不擅自对号入座。

回答时分别列出“共享库记录”和“公开网页线索”，附来源、采集/证据时间、警告及未完成的环节。两边姓名、公司或岗位相似时只标“可能关联、待核对”，不自动合并，也不把公开线索说成已确认任职。完成完整流程指上述可执行环节已经核对或明确说明跳过原因，并非穷尽所有网页。

## 按意图选择工具

| 意图 | 使用方式 |
| --- | --- |
| 综合查找或指定查找环节 | 按“综合查找联系人”的范围与顺序编排；只做用户指定的环节。 |
| 查库中已有联系人 | 仅检索时用 `search_contacts`；请求档案核对或综合查找时再用 `get_contact`。读取返回的 `pagination.evidence.next_offset`、`pagination.relations.next_offset`，分别作为下次输入的 `evidence_offset`、`relation_offset`，在所需范围内继续读取；未翻完时说明证据或关系仍有后续页。语义/混合不可用时接受关键词回退及警告。 |
| 查简历中的待核实线索 | 用户明确要求包括未确认信息时，用 `search_contacts({query:"学校或公司关键词",mode:"keyword",include_unverified:true})`；按 `match_status` 区分 `confirmed` 和 `unverified`，后者保留 `claim_id` 并用 `get_contact` 核对。此标志需要非空 `query`，不能与 `semantic`／`hybrid` 一起使用。不要用 `ask_contacts` 召回或回答未核实线索。 |
| 问库中人物关系或任职 | `ask_contacts`；同名时用返回的候选 `entity_id` 请用户选定，再以 `entity_id` 重问。涉及“现任”时还须用 `get_contact` 核对关系状态与时间。`insufficient` 或 `failed` 不补造结论。 |
| 导入本地简历/名片 | 环境有文件及授权上传能力时，使用鉴权的 `/contact-files` 或仓库 `contacts:upload` CLI 上传，取得 `file_id`；再调用 `import_contacts`。缺少文件或上传能力时请用户提供，不宣称已上传。 |
| 编辑、合并、归档或恢复 | 先用 `get_contact` 读取版本与证据，再使用 `save_contact`、`merge_contacts`、`delete_contact` 或关系工具。 |

显式待核实查询命中后，用 `get_contact({entity_id,claim_offset,claim_limit})` 读取 `unverified_claims`；按 `pagination.unverified_claims.next_offset` 继续翻页。`match_status=confirmed` 表示正式图谱命中，不保证经过人工核实；`unverified` 表示仅凭候选断言命中，不等于已任职、就读或毕业。即使同一档案也要把正式字段／关系与待核实线索分开呈现。若用户明确要求确认或拒绝某条线索，先核对 `claim_id`、当前实体版本和原值，再用 `review_contact_claim` 传 `action`、稳定 `operation_id`、`expected_entity_version`；确认还须附 1–500 字审核说明，机构关系缺少已建目标时须提供正确的 `target_id`。响应丢失时原样重试，不能把弱文件引文当作人工确认。

## 导入与写入边界

1. `import_contacts` 只启动抽取，不创建正式联系人。保存返回的 `import_id`，用 `get_contact_import` 查看状态、分页候选、短引文、`review_items`、未选择的关系建议、警告和重复建议。`ready_for_review` 才能准备提交；`failed/cancelled` 不是成功。
2. 对每个候选核对姓名、组织归属、本人联系方式、任职时间与来源。姓名相同、手机号相同或账号相同只表示可能重复；不同人的号码、助理渠道或过时名片都可能误导。提交前须让用户确认具体候选、合并目标、字段冲突及关系取舍；“同名就合并”或“不要逐项确认”这类概括授权不能代替具体确认。
3. 确认后用 `commit_contact_import` 提交 `create/merge/skip`，携带 `preview_version`；合并选择需 `target_id` 与 `expected_target_version`。提交的 `operation_id` 固定为 `contact-import:<import_id>`。响应丢失时用同一 ID 和相同请求重试，不生成新 ID 盲目重放。
4. 其他写工具也要使用稳定 `operation_id`；修改、归档和合并遵守服务端要求的版本。归档不是永久删除；恢复必须明确请求。敏感的关系或联系方式只按有依据的来源或用户确认保存，不从姓名、公司、照片或号码推断。

## 解释结果

- 人物的 `jobTitle` 不是某家公司的任职证明。回答“现任公司”须看相应 `worksFor` 的 `employment_status=current`、证据及 `status_as_of`；没有结束日期不表示仍在职。
- `alumniOf` 只表示校友关系，不自动证明毕业或学位；婚姻状态与 `spouse` 关系也不能互相推断。
- `ask_contacts` 的 `answered/clarify/insufficient/failed` 按原义呈现，保留实际引文、来源及时间。它回答库内已有资料，不替用户进行新的公开网页尽调。
- 不把导入文件或库内的个人电话、邮箱自动写入 `get_contacts` 的公开搜索结果，也不将完整原件或 OCR 正文复制进回答。

详细字段与关系契约以仓库 `docs/superpowers/specs/contact-data-contract.md` 和 MCP 工具输入定义为准；不要凭 skill 猜测未列字段。
