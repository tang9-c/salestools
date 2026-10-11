# 联系人图谱跨语言契约

本文件是 [联系人管理升级方案](../plans/2026-09-25-contact-management-upgrade.md) 的实现索引。Schema.org 词汇及全部字段的业务语义以该方案为准；这里固定 Node、Python、Rust 之间传输和测试的形状，不另建代码生成流程。

## 业务数据

文字导入是文件导入链路的附加入口：`import_contacts_text(text,operation_id)` 跳过上传与 Docling，复用已有任务、提取、候选预览、确认和取消流程。`source_type=text` 的证据必须带 `text_sha256`、`locator_status=located` 和最多 500 字符的非空短引文，不包含文件名、文件 SHA 或页码。原文仅存于服务端导入任务的 `source.original_text`，最多 20,000 个 UTF-16 代码单元，`source.text_sha256` 校验其完整性；任务预览不返回完整原文，普通日志不记录原文。字段、关系和待核实线索均可保留文字来源，满足既有主体及引文条件时可自动选择正式关系；仍不等于人工核实或确认当前在职。文件原件／OCR 原文不存库的原有边界不变。公开写入工具不得自行声明新文件或文字的已定位证据。

教育经历的 `alumniOf.properties` 支持可选 `major`、`educationLevel`、`startDate`、`endDate`；空对象仍有效，日期使用现有部分日期格式及顺序校验。非空教育详情按经历独立保存，不按同一 Person／学校端点覆盖。上述字段证据的 `subject_kind=relation`，路径分别为 `properties.major/educationLevel/startDate/endDate`，每项值须有匹配证据；这些路径不可作为实体证据写入。Organization 不接受这些个人经历字段。教育层次不证明毕业或取得学位。

抽取 education 条目可带 `details:Fact[]`（省略时为 `[]`）；归属明确的错置机构字段先映射到同条经历，再校验。失败经历字段以 Person 上的关系待核实项保存。无法定位经历的 `$experience` 是不允许直接确认成实体属性的审核线索；沿用既有 review item 和 claim，不新增表或节点。旧机构非法字段 claim 仍可读取／拒绝，不自动确认或迁移。

- 正式节点有 `Person`、`Organization` 与 Schema.org `Project`。`Project` 只保存有文件原文定位的 `name`、`description`（至少一项），不参加联系人身份匹配或人物向量索引；不同文件的同名项目不自动合并。`entity_id` 是应用生成的稳定字符串，不能用姓名或项目名推导。人物、组织的 `properties` 使用方案列出的字段白名单；Person 另有同级 `extensions`。`metadata` 存版本、UTC 时间和归档／合并状态，不混入 Schema.org 属性。
- `Organization.name` 非空；`Person.name` 仅在原文或人工确认提供姓名时填写。无姓名简历也可自动保存为匿名 `Person`，前提是至少一项有来源证据的非姓名业务属性，或一条已选择、具备可定位文件证据的 `worksFor`／`alumniOf` 关系。空匿名档案被拒绝。输入允许省略可选单值；完整输出包含全部适用数组，未知值为 `[]`。数组按规范化完整值去重，电话保留原文，不猜测区号。匿名档案的显示文字由稳定 ID 派生，不写入 `name` 或向量内容；日后确认姓名时在原 ID 上补录姓名及证据。
- 关系类型有 `worksFor`、`alumniOf`、`affiliation`、`memberOf`、`clientOrganization`、`colleague`、`spouse`、`parent`、`children`。`Person → Project memberOf` 表示有证据的项目参与，可用 `OrganizationRole` 记录本人在该项目的角色和日期；旧 `Person → Organization memberOf` 仍使用空属性。`Project → Organization clientOrganization` 表示项目客户，是本项目扩展词，**不是 Schema.org 原生关系**。项目客户不能由此推成 `Person → 客户 worksFor`。`children` 输入归一化为子女指向父母的 `parent`；`spouse` 和 `colleague` 以稳定 ID 排序后存一条、双向读取。`worksFor` 一段任职一条关系，不按两端实体去重。Rust 负责验证端点实际存在、类型、状态证据和版本。
- 证据独立于业务属性；`field_path` 指向允许字段，数组值逐项绑定，嵌入对象使用完整对象值，必要时以 `value_path` 定位叶子字段。关系存在使用 `$relation`。文件证据保存文件名及 SHA-256，网页证据保存 URL，人工证据以确认人和时间为依据，不伪造页码或引文。

一份简历／名片只自动创建一个主体 `Person`，可另建多个有证据的 `Project` 和 `Organization`。`auto_create:true` 在预览中自动选择关系端点、机构／项目名称和关系引文都可定位且语境明确的 `worksFor`、`alumniOf`、项目 `memberOf`、`clientOrganization`；自动边只保留文件证据，不附会人工确认。每一跳独立判断；未选建议落为 `unverified` claim，默认搜索和问答不当作事实。`confirmed` 仅表示已进入正式图谱，不表示人工认证。按客户关键词查人沿 `Person → Project → 客户 Organization`；任一跳待核实时，只有 `include_unverified:true` 才可命中并显示相关 `claim_ids`。`organization_id` 仍只过滤旧任职／就读关系。`ask_contacts` 不用项目客户推断任职。

## 共享样例

`tests/fixtures/contact-contracts/` 中独立 JSON 文件示范完整实体、任职关系与错误块；`cases.json` 的每条记录包含 `id`、`entrypoint`、`input`、`expected_valid`。Node 的 `tests/contact-contracts.test.ts` 按入口调用实际 Zod 契约；Rust 测试复用适用的实体、关系、证据样例执行最终入库校验；Python 只复用 `parsed_block` 样例。只适用于有状态存储的版本冲突、合并及关系去重，放在 Rust 集成测试中，不伪装成单对象解析失败。

`cases.json` 覆盖最小姓名档案、31 项人物标准属性（其中 21 项扩充在同一完整样例中）、组织标识、项目扩展、多个微信号、助理联系方式、部分日期、出生／去世顺序、嵌套未知键、任职状态冲突、反向亲子输入、逐字段证据及块页码。`Person.properties` 的 31 项标准词汇和四项 `extensions` 均以方案表格为封闭白名单。模型抽取时缺失字段不补造；同名、电话号码及向量相似度均不能自行决定跨文件或现有图谱实体的身份合并。同一文件通过模型的 `subject_status:single` 对齐主体；身份标量冲突进入待核实，不根据姓名或号码自动跨文件合并。模型返回临时 `DocumentProfile`：`person` 的逐项 Fact、`education`、`employment`、`projects`（嵌套客户）及 `organization_clues`。Fact 包含字段路径、值、原块短引文和 `uncertain`；关系 Link 独立携带引文和不确定标记。经历的 `local_id` 只在当前文档内使用，后批必须显式沿用同一引用才合并，不能成为数据库 ID。

程序映射 `education→alumniOf`、`employment→worksFor`、`projects→memberOf` 与嵌套 `clientOrganization`；`organization_clues→affiliation` 始终待核实。同一文件的组织仅按规范化完整名称且属性无冲突去重；同名项目和多段任职保留独立经历。该临时结构不增加持久化模型或公共工具。

来源定位与语义理解分开：程序只检查字段白名单、值类型、真实端点、版本、引文确实属于引用原块等确定性约束；模型判断主体、雇主／客户／学校及归纳值是否受来源支持。引文可定位不证明语义正确，不要求字段值完整包含在引文中，也不要求值只出现一次。可引用多个块，但每条引文必须逐块独立定位。`uncertain` 缺省为 true；缺证据、伪引文、结构错误、显式标量冲突进入 `review_items`，保留合法部分。已抽取正式事实不等于人工核实。

完整请求能装下时发送整篇；超预算才分批，后续仅携带受限主体／经历上下文与已成功处理的短原文。默认请求 12,288 字节、8 批、16 次调用不变。失败或预算耗尽保留此前结果，用 `processed_block_ids`／`unprocessed_block_ids` 报告范围，截断有告警。重放同一提交只是幂等回放，不重新提取，也不承诺断点续跑。

## 进程协议

Rust JSON Lines 请求：`{"version":1,"request_id":"...","op":"...","payload":{...}}`。成功响应：`{"version":1,"request_id":"...","ok":true,"result":{...}}`；失败响应：`{"version":1,"request_id":"...","ok":false,"error":{"code":"...","message":"..."}}`。一行是一条 UTF-8 帧，至多 256 KiB；stdout 只输出协议帧，日志到脱敏 stderr。固定 `op` 白名单见实施计划 Task 2。

Python 只接收由 Node 生成的本地临时路径的 `parse` 请求，逐块输出 `{"version":1,"request_id":"...","kind":"block","block":{"block_id":"...","text":"...","page":1,"source_ref":"..."}}`，完成时输出 `done` 帧。`page` 只有来源可靠时才给出，不得猜测。原件、完整解析正文及页面图不进入图数据库或导入任务记录。

### Python 解析进程的实现边界与上游依据

请求固定为 `{"version":1,"request_id":"...","op":"parse","payload":{"path":"/绝对路径/临时文件","file_type":"pdf|png|jpg","document_id":"...","limits":{...}}}`。`limits` 可用 `max_file_bytes`、`max_pages`、`max_page_pixels`、`max_temp_bytes` 收紧默认硬上限，分别为 20 MiB、50 页、2500 万像素、1 GiB；任何请求值均不能放宽默认上限。仅允许服务器拥有的本地临时路径，Node 在取消或超时时终止该进程，不向 Python 发送 `cancel` 操作。Python 转换期间每 50 毫秒检查单任务 scratch 目录总大小，并以 OS 文件大小限制拒绝单个瞬时超限文件；任一限制触发均中断转换并返回 `TEMP_BYTES_EXCEEDED`。scratch 目录在正常成功和失败时移除，Node 负责原件生命周期和进程终止后的遗留清理。

已阅读 Docling Graph 固定提交 [`bbcd0e4846fadfcadac2800784783e59cd2722a9`](https://github.com/docling-project/docling-graph/tree/bbcd0e4846fadfcadac2800784783e59cd2722a9) 的 [`document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_processor.py) 与 [`document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_chunker.py)，以及对应的 [`test_document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_processor.py) 和 [`test_document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_chunker.py)。上游调用 `DocumentConverter`，以 item 的 `prov.page_no`、`self_ref` 记录来源，并在超长分块后保留父块来源；其测试覆盖转换配置、实际 Docling 文档序列化和无句界长文本的硬拆分。本进程沿用这三项行为，但按 Docling item 输出更简单的块契约，不移植 HybridChunker、模型抽取或图谱逻辑。拆块按完整 JSON 帧的 UTF-8 字节数限制，而非上游的模型 token 数。一个 item 跨页时仅在 `prov.charspan` 能完整定位且间隙仅为空白时拆成单页块；否则省略 `page`，避免把块级位置误认为字段级证据。未复制上游源码或测试。

### Node 候选抽取的上游映射

固定上游提交保持 `bbcd0e4846fadfcadac2800784783e59cd2722a9`，参照记录见本轮计划和 Task 2 报告。`direct/prompts.py` 的全文语义抽取映射为固定 DocumentProfile 提示词；`document_chunker.py` 的分块映射为完整请求字节预算；`many_to_one.py` 的保留部分结果映射为逐批累积和未处理块清单；`provenance/binder.py` 的来源绑定映射为精确 block_id 与独立短引文检查。没有移植完整框架，也没有新增视觉模型或第二语义审核模型。原本依赖相邻标题、同页唯一职位、完整值包含的本地语义门槛已删除；证明人识别、当前职位和学校／客户归属由模型处理，必须另用真实样本验收，不能用模型桩宣称已证明语义准确。
