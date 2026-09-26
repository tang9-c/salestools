# 联系人质量评测

状态：**unverified**。截至 2026-09-26，没有在配置了真实 Docling/OCR、Ark 聊天模型和 Ark 嵌入端点的隔离服务上运行固定样本；本文不声明生产质量门槛通过。确定性评分器的单元测试只验证计分规则，不代表模型效果。

固定数据集 `synthetic-contact-quality-v1` 位于 `tests/fixtures/contact-evals/annotations.json`：4 份文字 PDF、4 份扫描 PDF、4 张 JPG/PNG 名片，均为虚构人物和组织；另有 10 个语义检索目标与 10 个问答状态。标注包含所属人、字段、关系、页码、引文，以及跨页、多人物、同名、任职日期、电话分机、OCR 歧义和文档夹带指令案例。运行脚本会按样本逐项列出 TP/FP/FN、证据定位错误、伪造关系、检索排名和问答失败。

在**一次性隔离的测试图谱**上启动已启用 Docling、Ark 抽取、向量索引和问答的服务，然后设置 `CONTACT_EVAL_MCP_URL`（`/mcp`）、`CONTACT_EVAL_UPLOAD_URL`（同源 `/contact-files`）及 `CONTACT_EVAL_TOKEN`，运行 `npm run contacts:evaluate`。该命令会上传和提交全部样本，不能指向生产图谱；会调用真实服务，而非测试替身。缺少这些凭据时退出码为 2，仍保持 `unverified`；任一门槛失败时退出码为 1，并保存逐样本报告到本文件。另需提供 `CONTACT_EVAL_DEPLOY_REVISION`、`CONTACT_EVAL_DOCLING_VERSION`、`CONTACT_EVAL_OCR_VERSION`，以及真实服务的聊天/嵌入模型和端点（`CONTACT_EVAL_ARK_URL`、`CONTACT_EVAL_ARK_MODEL`、`CONTACT_EVAL_EMBEDDING_URL`、`CONTACT_EVAL_EMBEDDING_MODEL`；可从同机 `ARK_API_URL`、`ARK_MODEL`、`ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL` 继承）。缺版本元数据时运行结果标为 `unverified-config`，退出码为 2。

通过门槛为微平均 precision ≥95%、recall ≥90%、至少 9/10 个语义目标出现在 Top‑5、10/10 个问答状态与证据均正确、零伪造关系或引用、零实体类型及证据定位错误。电话区号/分机和日期精度严格比较；仅姓名、组织名及职位名容许 Unicode NFKC 与空白等价。漏项记 FN，额外输出记 FP。真实运行报告须记录样本 SHA‑256、模型及端点、Docling/OCR 锁文件、抽取提示词与契约源码哈希；缺少远端部署元数据不得用于生产放行。

若固定样本显示跨页归属、多人物归属或证据定位复杂度导致门槛失败，按实施计划再进行一次固定 Docling Graph 对比：同一批样本、同一 Ark 模型、8 批/16 次调用预算，并记录两侧 precision、recall、证据正确率、耗时、调用次数和下一步决策。**当前未运行此对比**，也未将 Docling Graph 接入生产路径。
