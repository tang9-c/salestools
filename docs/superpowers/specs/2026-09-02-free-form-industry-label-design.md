# 自由文本行业标签设计

## 目标

彻底取消运行时的 P1/P2、`non_target`、`unverified` 行业分类体系，改为由火山方舟根据已确认主体证据生成自由文本行业标签。

行业标签只用于描述企业，不参与七产品机会等级、推荐产品、置信度或任何销售判断。

## 当前问题

当前实现存在两套硬编码：

- `src/industry/classify-industry.ts` 使用关键词把企业补充分类为 P1 或 P2；
- Ark 提示词固定规定 P1/P2 行业范围，并要求输出固定枚举。

这会漏掉 3D 打印、智能硬件等未列行业，也会让报告出现对销售帮助有限的 `unverified`。由于机会引擎已不使用行业分类，继续维护这套枚举没有实际价值。

## 目标数据结构

`EvidenceBundle` 删除：

```ts
industryClassification: 'P1' | 'P2' | 'non_target' | 'unverified'
```

改为：

```ts
industryLabel: string | null
industryEvidenceIds: string[]
```

约束：

- `industryLabel` 为 `null` 时，`industryEvidenceIds` 必须为空；
- `industryLabel` 非空时，去除首尾空白后长度为 2–40 个字符，并至少引用一条存在的证据；
- 所有引用必须归属于已确认法定主体；
- 不允许使用集团、子公司或主体未确认的证据生成目标主体行业标签；
- 不允许输出“科技行业”“制造业”等缺乏销售信息量的泛化标签；
- 证据不足或互相冲突时必须输出 `null`。

本次直接迁移内部结构，不保留旧字段兼容层，避免形成两个行业真值来源。MCP 最终报告接口不直接暴露 `EvidenceBundle`，因此无需为外部客户端保留旧枚举。

## Ark 提取逻辑

Ark 从本次 `ResearchBundle` 中的主体工商信息、官网产品说明、产品技术资料和制造场景证据生成一个可读标签，例如：

- `消费级与工业级 3D 打印设备`
- `锂电池中段智能制造装备`
- `射频通信与天线设备`

Ark 只能总结已有材料，不得根据公司名称、规模、融资热度或常识猜测行业。多个相关业务可以合并为一个标签，但不得输出行业列表、优先级代码或未经证据支持的扩展业务。

## 校验逻辑

证据校验器负责：

- 校验行业标签与证据 ID 的空值一致性；
- 校验每个证据 ID 存在于本次 ResearchBundle；
- 校验引用证据全部为目标法定主体且 `entityMatch=confirmed`；
- 拒绝 Ark 修改来源链接、发布方、主体归属或匹配依据；
- 在证据冲突或主体归属不一致时拒绝非空标签。

不再运行关键词补充分级，也不在确定性规则中尝试重新识别行业。

## 数据流

```text
QCC 与豆包材料
    ↓
ResearchBundle
    ↓
Ark 总结 industryLabel + industryEvidenceIds
    ↓
证据校验器验证来源和主体归属
    ↓
报告展示行业标签

EvidenceBundle
    └── 七产品机会引擎（忽略 industryLabel）
```

## 报告与审计

Markdown 摘要从“行业优先级”改为“行业”：

- 有标签：`行业：消费级与工业级 3D 打印设备`
- 无标签：`行业：待核实`

行业证据继续进入关键证据附录。日志和结果审计字段从 `industry_classification` / `industryClassification` 改为 `industry_label` / `industryLabel`，允许值为字符串或 `null`。

删除报告中的 P1/P2、`non_target`、`unverified` 展示和相关缺口描述。行业待核实本身不形成产品机会缺口，也不改变产品证据置信度。

## 机会判断不变量

七产品机会引擎不得读取 `industryLabel`。相同的产品事实、来源、主体归属和时间条件，在以下情况下必须产生完全相同的机会结果：

- 行业标签为具体文本；
- 行业标签为另一具体文本；
- 行业标签为 `null`。

产品机会仍只由产品/工程场景、招聘、组织与质量复杂度、软件生态、采购时机、预算、决策权和阻碍证据决定。

## 代码影响范围

- 删除 `src/industry/classify-industry.ts`；
- 修改 EvidenceBundle、ReportModel 和 ResultAudit 合同；
- 修改 Ark 输出结构、提示词和证据校验器；
- 修改 assessment runner，移除行业补充分级调用；
- 修改 Markdown 渲染、报告模型和普通日志；
- 更新 fixtures、单元测试、端到端测试和设计文档中的运行时字段表述。

数据库表结构不需要迁移。行业信息只存在于报告 Markdown 和 `result_json`。

应用启动时执行一次轻量数据迁移：对于仍含 `industryClassification` 且不含 `industryLabel` 的历史 `result_json`，删除旧字段、写入 `industryLabel: null`，并将 `industryEvidenceIds` 清空，满足“空标签不得引用行业证据”的新合同。历史 Markdown 保持不变，因此旧报告仍按生成时内容可读；所有新运行时对象只使用新字段，不保留双写兼容层。

## 测试要求

- 合同测试：接受非空行业标签与有效证据，接受 `null` 与空证据；拒绝不一致组合；
- Ark 测试：提示词不再包含 P1/P2 规则，能生成有来源的自由文本标签；
- 校验测试：拒绝虚构证据、未确认主体证据和冲突证据；
- 报告测试：分别验证具体行业和“待核实”展示；
- 机会测试：改变或清空行业标签不会改变七产品机会等级和推荐产品；
- 回归测试：真实招聘、融资和产品事实的现有判断保持不变；
- 全量测试、类型检查、构建和真实企业端到端验证全部通过。

## 明确不做

- 不建立行业标准库或行业层级树；
- 不把行业分类改成可配置 P1/P2 词表；
- 不使用行业标签评分或调整置信度；
- 不为旧内部 EvidenceBundle 字段提供双写兼容；
- 不修改 MCP 四工具接口和 SQLite 表结构。
