# Task 4：Ark 容量校准与发布验证记录

## 范围与方法

- 日期：2026-09-01
- 校准只调用 Ark；未调用 QCC 或豆包，也没有重复采集任何真实企业资料。
- 使用仓库脱敏 `ark-evidence.json` fixture 的主体字段，在临时文件中构造 8 条跨四类的长内容 `ResearchBundle`：`industry`、`technology`、`timing`、`capacity` 各两条。
- 临时校准器直接复用 `ArkEvidenceService.extractWithAudit`，因此同时验证请求的最终 UTF-8 字节预算、Ark HTTP 成功和 `EvidenceBundle` 严格合同。它不输出或保存凭据、Ark URL/模型标识、请求正文、研究正文或模型正文；临时文件未纳入版本控制。
- 使用主工作区 `/Users/tang-codeing/code/salestools/.env` 仅在进程内读取 Ark 配置。仓库中不存在可复用的真实上游 assessment harness，因此此记录是 Ark 适配器的脱敏容量校准，不是完整 QCC/豆包/MCP 端到端验收。

## 校准结果

| 请求预算 | 状态 | 耗时 | 入选/原始 | 实际请求字节 | 类别覆盖（industry/technology/timing/capacity） | HTTP 与合同 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 12,288 | `completed` | 151,663 ms | 8/8 | 11,608 | 2 / 2 / 2 / 2 | 成功 |
| 24,576 | `completed` | 139,977 ms | 8/8 | 24,373 | 2 / 2 / 2 / 2 | 成功 |
| 49,152 | `completed` | 123,445 ms | 8/8 | 38,913 | 2 / 2 / 2 / 2 | 成功 |

每一档仅在前一档完成后才执行。三次调用均未重试；输出只记录预算、实际字节数、数量、类别计数、耗时和 HTTP/合同结果。

## 容量决策

保持 `ARK_REQUEST_MAX_BYTES=12288`。虽然 24KB 与 48KB 各有一次成功，但都没有提高本次四类覆盖或入选数量，且“更大档重复成功”的条件也未满足。该结果不能被解释为 Ark 的官方容量上限，也不能替代使用已授权企业的完整生产传输与 MCP 验收。

## 发布验证

文档变更前已运行并通过：

- `npm test -- --run`：22 个测试文件、579 个测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。

文档变更后已重新运行以上检查，结果仍全部通过；凭据模式检查也通过。该检查仅扫描工作区差异，不读取或显示 `.env` 内容。

## 后续文档校正

README 曾错误地把推荐产品与整体机会列入 `result_json`。实现中的 `AssessmentResultAuditSchema` 只包含行业分类、证据选择审计和七项产品等级/证据 ID；`recommended_product` 与 `overall_opportunity` 始终是 `assessments` 的独立列。已据此校正 README，未改动运行时 schema。

当前批准规范 `docs/superpowers/specs/2026-09-01-ark-evidence-report-fix-design.md` 也有同一字段归属错误，现已同步校正。检查同分支实现计划后未发现同类表述，因此未修改计划。
