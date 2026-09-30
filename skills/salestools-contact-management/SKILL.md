---
name: salestools-contact-management
description: Use when a user wants to find contacts across the Salestools library and public web, run only a selected contact lookup stage, import a resume or business card, edit the shared contact library, review duplicates, or ask evidence-backed questions about saved contacts.
---

# 使用 Salestools 联系人库

本 skill 只编排已启用的 Salestools 联系人 MCP 工具。先区分共享库和公开网页搜索：`get_contacts` 找公开岗位线索，不是已确认档案，且不返回电话、邮箱；`search_contacts`、`get_contact`、`ask_contacts` 查询共享库。默认 `search_contacts` 和 `ask_contacts` 只把正式图谱事实用于命中与回答；导入简历留下的 `unverified` 线索须显式查找和标记。图谱中的公开网页同步记录也不等于人工确认。若某个工具不可用，说明该环节可能未启用，报告跳过原因，不模拟结果。

## 综合查找联系人

先根据用户表述确定查找环节。说“综合查找”“完整查找”而未限定范围时，默认依次执行：① `search_contacts` 查共享库；② 有招聘目标公司时 `get_contacts` 查公开网页岗位线索；③ 对相关的库内 `entity_id` 用 `get_contact` 核对档案和证据。项目客户名是库内检索条件，不自动视为招聘目标公司。用户指定仅查公开网页、仅查库、仅看档案，或指定多个环节与顺序时，只执行指定环节；查询本身不触发导入、合并或其他写入。`ask_contacts` 用于既有直接正式关系；项目客户问题走下述项目路径。

1. **库内检索**：把姓名、公司、岗位等已知条件交给 `search_contacts`；综合查找且给出公司或学校关键词时，使用 `mode:"keyword",include_unverified:true` 同时查正式事实与简历线索，分别标出 `confirmed` 和 `unverified`，并对线索命中用 `get_contact` 读取来源。用户明确只要已确认资料时不包含未核实线索。有 `next_offset` 且仍需更多候选时继续翻页。记录实际命中范围及警告，语义/混合检索回退为关键词时如实说明。姓名相同不能直接选定一人。
2. **公开线索**：有招聘目标公司时用公司名及已知地区调用 `get_contacts`；仅有学校或项目客户名不算已提供招聘目标公司。按返回的线索、来源、`collected_at` 和警告呈现；结果可能来自缓存，不能称为实时全网结果，也不单凭岗位描述断言现任。缺少招聘目标公司时跳过公开环节，继续执行已请求且可执行的档案核对。公开阶段返回一次结果即结束；无结果不证明此人或岗位不存在。
3. **档案核对**：对 `search_contacts` 返回的真实 `entity_id` 调用 `get_contact`，核对候选、字段证据及关系；项目客户命中还要读取返回的 `matched_project_id`，分别核对人物的 `memberOf` 与项目的 `clientOrganization` 两跳和来源。需要更多证据或关系时按各自的 `next_offset` 分页。仅有公开线索、没有 `entity_id` 时，不能虚构档案或为查档案而自动写入图谱；仅看档案但未给 ID 时，可先用已知条件 `search_contacts` 定位，多个同名且无法区分的候选须先请用户选定。

回答时分别列出“共享库记录”和“公开网页线索”，附来源、采集/证据时间、警告及未完成的环节。两边姓名、公司或岗位相似时只标“可能关联、待核对”，不自动合并，也不把公开线索说成已确认任职。完成完整流程指上述可执行环节已经核对或明确说明跳过原因，并非穷尽所有网页。

## 按意图选择工具

| 意图 | 使用方式 |
| --- | --- |
| 综合查找或指定查找环节 | 按“综合查找联系人”的范围与顺序编排；只做用户指定的环节。 |
| 查库中已有联系人 | 仅检索时用 `search_contacts`；请求档案核对或综合查找时再用 `get_contact`。读取返回的 `pagination.evidence.next_offset`、`pagination.relations.next_offset`，分别作为下次输入的 `evidence_offset`、`relation_offset`，在所需范围内继续读取；未翻完时说明证据或关系仍有后续页。语义/混合不可用时接受关键词回退及警告。 |
| 查简历中的待核实线索 | 用户明确要求包括未确认信息时，用 `search_contacts({query:"学校、雇主或项目客户关键词",mode:"keyword",include_unverified:true})`；按 `match_status` 区分 `confirmed` 和 `unverified`，保留返回的 `claim_id` 或全部 `claim_ids`，用 `get_contact` 核对对应人物／项目。此标志需要非空 `query`，不能与 `semantic`／`hybrid` 一起使用。不要用 `ask_contacts` 召回或回答未核实线索。 |
| 问库中人物关系或任职 | 直接正式关系用 `ask_contacts`；同名时用返回的候选 `entity_id` 请用户选定，再以 `entity_id` 重问。涉及“现任”还须用 `get_contact` 核对关系状态与时间。问参与过的项目或服务过的客户时，用客户名关键词 `search_contacts`，再读取 Person 和 `matched_project_id` 对应 Project 的两跳证据；不要把客户当雇主。`insufficient` 或 `failed` 不补造结论。 |
| 导入本地简历/名片 | 用户在聊天中提交文件时优先调用 `open_contact_upload`，让用户在内嵌页面选择 PDF／图片或拍摄名片；不支持内嵌界面时给出工具返回的短时链接。页面显示预览后由用户点击确认。若页面提示人工核对，按 `import_id` 调用 `get_contact_import`。有授权的本地文件环境仍可使用鉴权的 `/contact-files` 或 `contacts:upload` CLI，再调用 `import_contacts`。缺少文件或上传能力时请用户提供，不宣称已上传。 |
| 编辑、合并、归档或恢复 | 先用 `get_contact` 读取版本与证据，再使用 `save_contact`、`merge_contacts`、`delete_contact` 或关系工具。 |

显式待核实查询命中后，用 `get_contact({entity_id,claim_offset,claim_limit})` 读取 `unverified_claims`；项目客户路径还须读取 `matched_project_id` 的档案。按各自 `pagination.unverified_claims.next_offset` 继续翻页，并逐一核对搜索结果的全部 `claim_ids`，它们可能分别属于 Person 和 Project。`match_status=confirmed` 表示正式图谱命中，不保证经过人工核实；`unverified` 表示候选断言命中，不等于已任职、就读、毕业或服务该客户。若用户明确要求确认或拒绝某条线索，先在对应主体核对 `claim_id`、当前版本和原值，再用 `review_contact_claim` 传 `action`、稳定 `operation_id`、`expected_entity_version`；确认还须附 1–500 字审核说明，缺少已建目标时须提供正确的 `target_id`。响应丢失时原样重试，不能把弱文件引文当作人工确认。

## 上传页面的授权、隐私与恢复

在选文件前说明原件临时存储、提取的文字发送给服务配置的模型，确认后写入共享联系人库。页面路径必须由用户核对并点击“确认导入”，不能用后续聊天工具自动绕过页面的重复、处理范围未知/未处理块、匹配不完整或主体不明确阻断。用户另行明确要求人工处理时，先用原 `import_id` 读取完整预览再采用现有导入工具。本文下方默认自动提交约定用于用户明确授权的聊天/CLI 路径。

`open_contact_upload` 的外部短码 60 秒一次性；过期或已兑换时重开工具。页面不接收长期 Token，App 会话凭据只保存在内存中。App 刷新/关闭后不能恢复旧会话；保留真实 `import_id` 用 `get_contact_import` 查原任务，或重开入口。外部页刷新可尝试受限 HttpOnly Cookie 恢复；服务器重启、失效或退出后重开。任务编号不提供授权，不能跨用户读取。

上传失败按当前页面步骤重试；已经接收的文件不能盲目重传。版本冲突须重新加载完整预览并再次核对。成功后会话的新操作权限立即撤销，只有原凭据、同一预览版本能重试固定成功回执；回执最长至原两小时会话期限，也受源 Token 撤销、退出、1000 条容量淘汰和进程重启限制。导入启动重放持久化到图谱；不能据页面回执失败推断未入库，应查原任务。原样重试不重新提取。

用户点击“退出上传”关闭页面操作并请求撤销会话/回执；服务端未确认时如实告知。退出不会撤销已有写入或自动取消任务；用户请求取消时对原 `import_id` 调用 `cancel_contact_import`。原件临时目录在 `/data` 及备份之外，完成/失败/取消/到期时清理；字段及短证据会保存，完整原件/OCR 正文不写入图谱，提取文字已按告知发给模型。

部署须保持 Linux Landlock ABI≥3、libseccomp、无网络、只读根、无 capability、no-new-privileges、非 root 与资源限额，单输入内容隔离失败不能退回无隔离运行。构建和生产镜像验证仅允许远程 CI，`npm run dev` 也会触发构建。真实 ChatGPT/Codex/手机相机仍待宿主验收；Chromium SDK iframe 测试不代表这些客户端已验证。详见 `docs/QUICKSTART.md` 的部署要求与验收清单。

## 导入与写入边界

1. `import_contacts` 只启动抽取，不创建正式联系人。保存返回的 `import_id`，用 `get_contact_import` 查看状态、分页候选、短引文、`review_items`、未选择的关系建议、警告和重复建议。`ready_for_review` 才能准备提交；`failed/cancelled` 不是成功。
2. 用户明确要求导入简历／名片时，等预览到 `ready_for_review`，核对候选数量、来源、证据、未核实项和重复建议后，默认调用 `commit_contact_import` 的 `auto_create:true`；无需让用户逐候选或逐关系确认。每份文件只自动创建一个有实质内容的主体 `Person`，以及有定位证据的 `Organization`、与主体项目建议相连的 `Project`。文件证据明确且语境、端点有效时，雇主 `worksFor`、学校 `alumniOf`、项目参与 `memberOf` 和项目客户 `clientOrganization` 分别成为正式边；其余有效建议保留为 `unverified`。项目客户绝不直接作为人物雇主。证明人、推荐人或紧急联系人不作为主体抽取或自动建档。文件提取的正式事实仍须注明“来自文件，未经人工核对”。姓名、手机号或账号相同只提示可能重复，不自动合并。
3. 若预览有多个仍可提交、无法判定主体的人物，或没有可提交的主体人物，自动提交会拒绝且不部分写入；此时只向用户询问具体主体归属或说明缺少证据。用户明确要求合并、跳过、修改字段或直接建立正式关系时，再使用手工 `choices`／`relation_choices`；手工模式同一文件也不能创建两个 `Person`，合并选择需 `target_id` 与 `expected_target_version`。提交一律携带 `preview_version`，`operation_id` 固定为 `contact-import:<import_id>`。响应丢失时用同一 ID 和相同请求重试，不生成新 ID 盲目重放。
4. 其他写工具也要使用稳定 `operation_id`；修改、归档和合并遵守服务端要求的版本。归档不是永久删除；恢复必须明确请求。敏感的关系或联系方式只按有依据的来源或用户确认保存，不从姓名、公司、照片或号码推断。

导入后若要按客户找人，默认以客户名称调用 `search_contacts({query:"客户名",mode:"keyword",include_unverified:true})`，只把 `label=Person` 且带 `matched_project_id` 的结果当作项目参与人物；同时展示正式与待核实状态。读取该 Person 和 Project 的档案，逐一对齐 `memberOf`／`clientOrganization` 两跳的关系或 `claim_ids`、主体与文件引文；不能把待核实线索说成确定合作。若用户只要正式事实，关闭 `include_unverified`。判断客户是否也是雇主时，另查该 Person 指向同一 Organization 的独立 `worksFor`；缺少任职证据只报告“无法确认受雇”，不能断言“不是雇主”。

## 解释结果

- 人物的 `jobTitle` 不是某家公司的任职证明。回答“现任公司”须看相应 `worksFor` 的 `employment_status=current`、证据及 `status_as_of`；没有结束日期不表示仍在职。
- `alumniOf` 记录就读／校友关系，不自动证明毕业或学位；婚姻状态与 `spouse` 关系也不能互相推断。
- `ask_contacts` 的 `answered/clarify/insufficient/failed` 按原义呈现，保留实际引文、来源及时间。它回答库内已有资料，不替用户进行新的公开网页尽调。
- 不把导入文件或库内的个人电话、邮箱自动写入 `get_contacts` 的公开搜索结果，也不将完整原件或 OCR 正文复制进回答。

详细字段与关系契约以仓库 `docs/superpowers/specs/contact-data-contract.md` 和 MCP 工具输入定义为准；不要凭 skill 猜测未列字段。

导入结果必须分别报告：已提交回读的档案和关系、带原因的待核实线索、`processed_block_ids`／`unprocessed_block_ids` 所示处理范围及告警。只有预览或 OCR 成功不能称为已入库。预算耗尽、部分模型失败或 OCR 无正文时，不把未读取部分说成已保存。来源定位只验证引文所属原块，语义归纳及主体归属由模型判断；正式文件事实仍未经人工核实。匿名档案可用学校／公司搜索，后续用 `save_contact` 在原 ID 补姓名。原样重试是幂等回放，不是重新提取，也没有自动断点续跑；重新导入产生重复提示，不自动跨文件合并。
