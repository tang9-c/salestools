---
name: salestools-contact-management
description: Use when a user wants to find contacts across the Salestools library and public web, run only a selected contact lookup stage, import a resume or business card, edit the shared contact library, review duplicates, or ask evidence-backed questions about saved contacts.
---

# 使用 Salestools 联系人库

本 skill 只编排已启用的 Salestools 联系人 MCP 工具。先区分共享库和公开网页搜索：`discover_contacts` 找公开岗位线索，不是已确认档案，且不返回电话、邮箱；`search_contacts`、`get_contact`、`ask_contacts` 查询共享库。默认 `search_contacts` 和 `ask_contacts` 只把正式图谱事实用于命中与回答；导入简历留下的 `unverified` 线索须显式查找和标记。图谱中的公开网页同步记录也不等于人工确认。若某个工具不可用，说明该环节可能未启用，报告跳过原因，不模拟结果。

## 综合查找联系人

`search_contacts` 可附带“联系人图谱”MCP App，由宿主展示或让用户展开，不调用新的 opener。App 自行读取当前搜索页命中节点的全部一跳职业关系及名称；只为展示不要在聊天重复批量 `get_contact`。用户请求核对或结论时，仍按下面的真实 ID、状态和证据流程读取，不能用图像代替证据。点击详情不递归扩图，加载失败或未完成不表示没有关系；虚线仅为原查询显式开启的职业待核实项。详情通过原 `get_contact` 单独显示双向 `possible_duplicate` 身份提示，不受 `include_unverified` 开关影响，且不画成关系边；共用 `unverified_claims` 分页。其他 claim 仍归属于实际主体。正式边不等于人工核实，unknown 任职不能称现任。不支持 App 的宿主继续文字/表格；不要提供普通网页查询链接，也不擅自打开上传 App。

先根据用户表述确定查找环节。说“综合查找”“完整查找”而未限定范围时，默认依次执行：① `search_contacts` 查共享库；② 有招聘目标公司时 `discover_contacts` 查公开网页岗位线索；③ 对相关的库内 `entity_id` 用 `get_contact` 核对档案和证据。项目客户名是库内检索条件，不自动视为招聘目标公司。用户指定仅查公开网页、仅查库、仅看档案，或指定多个环节与顺序时，只执行指定环节；查询本身不触发导入、合并或其他写入。`ask_contacts` 用于既有直接正式关系；项目客户问题走下述项目路径。

1. **库内检索**：把姓名、公司、岗位等已知条件交给 `search_contacts`；综合查找且给出公司或学校关键词时，使用 `mode:"keyword",include_unverified:true` 同时查正式事实与简历线索，分别标出 `confirmed` 和 `unverified`，并对线索命中用 `get_contact` 读取来源。用户明确只要已确认资料时不包含未核实线索。有 `next_offset` 且仍需更多候选时继续翻页。记录实际命中范围及警告，语义/混合检索回退为关键词时如实说明。姓名相同不能直接选定一人。
2. **公开线索**：有招聘目标公司时用公司名及已知地区调用 `discover_contacts`；仅有学校或项目客户名不算已提供招聘目标公司。按返回的线索、来源、`collected_at` 和警告呈现；结果可能来自缓存，不能称为实时全网结果，也不单凭岗位描述断言现任。缺少招聘目标公司时跳过公开环节，继续执行已请求且可执行的档案核对。公开阶段返回一次结果即结束；无结果不证明此人或岗位不存在。
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

在选文件前说明原件临时存储、提取的文字发送给服务配置的模型，确认后写入共享联系人库。页面路径由用户核对并点击“确认导入”；有重复提示时按钮为“保存资料，身份待核对”，经授权可独立入库，重复提示或匹配不完整只提示警告。处理范围未知/未处理块或主体不明确仍须核对。点击“暂不保存”只停留预览，不提交也不取消，可“继续核对”；不能代用户点击保存或选择合并。用户另行明确要求人工处理时，先用原 `import_id` 读取完整预览再采用现有导入工具。本文下方默认自动提交约定用于用户明确授权的聊天/CLI 路径。

`open_contact_upload` 的外部短码 60 秒一次性；过期或已兑换时重开工具。页面不接收长期 Token，App 会话凭据只保存在内存中。App 刷新/关闭后不能恢复旧会话；保留真实 `import_id` 用 `get_contact_import` 查原任务，或重开入口。外部页刷新可尝试受限 HttpOnly Cookie 恢复；服务器重启、失效或退出后重开。任务编号不提供授权，不能跨用户读取。

上传失败按当前页面步骤重试；已经接收的文件不能盲目重传。版本冲突须重新加载完整预览并再次核对。成功后会话的新操作权限立即撤销，只有原凭据、同一预览版本能重试固定成功回执；回执最长至原两小时会话期限，也受源 Token 撤销、退出、1000 条容量淘汰和进程重启限制。导入启动重放持久化到图谱；不能据页面回执失败推断未入库，应查原任务。原样重试不重新提取。

用户点击“退出上传”关闭页面操作并请求撤销会话/回执；服务端未确认时如实告知。退出不会撤销已有写入或自动取消任务；用户请求取消时对原 `import_id` 调用 `cancel_contact_import`。原件临时目录在 `/data` 及备份之外，完成/失败/取消/到期时清理；字段及短证据会保存，完整原件/OCR 正文不写入图谱，提取文字已按告知发给模型。

部署使用普通 Linux 容器，不依赖 Landlock 或应用安装的 seccomp。保持非 root、Worker 只读根、无 capability、no-new-privileges、默认容器 seccomp 与资源限额；Worker 不接收上游凭证或数据库挂载。安全边界是容器，不承诺逐文件隔离或 Sealos 同 Pod 禁网。两个容器必须同版本。上传尝试和新导入分别按用户每 60 秒最多 5 次，`CONTACT_RATE_LIMITED` 时按 `retry_after_seconds` 等待，用原 operation_id 重试，不盲目重传；已存在任务重放不计数。构建及生产镜像验证仅允许远程 CI，`npm run dev` 也会构建。真实 ChatGPT/Codex/手机相机仍需宿主验收，Chromium 模拟不能替代。详见 `docs/QUICKSTART.md`。

## 导入与写入边界

1. `import_contacts` 只启动抽取，不创建正式联系人。保存返回的 `import_id`，用 `get_contact_import` 查看状态、分页候选、短引文、`review_items`、未选择的关系建议、警告和重复建议。`ready_for_review` 才能准备提交；`failed/cancelled` 不是成功。
2. 用户明确要求导入简历／名片时，等预览到 `ready_for_review`，核对候选数量、来源、证据、未核实项和重复建议后，默认调用 `commit_contact_import` 的 `auto_create:true`；无需让用户逐候选或逐关系确认。每份文件只自动创建一个有实质内容的主体 `Person`，以及有定位证据的 `Organization`、与主体项目建议相连的 `Project`。文件证据明确且语境、端点有效时，雇主 `worksFor`、学校 `alumniOf`、项目参与 `memberOf` 和项目客户 `clientOrganization` 分别成为正式边；其余有效建议保留为 `unverified`。项目客户绝不直接作为人物雇主。证明人、推荐人或紧急联系人不作为主体抽取或自动建档。文件提取的正式事实仍须注明“来自文件，未经人工核对”。姓名、手机号或账号相同只提示可能重复，不自动合并。
3. 若预览有多个仍可提交、无法判定主体的人物，或没有可提交的主体人物，自动提交会拒绝且不部分写入；此时只向用户询问具体主体归属或说明缺少证据。用户明确要求合并、跳过、修改字段或直接建立正式关系时，再使用手工 `choices`／`relation_choices`；手工模式同一文件也不能创建两个 `Person`，合并选择需 `target_id` 与 `expected_target_version`。提交一律携带 `preview_version`，`operation_id` 固定为 `contact-import:<import_id>`。响应丢失时用同一 ID 和相同请求重试，不生成新 ID 盲目重放。
4. 其他写工具也要使用稳定 `operation_id`；修改、归档和合并遵守服务端要求的版本。归档不是永久删除；恢复必须明确请求。敏感的关系或联系方式只按有依据的来源或用户确认保存，不从姓名、公司、照片或号码推断。

导入后若要按客户找人，默认以客户名称调用 `search_contacts({query:"客户名",mode:"keyword",include_unverified:true})`，只把 `label=Person` 且带 `matched_project_id` 的结果当作项目参与人物；同时展示正式与待核实状态。读取该 Person 和 Project 的档案，逐一对齐 `memberOf`／`clientOrganization` 两跳的关系或 `claim_ids`、主体与文件引文；不能把待核实线索说成确定合作。若用户只要正式事实，关闭 `include_unverified`。判断客户是否也是雇主时，另查该 Person 指向同一 Organization 的独立 `worksFor`；缺少任职证据只报告“无法确认受雇”，不能断言“不是雇主”。

## 解释结果

- 疑似重复：授权保存有效资料后，可创建独立档案，旧档案正式资料保持原状；无身份确认时保留 `possible_duplicate` 的 `unverified`（待核对）状态。名称为发现时快照，理由相同不证明同一人；线索不参与职业搜索、问答、向量或正式图谱。匹配失败/截断时报告重复核对未完整完成及实际已保存线索，不能称没有重复。本轮只覆盖新导入，不自动回填历史库；临时原件清理不使身份线索到期。
- 确认同一人且授权合并时先读双方当前版本，再使用 `merge_contacts`，不调用 `review_contact_claim(action=confirm)` 确认身份线索。导入候选合并到 A 后，与 B 的提示仍可能待核对；不能宣称已经排除 B。成功后按真实返回 ID 回读结果与线索。
- 拒绝 `possible_duplicate` 时，先读取记录实际 `subject_id` 的当前版本，即使当前查看的是另一端；按原 claim 分页核对记录。调用 `review_contact_claim` 时传该主体版本、`action=reject`、稳定 `operation_id`，并必须提供 1–500 字符 `confirmation_note`，说明确认不同人或仅忽略提示。忽略提醒不证明不同人；只查看或暂缓不授权拒绝，也不承诺有暂时隐藏/自动恢复功能。

- 字段归属：Person 保存个人身份、联系方式和技能，爱好／婚姻情况／籍贯／即时通讯在 Person.extensions；学校／公司 Organization 只保存机构自身信息。专业、教育层次、就读起止时间在该人的 `alumniOf.properties.major/educationLevel/startDate/endDate`，不是学校属性；任职和项目参与角色／时间看各自关系。`educationLevel=本科` 不证明毕业或取得学位。
- `skills=[]` 或可选经历字段提取失败，不作为拒绝保存有效联系人的理由；仍按预览的主体、证据和可提交状态操作。可疑教育／任职字段展示为 Person 上指向相应机构的关系待核实项，不展示成学校／公司事实。
- `$experience` 是无法定位具体经历的待核实线索，不能直接用 `review_contact_claim(action=confirm)` 写成 Person 属性。先核对原文、具体经历与目标，再在明确授权下保存正确关系并处理旧线索。已有学校上的 `properties.major` 错误 claim 也不能直接确认或自动迁移；用户确认正确经历后写正确关系，再明确拒绝原错误 claim。只请求查看信息不授权这些写入。

- 人物的 `jobTitle` 不是某家公司的任职证明。回答“现任公司”须看相应 `worksFor` 的 `employment_status=current`、证据及 `status_as_of`；没有结束日期不表示仍在职。
- `alumniOf` 记录就读／校友关系，不自动证明毕业或学位；婚姻状态与 `spouse` 关系也不能互相推断。
- `ask_contacts` 的 `answered/clarify/insufficient/failed` 按原义呈现，保留实际引文、来源及时间。它回答库内已有资料，不替用户进行新的公开网页尽调。
- 不把导入文件或库内的个人电话、邮箱自动写入 `discover_contacts` 的公开搜索结果，也不将完整原件或 OCR 正文复制进回答。

详细字段与关系契约以仓库 `docs/superpowers/specs/contact-data-contract.md` 和 MCP 工具输入定义为准；不要凭 skill 猜测未列字段。

导入结果必须分别报告：已提交回读的档案和关系、带原因的待核实线索、`processed_block_ids`／`unprocessed_block_ids` 所示处理范围及告警。只有预览或 OCR 成功不能称为已入库。预算耗尽、部分模型失败或 OCR 无正文时，不把未读取部分说成已保存。来源定位只验证引文所属原块，语义归纳及主体归属由模型判断；正式文件事实仍未经人工核实。匿名档案可用学校／公司搜索，后续用 `save_contact` 在原 ID 补姓名。原样重试是幂等回放，不是重新提取，也没有自动断点续跑；重新导入产生重复提示，不自动跨文件合并。


## 企业资料关联与历史

启用企业关联服务时新增一个模型可见工具 `link_company`；不要硬编码工具总数。用户查询组织与企业背景时，可给 `search_contacts`、`get_contact`、`get_company_profile` 显式传 `include_company_context:true`。只有 `confirmed` 可用于跨库统计、画像报告展示和事实回答；唯一同名的 `candidate` 仍须人工核对。信用代码须有效并有主体证据，自动确认只读，不自动合并组织。学校／alumniOf 不代表雇主，unknown 不代表现任。

人工关联使用 `link_company` 的 action、organization_id、credit_code（confirm 必需）、operation_id、expected_link_version、expected_organization_version、note。先读取实际组织与关联版本；actor 由认证提供，不传入工具参数。重放保持同一操作 ID 和完全相同参数。解除 action=unlink，省略 credit_code，使用当前版本和审核说明；revoked 抑制自动重新关联。身份变化冲突后须重新读取与核对，不自动改绑。

`get_contact` 报告分页使用独立 report_offset/report_limit，默认 10、上限 50，跟随 reports.next_offset；证据和关系页码不能代替报告页码。旧画像可显示并标记 stale，但 ask_company 新鲜度限制仍生效。ask_contacts 任职企业背景和 ask_company 库内联系人／客户项目可复用确认资料，通过 context_citations 保留来源，不推断采购权或当前职位。首版最多 20 条跨库材料、12 个相关档案、最新一个已完成报告快照；同一文件多次导入不算独立来源。

`get_assessment_report` 可传 include_related_updates=true，原正文保持不变。related_updates 最多 20 条，按记录时间倒序，since 是报告生成时间，必须说明 scope、truncated 和 warnings；不能把入库时间当事件时间。独立报告读取保留原权限；UUID 不证明当前组织归属，图谱 App 只能打开当前节点目录，ask_company 指定报告须匹配主体。浏览已有资料不触发外部调查或正式评估；问答涉及动态或库外问题时可走已有定向补查流程。真实宿主尚未验收时明确说明限制，不能用 Chromium 模拟结果代替。
