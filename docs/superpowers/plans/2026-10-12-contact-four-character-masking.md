# 联系方式专用字段四位遮蔽实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对已有来源的专用联系方式字段统一遮蔽中间四个字符，数据库原值不变，不增加授权机制。

**Architecture:** 一个纯遮蔽函数加一个按字段路径投影的后端输出函数，接到现有联系人输出及模型输入边界。不扫描自由文本，不重写存储/身份匹配逻辑。

**Tech Stack:** 现有 TypeScript、Vitest；不新增依赖。

**Spec:** [设计文档](../specs/2026-10-12-zoho-contact-discovery-design.md)，第 11 节。

## 全局约束

- 独立于 Zoho 接入，可单独实施与验收；不改变网页 discover_contacts 的禁出联系方式规则。
- 所有用户同样遮蔽，包括保存者；不增加解锁、授权或 CRM Owner 映射。
- 原值保留在存储；不修改 native/Rust 数据模型、存储或合并识别依据。
- 原文、图片、自由备注及证据摘录的脱敏延期。仅处理专用字段及明确归属该字段的结构化副本，不宣称完整防泄漏。
- 禁止本地构建；远程 CI 完成原生/浏览器/生产容器 gate。
- 保护已有未提交改动；不得覆盖 `src/mcp/contact-search-tools.ts` 等文件的无关内容。

## 任务 1：确定性函数与字段投影

**文件：** 新增 `src/contacts/contact-masking.ts`、`tests/contact-masking.test.ts`；只读参考 `src/contracts/contact-graph.ts`。

**接口：** `maskContactValue(value: string, kind: 'email' | 'other'): string`；`maskContactOutput<T>(value: T): T` 返回不修改输入的投影副本。

- [ ] 先写下面用例，补充空值、1–4 位、奇偶长度、Unicode、带空白及邮箱本地部分测试：

```ts
expect(maskContactValue('13812345678', 'other')).toBe('138****5678');
expect(maskContactValue('zhangsan@example.com', 'email')).toBe('zh****an@example.com');
expect(maskContactValue('wx_zhangsan88', 'other')).toBe('wx_z****an88');
expect(maskContactValue('abc', 'other')).toBe('***');
```

- [ ] 运行 `npx vitest run tests/contact-masking.test.ts` 验证失败。
- [ ] 最小函数按 `Array.from(value.trim())` 计算码点；长度 ≤4 返回等长星号，长度 >4 用 `floor((n-4)/2)` 替换中间四位；邮箱对合法 @ 分隔前部分处理。
- [ ] 输出投影只识别既有专用字段 `telephone`、`email`、`faxNumber` 和 `contactPoint` 中对应字段；微信、QQ 若无专用存储字段，不新增 Schema，也不扫描 description 猜测账号。已存在其他显式专用路径时按实际契约追加白名单与测试。
- [ ] 从 detail、import preview、mutation result 的实际结构识别实体 properties、冲突 values、结构化 field evidence/value 和 claim 的专用 field_path，处理明确属于联系方式的副本。自由 quote/source text 不扫描。禁止根据“像电话”对所有数字字符串全局替换。
- [ ] 测试同时证明原输入未变、姓名和证据摘录未变、ID 未变、空数组及 null 未变；通过后提交本任务文件。

## 任务 2：输出边界与模型输入

**文件：** 按现有出口修改 `src/mcp/contact-tools.ts`、`src/mcp/contact-import-tools.ts`、`src/mcp/contact-search-tools.ts`、`src/mcp/contact-answer-tools.ts`、`src/mcp/http-app.ts`；必要时调整 `src/contacts/contact-answer.ts`、`src/contacts/vector-indexer.ts` 的输入投影，不能改变底层存储读取用于内部匹配的行为。

- [ ] 先在 `tests/contact-search-tools.test.ts`、`tests/contact-import.test.ts`、`tests/contact-answer.test.ts` 和新增 `tests/contact-masking-boundaries.test.ts` 加实际专用字段夹具：MCP text 和 structuredContent 均遮蔽；导入预览与 HTTP App 响应均遮蔽；模型/embedding 请求捕获不到专用字段原值；实际图库原值回读不变。
- [ ] 运行上述解释器测试确认新增断言失败；图谱真实二进制验证放远程 CI，不本地编译。
- [ ] 在文本序列化与 structuredContent 分流之前投影同一结果；App 使用同一后端投影，不另加前端打码。覆盖详情、搜索、图谱关系加载、导入预览与 commit 返回、写操作可能返回的资料。
- [ ] 在 LLM/embedding 输入装配前仅投影显式联系方式字段；不修改传给 Rust 的写入数据、合并选择输入及身份匹配读取。输出从原值投影一次，不反复遮蔽已处理值。
- [ ] 清点仓库实际导出入口；存在则复用同一投影测试，不存在则不新增导出功能。日志不打印专用字段原值。
- [ ] 更新 `docs/PRD.md` 与联系人管理 skill 的实际仓库文件（先定位已有文件，不创建第二套 skill）：说明示例、全员一致遮蔽及旁路风险。编辑 skill 前使用 skill-creator 或 writing-skills 的必需指导。
- [ ] 运行解释器边界测试、`npm run typecheck`、`git diff --check`；远程 CI 完成完整测试与构建。仅提交本次遮蔽相关 diff。

## 验收与已知风险

- [ ] 保存合成联系人后，真实存储仍保留完整专用联系方式；读取、搜索、App 与模型输入使用四位遮蔽结果。
- [ ] 联系方式短值、嵌套 ContactPoint、冲突值及结构化字段证据均覆盖；没有仅前端打码的出口。
- [ ] 用户看到姓名、公司、职位和管理人仍正常；无 Token/用户权限机制扩展。
- [ ] 记录原文、图片、备注和自由证据摘录仍可能泄露联系方式，以及部分遮蔽可被推断还原的风险。不把此测试写成完整隐私验收。
- [ ] 合并、发布另行取得指示，不与 Zoho 接入强制捆绑。
