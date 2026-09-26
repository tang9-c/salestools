# 联系人图谱跨语言契约

本文件是 [联系人管理升级方案](../plans/2026-09-25-contact-management-upgrade.md) 的实现索引。Schema.org 词汇及全部字段的业务语义以该方案为准；这里固定 Node、Python、Rust 之间传输和测试的形状，不另建代码生成流程。

## 业务数据

- 正式节点仅有 `Person` 与 `Organization`。`entity_id` 是应用生成的稳定字符串，不能用姓名推导。`properties` 使用方案列出的完整字段白名单；Person 另外有同级 `extensions`。`metadata` 存版本、UTC 时间和归档／合并状态，不混入 Schema.org 属性。
- 正式 `name` 非空。输入允许省略可选单值；完整输出包含全部适用数组，未知值为 `[]`。数组按规范化完整值去重，电话保留原文，不猜测区号。待确认候选可以没有名称，但 `can_commit` 必须是 `false`，用户补名后才能提交。
- 关系类型仅有 `worksFor`、`alumniOf`、`affiliation`、`memberOf`、`colleague`、`spouse`、`parent`、`children`。`children` 输入归一化为子女指向父母的 `parent`；`spouse` 和 `colleague` 以稳定 ID 排序后存一条、双向读取。`worksFor` 一段任职一条关系，不按两端实体去重。Rust 负责验证端点实际存在、类型、状态证据和版本。
- 证据独立于业务属性；`field_path` 指向允许字段，数组值逐项绑定，嵌入对象使用完整对象值，必要时以 `value_path` 定位叶子字段。关系存在使用 `$relation`。文件证据保存文件名及 SHA-256，网页证据保存 URL，人工证据以确认人和时间为依据，不伪造页码或引文。

## 共享样例

`tests/fixtures/contact-contracts/` 中独立 JSON 文件示范完整实体、任职关系与错误块；`cases.json` 的每条记录包含 `id`、`entrypoint`、`input`、`expected_valid`。Node 的 `tests/contact-contracts.test.ts` 按入口调用实际 Zod 契约；Rust 测试复用适用的实体、关系、证据样例执行最终入库校验；Python 只复用 `parsed_block` 样例。只适用于有状态存储的版本冲突、合并及关系去重，放在 Rust 集成测试中，不伪装成单对象解析失败。

`cases.json` 覆盖最小姓名档案、31 项人物标准属性（其中 21 项扩充在同一完整样例中）、组织标识、项目扩展、多个微信号、助理联系方式、部分日期、出生／去世顺序、嵌套未知键、任职状态冲突、反向亲子输入、逐字段证据及块页码。`Person.properties` 的 31 项标准词汇和四项 `extensions` 均以方案表格为封闭白名单。模型抽取时缺失字段不补造；同名、电话号码及向量相似度均不能自行决定身份合并。

## 进程协议

Rust JSON Lines 请求：`{"version":1,"request_id":"...","op":"...","payload":{...}}`。成功响应：`{"version":1,"request_id":"...","ok":true,"result":{...}}`；失败响应：`{"version":1,"request_id":"...","ok":false,"error":{"code":"...","message":"..."}}`。一行是一条 UTF-8 帧，至多 256 KiB；stdout 只输出协议帧，日志到脱敏 stderr。固定 `op` 白名单见实施计划 Task 2。

Python 只接收由 Node 生成的本地临时路径的 `parse` 请求，逐块输出 `{"version":1,"request_id":"...","kind":"block","block":{"block_id":"...","text":"...","page":1,"source_ref":"..."}}`，完成时输出 `done` 帧。`page` 只有来源可靠时才给出，不得猜测。原件、完整解析正文及页面图不进入图数据库或导入任务记录。

### Python 解析进程的实现边界与上游依据

请求固定为 `{"version":1,"request_id":"...","op":"parse","payload":{"path":"/绝对路径/临时文件","file_type":"pdf|png|jpg","document_id":"...","limits":{...}}}`。`limits` 可用 `max_file_bytes`、`max_pages`、`max_page_pixels`、`max_temp_bytes` 收紧默认硬上限，分别为 20 MiB、50 页、2500 万像素、1 GiB；任何请求值均不能放宽默认上限。仅允许服务器拥有的本地临时路径，Node 在取消或超时时终止该进程，不向 Python 发送 `cancel` 操作。Python 单任务转换的 scratch 目录在成功和失败时移除，Node 负责原件生命周期和进程终止后的遗留清理。

已阅读 Docling Graph 固定提交 [`bbcd0e4846fadfcadac2800784783e59cd2722a9`](https://github.com/docling-project/docling-graph/tree/bbcd0e4846fadfcadac2800784783e59cd2722a9) 的 [`document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_processor.py) 与 [`document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_chunker.py)，以及对应的 [`test_document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_processor.py) 和 [`test_document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_chunker.py)。上游调用 `DocumentConverter`，以 item 的 `prov.page_no`、`self_ref` 记录来源，并在超长分块后保留父块来源；其测试覆盖转换配置、实际 Docling 文档序列化和无句界长文本的硬拆分。本进程沿用这三项行为，但按 Docling item 输出更简单的块契约，不移植 HybridChunker、模型抽取或图谱逻辑。拆块按完整 JSON 帧的 UTF-8 字节数限制，而非上游的模型 token 数。一个 item 跨页时仅在 `prov.charspan` 能完整定位且间隙仅为空白时拆成单页块；否则省略 `page`，避免把块级位置误认为字段级证据。未复制上游源码或测试。
