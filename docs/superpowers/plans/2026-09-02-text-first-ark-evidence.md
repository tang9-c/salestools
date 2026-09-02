# 文本优先证据整理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让企查查 MCP 和豆包搜索返回的中文自由文本尽量完整进入方舟，由方舟总结销售相关事实，同时保留主体归属、来源引用和机会评级所需的最小结构。

**Architecture:** 法定主体识别和来源溯源继续使用确定性校验；主体确认后的招聘、融资、产品、研发、质量、采购和经营材料采用“原文/摘要保留 → Ark 语义总结 → 薄结构事实”的流程。确定性代码只校验证据引用、主体归属和禁止性推断，并使用 Ark 已确认的事实计算机会等级，不再为每个上游响应建立完整字段映射。

**Tech Stack:** Node.js 20+、TypeScript、Zod、Vitest、MCP 上游适配器、火山方舟 Chat Completions。

## Global Constraints

- 不改变四个 MCP 工具的接口和 SQLite 持久化结构。
- 不新增 Redis、数据库表、原始响应长期存储或独立 Worker。
- 行业分类只能作为标签，不能阻止产品机会判断，也不能降低机会置信度。
- 融资只需保留销售可用的概况；日期、轮次、金额缺失时必须明确标注，不得猜测。
- 招聘正文明确出现目标产品和职责/任职要求时，允许形成产品场景事实；只有标题、摘要或主体未确认时不得升级。
- 多条事实证据只有内容一致且主体归属一致时才能合并；合并后的主体归属和时效不得高于最弱引用来源。
- 只保留上游提供的真实 HTTP(S) 直链；上游无直链时使用 `url: null` 和审计缺口，不得猜测链接。
- 企查查或豆包搜索单项失败仍生成降级报告，两个核心来源均失败才失败。
- 所有新增代码先写失败测试，再写最小实现；每个任务独立运行相关测试并提交。

---

### Task 1: 扩展薄结构以承载 LLM 融资总结

**Files:**
- Modify: `src/contracts/evidence.ts`
- Modify: `src/upstream/ark/prompt.ts`
- Modify: `src/report/render-markdown.ts`
- Test: `tests/contracts.test.ts`
- Test: `tests/ark-adapter.test.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- `FinancingRecordSchema` 增加可选的 `summary: string | null`，不改变现有字段的兼容性。
- `renderMarkdown` 在存在 `summary` 时优先展示该摘要；没有摘要时沿用日期、轮次、金额、投资方的已有降级展示。
- Ark 输出仍为 `EvidenceBundle`，但融资记录可以只提供 `summary` 和 `evidenceIds`，其他融资字段为 `null` 或空数组。

- [x] **Step 1: 写失败测试**

在 `tests/contracts.test.ts` 增加一个融资记录只含摘要和证据引用仍能通过 `EvidenceBundleSchema` 的用例；在 `tests/report.test.ts` 增加报告优先呈现融资摘要的用例；在 `tests/ark-adapter.test.ts` 增加 Ark 返回中文融资段落总结、日期/轮次/金额为空时仍能通过验证的用例。

```ts
const financingWithSummary = {
  occurredAt: null,
  typeOrRound: null,
  disclosedAmount: null,
  investors: [],
  summary: '公司曾完成一轮战略融资并引入产业投资者，具体轮次和金额未披露。',
  evidenceIds: ['ev-1'],
};
expect(EvidenceBundleSchema.safeParse({ ...evidenceBundle, financingRecords: [financingWithSummary] }).success).toBe(true);
```

- [x] **Step 2: 运行失败测试**

运行：`npm test -- tests/contracts.test.ts tests/report.test.ts tests/ark-adapter.test.ts`

预期：新增用例失败，原因是融资记录不接受 `summary` 或报告没有渲染该摘要。

- [x] **Step 3: 实现最小变更**

在 `src/contracts/evidence.ts` 的融资记录对象中加入：

```ts
summary: z.string().trim().min(1).nullable().optional(),
```

在 `src/upstream/ark/prompt.ts` 的输出 shape 和系统提示中说明：

```text
融资材料优先输出一条简短 summary；日期、轮次、金额或投资方只有原文明确披露时才填写，否则使用 null 或空数组。不得因字段缺失丢弃融资材料。
```

在 `src/report/render-markdown.ts` 的 `financingSummary` 和 `financingStatement` 中，当 `summary` 非空时先展示摘要，再按需补充可用字段。

- [x] **Step 4: 运行通过测试**

运行：`npm test -- tests/contracts.test.ts tests/report.test.ts tests/ark-adapter.test.ts`

预期：全部通过，旧融资记录 fixture 无需增加字段也能通过。

- [x] **Step 5: 提交**

```bash
git add src/contracts/evidence.ts src/upstream/ark/prompt.ts src/report/render-markdown.ts tests/contracts.test.ts tests/ark-adapter.test.ts tests/report.test.ts
git commit -m "feat: preserve llm financing summaries"
```

### Task 2: 为企查查补充通用文本材料降级通道

**Files:**
- Modify: `src/upstream/qcc/mapper.ts`
- Test: `tests/qcc-adapter.test.ts`

**Interfaces:**
- `mapQccToolResult(server, tool, payload, identity, collectedAt)` 对企业简介、招聘、融资、年报、资质、专利、招投标、股东和软件著作权等研究材料，在无法匹配详细字段时，返回一个有上限的 `ResearchItem`，正文放在 `content.material`，并保留上游提供的可验证来源 URL。
- `mapCompanyDetails` 的主体/工商/联系方式校验继续严格；正式评估中的 `get_company_profile` 研究材料在已确认主体和信用代码查询上下文下允许走文本通道。这两个用途不得共用一个会绕过主体确认的宽松入口。
- MCP `content[].text` 若不是 JSON，研究类工具将其作为原始材料保留；空文本仍然失败。正文明确出现与已确认主体冲突的法定名称或信用代码时，不得标记为 `confirmed`，必须失败或形成主体冲突 gap。

- [x] **Step 1: 写失败测试**

在 `tests/qcc-adapter.test.ts` 增加以下用例：

```ts
it('keeps plain Chinese recruitment text for the confirmed subject as bounded material', () => {
  const result = mapQccToolResult(
    'operation',
    'get_recruitment_info',
    { content: [{ type: 'text', text: `${identity.legalName}招聘 SolidWorks 机械设计工程师，负责设备三维建模。` }] },
    identity,
    now,
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.content).toContain('SolidWorks');
  expect(result.items[0]?.summary).toContain('待模型整理');
});

it('does not confirm plain text that explicitly identifies another legal entity', () => {
  expect(() => mapQccToolResult(
    'operation',
    'get_recruitment_info',
    { content: [{ type: 'text', text: '其他制造有限公司招聘 SolidWorks 机械设计工程师。' }] },
    identity,
    now,
  )).toThrow(/subject|主体|企业名称/i);
});

it('falls back to material for an unknown Chinese financing object', () => {
  const result = mapQccToolResult('operation', 'get_financing_records', {
    企业名称: identity.legalName,
    搜索结果: '公司完成战略融资并引入产业投资者，金额未披露。',
    说明: '字段结构可能变化',
  }, identity, now);
  expect(result.items[0]?.content).toContain('战略融资');
  expect(result.gaps.join('')).toContain('待模型整理');
});

it('keeps a plain-text company profile for assessment research after identity confirmation', () => {
  const result = mapQccToolResult('company', 'get_company_profile', {
    content: [{
      type: 'text',
      text: `${identity.legalName}从事工业机器人及智能装备研发制造，设有机械研发中心。`,
    }],
  }, identity, now);
  expect(result.items[0]?.content).toContain('工业机器人');
  expect(result.items[0]?.content).toContain('机械研发中心');
});

it('preserves a real material URL and reports a missing one without inventing it', () => {
  const linked = mapQccToolResult('operation', 'get_recruitment_info', {
    Data: [{ RecruitmentMaterial: `${identity.legalName}招聘 Creo 工程师。`, Url: 'https://jobs.example.cn/creo' }],
  }, identity, now);
  expect(linked.items[0]?.url).toBe('https://jobs.example.cn/creo');

  const unlinked = mapQccToolResult('operation', 'get_recruitment_info', {
    content: [{ type: 'text', text: `${identity.legalName}招聘 Creo 工程师。` }],
  }, identity, now);
  expect(unlinked.items[0]?.url).toBeNull();
  expect(unlinked.gaps.join('')).toContain('来源链接不可用');
});
```

- [x] **Step 2: 运行失败测试**

运行：`npm test -- tests/qcc-adapter.test.ts`

预期：纯文本响应在 `unwrapPayload`/`formalRecords` 阶段失败，未知融资对象被标记为不可映射。

- [x] **Step 3: 实现最小变更**

在 `src/upstream/qcc/mapper.ts`：

1. 增加 `RESEARCH_MATERIAL_TOOLS` 集合，包含当前正式评估使用的企业简介和非主体详情研究工具；`mapCompanyDetails` 的主体校验路径不使用该集合。
2. 将 MCP 文本提取拆成“JSON 优先、纯文本回退”：JSON 解析失败时返回受控文本对象，而不是直接抛出 JSON 错误。
3. 为研究类工具增加统一的 `materialRecord`，将原文或 JSON 字符串按 UTF-8 上限截断，抽取安全 URL；不得从材料中猜测日期、金额、职位或产品字段。
4. 在 `formalRecords` 中，详细 schema 解析失败时仅对正式评估研究调用走材料回退；`mapCompanyDetails` 仍通过 `validateQccPayload` 保持严格主体校验。
5. 纯文本明确出现其他法定名称或信用代码时拒绝确认归属；按已确认信用代码调用且没有显式冲突的材料保留现有 QCC 查询归属依据。
6. 材料回退的摘要固定为“企查查材料，待模型整理”，并在 gap 中说明“非结构化材料交由模型整理”，不把回退误报为已结构化事实。
7. 有真实 URL 时原样保留；没有 URL 时保持 `null` 并复用 QCC 无直链审计 gap，不生成目录页或猜测链接。

- [x] **Step 4: 运行通过测试**

运行：`npm test -- tests/qcc-adapter.test.ts`

预期：新增纯文本、企业简介、主体冲突、未知结构和链接用例通过，现有主体不匹配、空响应、标准结构和调用预算测试继续通过。

- [x] **Step 5: 提交**

```bash
git add src/upstream/qcc/mapper.ts tests/qcc-adapter.test.ts
git commit -m "feat: preserve unstructured qcc research material"
```

### Task 3: 将 Ark 提示改为文本优先的语义整理

**Files:**
- Modify: `src/upstream/ark/prompt.ts`
- Modify: `src/upstream/ark/evidence-validator.ts`
- Test: `tests/ark-adapter.test.ts`
- Test: `tests/evidence-validator.test.ts`

**Interfaces:**
- Ark 仍返回严格的顶层 `EvidenceBundle` JSON，但只要求薄结构：事实陈述、事实类别、产品标签、强弱级别、证据 ID、主体归属。
- `statement` 和融资 `summary` 是主要业务输出；缺少详细来源字段时使用中文摘要和 gaps，不补值。
- Validator 继续阻止来源伪造、主体匹配升级、营收倒推、采购意向和高管人格推断，但不因融资日期/轮次/金额缺失而拒绝合法摘要。

- [x] **Step 1: 写失败测试**

在 `tests/ark-adapter.test.ts` 先增加对 `ARK_SYSTEM_PROMPT` 的明确断言：必须出现“文本优先/不要复刻来源字段”“招聘正文中的产品与职责”“融资 summary 可缺日期轮次金额”“不得仅凭搜索词或行业添加产品标签”和“多来源只在内容及主体一致时合并”。再增加中文自由文本招聘材料测试：Ark 输出 `kind: recruitment`、`productTags: ['solidworks']`、`strength: direct`、`statement` 包含产品和职责、`evidenceIds` 指向材料，验证后保留为事实；增加中文融资段落只输出 `summary` 的测试。在 `tests/evidence-validator.test.ts` 增加“缺少融资细节不失败、无证据摘要仍失败”的对照测试。

- [x] **Step 2: 运行失败测试**

运行：`npm test -- tests/ark-adapter.test.ts tests/evidence-validator.test.ts`

预期：提示断言明确失败，因为当前系统提示尚未包含上述文本优先和多来源合并规则；失败原因必须是缺少目标提示语义，而不是测试语法或 fixture 错误。融资摘要 schema 已由 Task 1 建立，不作为本任务红灯来源。

- [x] **Step 3: 实现最小变更**

更新 `ARK_SYSTEM_PROMPT`：

```text
把 ResearchBundle 中的 title、summary、content 当作主要材料。先理解上下文，再用最小结构输出销售可用事实；不要尝试复刻每个来源的字段表。
招聘：正文明确出现目标产品及岗位职责/任职要求时输出 direct；只有标题、摘要、主体不明、过期或上下文不足时输出 supporting/weak，并写明缺口。
融资：输出中文 summary 即可；日期、轮次、金额和投资方只有原文明确时才填写。不得因为字段不完整丢弃材料。
产品标签必须由上下文明确支持；不能仅凭搜索关键词、企业行业标签或模型常识添加。
多来源事实只有内容一致且主体归属一致时才合并；主体归属和时效不得高于最弱引用来源，冲突内容分别保留并写入 conflicts。
```

在 `evidence-validator.ts` 中仅对新增 `summary` 做非空字符串校验和既有禁止性推断检查，不增加本地关键词抽取；保留现有来源引用和主体归属校验。

- [x] **Step 4: 运行通过测试**

运行：`npm test -- tests/ark-adapter.test.ts tests/evidence-validator.test.ts`

预期：中文自由文本招聘和融资摘要通过；标题-only、主体未确认、采购无载体和无证据摘要仍按既有规则降级或失败。

- [x] **Step 5: 提交**

```bash
git add src/upstream/ark/prompt.ts src/upstream/ark/evidence-validator.ts tests/ark-adapter.test.ts tests/evidence-validator.test.ts
git commit -m "feat: make ark evidence extraction text first"
```

### Task 4: 验证机会判断不依赖行业标签和精确字段

**Files:**
- Modify: `tests/opportunity.test.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/recruitment-signals.test.ts`

**Interfaces:**
- `evaluateOpportunities` 使用 Ark 已输出的 confirmed/direct 或 supporting 事实，不读取 `industryClassification` 作为硬约束。
- 近期招聘正文明确出现产品和职责时至少得到低或中机会；行业 `unverified` 不改变该结果。
- 融资摘要缺少日期等字段只影响报告缺口，不阻止其他产品事实评级。

- [x] **Step 1: 写回归保护测试**

增加四组回归用例：

1. 同一 SolidWorks 招聘事实分别设置 `P1`、`P2`、`unverified`，三者机会等级相同。
2. 只有 `statement` 和 `productTags` 的中文招聘总结可以产生机会，但标题-only 事实不能产生确认场景。
3. 只有融资 `summary` 的证据仍能渲染“融资概况”，不生成采购意向或营收推断。
4. 两条内容一致且主体确认的招聘来源可以共同支持一个事实；任一来源主体未确认时，事实不得保持 `confirmed`。

- [x] **Step 2: 运行回归测试**

运行：`npm test -- tests/opportunity.test.ts tests/recruitment-signals.test.ts tests/report.test.ts`

预期：行业标签不影响机会等级的既有行为应直接通过，作为回归保护；融资摘要由 Task 1 实现后通过。若多来源主体归属测试失败，只能先写一个能稳定复现该失败的最小测试，再修改对应的 `src/opportunity/evaluate-product.ts` 或 `src/report/build-report-model.ts`。

- [x] **Step 3: 仅在出现红灯时实现最小变更**

不为已经通过的回归测试修改生产代码。只有出现可复现红灯时，才最小修改 `src/opportunity/evaluate-product.ts` 或 `src/report/build-report-model.ts`；不得新增本地产品词抽取器，不得让行业分类进入机会计算。

- [x] **Step 4: 运行通过测试**

运行：`npm test -- tests/opportunity.test.ts tests/recruitment-signals.test.ts tests/report.test.ts`

预期：三组回归用例通过，既有否定语义、替代软件、过期招聘和主体归属测试不回归。

- [x] **Step 5: 提交**

```bash
git add tests/opportunity.test.ts tests/recruitment-signals.test.ts tests/report.test.ts
git commit -m "test: verify text-first opportunity evaluation"
```

### Task 5: 全量验证并记录结果

**Files:**
- Modify: `docs/validation/2026-09-02-text-first-evidence.md`

**Interfaces:**
- 文档记录测试命令、通过数量、失败来源的降级行为和一次真实企业测试结果。
- 不在本任务中新增真实凭据、保存上游原始响应或修改部署配置。
- 真实验收使用已获授权主体“广东安达智能装备股份有限公司”（统一社会信用代码 `91441900673133772K`），通过本地 HTTP MCP、临时 SQLite 和已配置 `.env` 只提交一次 `force_refresh=true` 任务。

- [x] **Step 1: 运行完整验证**

按顺序运行：

```bash
npm test -- --run
npm run typecheck
npm run build
git diff --check
```

预期：测试、类型检查、构建和 diff 检查全部成功。

- [x] **Step 2: 执行一次真实企业端到端验证**

自动验证通过后，使用 `apply_patch` 在已被 Git 忽略的 `.superpowers/text-first-evidence-e2e.mjs` 创建临时验收脚本。脚本复用已提交计划 `docs/superpowers/plans/2026-09-02-product-evidence-recall-fix.md` Task 4 Step 2 的完整本地 HTTP MCP 客户端，且只作以下确定替换：

- `legalName = '广东安达智能装备股份有限公司'`
- `creditCode = '91441900673133772K'`
- SQLite 路径改为 `.superpowers/text-first-evidence-e2e.sqlite`
- 输出增加融资摘要是否存在、SolidWorks 招聘事实是否存在、事实引用的真实链接数和无链接审计缺口数；不得输出原始 ResearchBundle、网页正文、QCC 响应、Ark 输入输出、Token 或环境变量。

执行：

```bash
rtk node .superpowers/text-first-evidence-e2e.mjs
```

预期：主体画像唯一匹配；只创建一个 assessment；最终状态为 `completed`；报告可读取；QCC、豆包或 Ark 的真实失败按实际状态记录，不伪造成功；如果真实材料包含 SolidWorks 招聘正文，报告必须保留对应产品事实或明确说明主体、时效、上下文缺口；融资材料有内容时必须出现融资摘要，缺少日期/轮次/金额不能使整条融资证据消失。

- [x] **Step 3: 清理临时验收资产**

停止本地服务后只删除以下忽略文件：

```bash
rtk rm -f .superpowers/text-first-evidence-e2e.mjs
rtk rm -f .superpowers/text-first-evidence-e2e.sqlite
rtk rm -f .superpowers/text-first-evidence-e2e.sqlite-shm
rtk rm -f .superpowers/text-first-evidence-e2e.sqlite-wal
rtk git status --short
```

预期：临时脚本、数据库和真实响应均未进入 Git 状态。

- [x] **Step 4: 记录验证文档**

在 `docs/validation/2026-09-02-text-first-evidence.md` 记录：

- 纯文本企查查招聘/融资材料进入 Ark 的结果；
- Ark 输出的 `statement`/`summary`、来源链接和缺口；
- `industryClassification=unverified` 不影响已确认产品场景；
- 单一来源失败仍生成报告；
- 未通过或仍待验证的项目，不写成成功。

- [x] **Step 5: 提交最终验证记录**

```bash
git add docs/validation/2026-09-02-text-first-evidence.md
git commit -m "docs: record text-first evidence validation"
```

## 自审结果

- 设计文档中的“文本优先、薄结构”对应 Task 1–3；
- 招聘、融资、行业标签和证据缺口对应 Task 2–4；
- 旧版主体严格校验、来源溯源、禁止性推断和失败降级均保留；
- 未引入缓存、队列、权限、持久化或部署范围外的功能；
- 计划中没有 TODO、TBD 或未定义的接口名称。
