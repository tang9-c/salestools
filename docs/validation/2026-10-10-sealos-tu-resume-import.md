# 真实五页简历远端导入验证

## 范围与环境

- 日期：2026-10-10（客户端 America/Los_Angeles）；服务端时间为 2026-10-11 UTC。
- 远端：https://oojyeijszmwy.sealosbja.site 。在当前聊天使用已加载的 Salestools MCP 工具，不是本地模拟。
- 文件：用户授权的 `个人简历-涂宏鑫.pdf`，162813 字节、5 页、未加密、包含可提取文字。
- SHA-256：`47f265adaa471d09b4faf1436d08a2fa214c3b66d5c2b1b1b63d5c782c4d1c50`。
- 本机代码 HEAD：`78c578735f3b91564513cf3cf9921843439f2a37`。此次未构建、未修改业务代码。不能据此认定远端部署了相同 SHA；远端镜像及两个容器版本尚未取得证据。
- 本次验证 HTTP 文件上传和真实 MCP 导入/预览/搜索，不包含 MCP App 的展开、文件选择或浏览器会话验收。

## 操作与结果

1. 通过 `/contact-files` 上传原始 PDF，HTTP 201，耗时 1120 ms；返回哈希与本地一致。
2. file_id：`0634ab5e-ab4d-439a-9f80-7a563f722cf7`。
3. 调用 `import_contacts`，固定 operation_id：`real-resume-tu-20261010-0634ab5e`。
4. import_id：`ci_7104e42251234f1fb7d3e6c5ccc2e9d6`。
5. `get_contact_import` 由 `processing` 进入 `ready_for_review`，version=3。轮询观测处理约 2–3 分钟，未取得服务端精确阶段耗时。
6. coverage_available=true，processed_block_ids=211，unprocessed_block_ids=0，failure=null。此覆盖值仅表示文本块被处理，不代表全部信息被正确识别。
7. total_candidates=10：1 个 Person、9 个 Project、0 个 Organization；9 条 memberOf 关系建议。人物姓名、电话和性别与原文一致，技能列表 46 项。
8. 预览 match_suggestions=[]，搜索 `name=涂宏鑫` 返回 items=[]、total=0。
9. 未调用 `commit_contact_import`：缺失重要任职与教育结构，先保留预览供用户决定。不声称入库、回读或搜索已入库人物验收通过。

## 发现的问题

### 1. 四段任职和学校未生成组织及关系（重要）

原文有四家雇主和四川航天职业技术学院。预览中它们落为人物 review_items 的 `$employment` / `$education`，reason=invalid_shape，没有 Organization、worksFor 或 alumniOf。

返回的待核实数据足以定位结构不合规：任职 `employment` Link 内嵌 startDate/endDate/role；教育 attendance Link 外又携带 facts/details。当前源码提示词规定 Link 只包含 evidence/uncertain，日期作为 role Fact；实际模型输出未遵守此结构。年龄 `27岁`、工作经验 `6年` 也落入 invalid_shape。

这不是 PDF 无文字或解析进程崩溃；需对照远端版本与实际模型响应进一步诊断输出结构和适配行为，不能仅凭此次结果认定模型或环境是唯一原因。

### 2. 项目召回不完整

原文项目经历共 10 项；预览有 9 项，缺少 `结构化产品规格书`。其他 9 个项目名称可对照原文。项目日期、详细贡献和项目客户关系未在当前正式候选中体现，不能将其视为完整项目档案。

### 3. 技能证据与标准化问题

- 顶层警告：`技能补充存在待核实项，未确认技能覆盖完整`。
- REST API、SOAP API、Info*Engine 有 quote_mismatch；REST API、SOAP API 待核实项重复出现。不能据此说原文没有这些技术，应区分引文匹配失败和事实不存在。
- 技能保留 FastJSON/fastJSON、FastDFS/fastDFS、Linux/Linux操作系统等重复或近义表达；46 个值不代表 46 项独立技能。
- 原文教育专业及工作经历已读到，但未形成可提交的正式组织结构；不能用“211 块全部处理”掩盖这些遗漏。

## 结论

上传、远端解析与候选预览链路可用，本次没有再现 SIGKILL、threading.start、SANDBOX_UNAVAILABLE 或 IMPORT_FAILED。真实内容质量尚未通过完整验收，主要问题在提取输出/结构接纳与召回；不能据此宣布 Sealos 环境在所有文件下均无问题。

待用户决定是否提交当前不完整候选；本次未入库、未合并、未删除已有联系人，也未触发额外模型重试。
