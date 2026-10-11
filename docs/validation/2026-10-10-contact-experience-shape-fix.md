# 任职与教育结构兼容、脱敏提取日志

## 根因与边界

真实五页 PDF 已完成解析（211 块、8.487 秒），提取阶段耗时 129.190 秒。预览中的四段任职和学校有 invalid_shape：模型把 role、日期放入 employment Link，把教育明细放入 facts，而代码要求外层 role/details。无须调整 Docling、容器资源或证据安全边界。

## 最小修复

- 在证据 alias 解析之前，兼容 education.facts 数组并合并至 details；兼容 employment Link 内的 role 数组和 startDate/endDate Fact 容器，移动至外层 role。
- 仅移动已知容器字段；未知字段仍由严格 Schema 拒绝。值缺失的日期保留待核实，不从引文猜测日期，不覆盖已有明细。
- 任职缺少 Link 引文时，保留有原文依据的公司及待核实任职线索，不生成正式任职关系。
- 所有搬移后的事实仍执行原有 alias 归属及逐条引文校验；个人专业、学历和任职岗位不写入 Organization。
- 通过主服务 stderr 输出 JSONL：contact_extract_call（用途、调用序号、耗时、成功/失败代码），contact_extract_validation（主档案 JSON/Schema 失败），contact_extract_summary（候选/组织/项目/文本块计数，固定白名单路径和原因计数）。file_id 仅接受 UUID 形状，方便与已有 import 日志关联。
- 不记录姓名、电话、文件名、正文、原始响应、模型地址、凭证、任意模型字段名或异常消息。不新增配置、平台或额外模型调用。

## 验证

- 先新增 3 个回归测试，观测全部按预期失败；修复后通过。
- 增加引文失配、未知字段和错误消息泄露的边界测试。
- `vitest run tests/contact-extraction.test.ts tests/contact-import.test.ts tests/contact-import-diagnostics.test.ts tests/contact-import-lifecycle.test.ts`：4 文件、131 测试通过。
- `npm run typecheck` 和 `git diff --check` 通过。
- 未本地构建，未提交/推送，未发布/部署；完整 CI、容器验收及同一真实 PDF 的线上复测尚未执行。

## 未覆盖

本次不宣称修复遗漏项目、技能去重或所有模型格式变体；不修改已有预览和正式联系人。正式关系缺少证据仍应由原有确认流程处理。
