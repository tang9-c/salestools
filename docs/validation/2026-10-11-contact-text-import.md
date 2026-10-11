# 联系人文字导入验证

## 实现范围

- 新增 MCP 工具 `import_contacts_text({text, operation_id})`，返回 `import_id`。
- 文字不经过 HTTP 文件上传、临时文件写入或 Docling；共享现有容量、限频、队列、超时和任务状态。
- 复用 LLM 提取、`get_contact_import`、`commit_contact_import`、`cancel_contact_import`；提取只创建候选，不创建正式联系人。
- 原文与 SHA-256 保存在导入任务来源中；正式证据使用 `source_type=text`、`text_sha256` 与短引文，没有文件名或页码。Node 校验引文，Rust 同样核对引文与任务原文、内容哈希。
- 预览隐藏完整原文，普通日志只记录任务、阶段、耗时、计数和安全错误。公开写入接口不能自行创建已定位的文字来源证据。
- 非空输入上限为 20,000 个 UTF-16 代码单元，无新增配置项、网页入口、数据库表或队列。
- 重复请求使用同一操作编号回放；修改文字须换操作编号。未知任职日期、当前在职状态不推断，文字来源不代表外部核实。

## 本地解释器验证

九个测试文件共 193 项通过：`contact-text-import`、`contact-extraction`、`contact-import`、`contact-contracts`、`contact-identity-match`、`contact-rate-limit`、`contact-import-lifecycle`、`contact-import-choice-limit`、`contact-answer`。

新文字链路测试覆盖：跳过解析、原文保留、仅候选预览、明确任职关系自动选择、相同请求回放、操作内容冲突、任务归属、空／过长输入、模型失败、超时、共享容量、取消、鉴权及 MCP 参数契约。解释器测试使用真实提取映射和队列，上游模型及 Rust 数据库由边界测试替身替代，不能视为原生存储验收。

`tsc --noEmit`、Rust 文件 `rustfmt --check`、`git diff --check` 通过。Rust 格式检查不等于类型、编译或运行验证。

## 真实方舟验证

本地源码的 `DocumentExtractor` 调用配置的真实方舟模型，输入明确标注为合成测试的姓名、公司、职位、示例邮箱和 Creo／Windchill 技能文字。一次调用约 10.1 秒，输出 2 个候选、明确 `worksFor`、2 项技能和 8 条文字引文，没有校验警告。引文均可在输入文字中找到，内容哈希正确，没有文件名或页码。

未记录凭证或原始模型响应。此项仅证明该合成文本的模型提取行为，不证明远端 MCP 或正式入库。

## 待远程 CI 验证

新增 `rust/contact-graph/tests/text_import.rs`，覆盖原文保留、自动任职入库、字段／关系回读、按公司搜索、操作回放，以及引文／哈希不匹配和公开伪造来源被拒绝。

遵守仓库禁止本地构建的规则，未执行 Cargo 构建／测试、生产构建或镜像构建；上述原生测试及完整回归需由远程 CI 验证。尚未提交、发布或部署，因此线上尚不能宣称支持新入口。发布时 Node 与 Rust 程序必须来自同一版本。
