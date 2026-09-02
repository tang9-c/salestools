# Product Evidence Recall Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加上游调用次数、不扩大方舟请求容量、不放宽机会评级门槛的前提下，修复 QCC 招聘未知结构失败、豆包查询不聚焦和方舟产品证据被容量策略排除三个召回卡点。

**Architecture:** 保持现有模块边界：QCC mapper 只产生有界研究材料，search plan 只定义固定八类查询，Ark payload budget 只做固定字节内的证据选择，机会规则保持不变。招聘未知结构使用主体核验后的单条 material 降级；方舟装箱先保持融资和四类覆盖，再以一个两位信号掩码尽力加入明确产品证据和招聘/工程方法证据。

**Tech Stack:** Node.js 24、TypeScript、Vitest、Zod、官方 MCP SDK、SQLite。

## Global Constraints

- `MAX_QCC_CALLS`、`MAX_SEARCH_CALLS`、`MAX_ARK_CALLS` 和 `MAX_TOTAL_UPSTREAM_CALLS` 不因本修复增加。
- 豆包搜索计划严格保持 8 次。
- 方舟完整请求硬上限保持 `ARK_REQUEST_MAX_BYTES=12288`。
- 不新增模型预筛选、向量数据库、搜索索引、队列或持久化字段。
- 不修改 `src/opportunity/evaluate-product.ts` 的产品词、工程方法或评级门槛。
- QCC 未知招聘响应只保存一条最大 4096 UTF-8 字节的 material，不保存完整原始响应。
- 主体不匹配、解释文本、空招聘内容和上游工具错误不得通过 material 降级。
- 真实测试只在自动测试、类型检查和构建通过后提交一次正式任务；不得把凭据、完整 QCC 响应、网页正文或方舟完整输入输出写入仓库或日志。

---

## File Structure

- Modify: `src/upstream/qcc/mapper.ts` — 为 `get_recruitment_info` 增加主体核验后的单条有界 material 降级，并返回唯一审计缺口。
- Modify: `tests/qcc-adapter.test.ts` — 覆盖招聘未知结构降级、长度边界、主体冲突、解释文本、空内容和现有结构回归。
- Create: `tests/fixtures/qcc-recruitment-material.json` — 脱敏的主体匹配、字段未知招聘响应。
- Modify: `src/upstream/search/search-plan.ts` — 冻结用户确认的八类查询和动态时间策略。
- Modify: `tests/doubao-search.test.ts` — 精确断言八条查询、用途、内容和时间范围。
- Modify: `src/upstream/ark/payload-budget.ts` — 在四类覆盖之后增加明确产品信号及招聘/工程方法双专槽，并降低低信息密度候选优先级。
- Modify: `tests/ark-adapter.test.ts` — 覆盖双槽、去重、硬容量、无信号和现有四类覆盖。
- Create: `docs/validation/2026-09-02-product-evidence-recall-e2e.md` — 记录一次真实海柔创新复验的非敏感结果和剩余限制。

---

### Task 1: QCC 招聘未知结构 material 降级

**Files:**
- Create: `tests/fixtures/qcc-recruitment-material.json`
- Modify: `tests/qcc-adapter.test.ts`
- Modify: `src/upstream/qcc/mapper.ts`

**Interfaces:**
- Consumes: `mapQccToolResult(server, tool, payload, identity, collectedAt): MappedQccResult`、`assertExpectedSubject(...)`、`truncateUtf8(...)`。
- Produces: `get_recruitment_info` 在未知但可信结构下返回一条 `ResearchItem`，其 `content` 为 `{"material":"..."}`，并返回审计缺口 `招聘使用非结构化材料整理`。

- [ ] **Step 1: 添加脱敏未知结构夹具**

使用 `apply_patch` 创建 `tests/fixtures/qcc-recruitment-material.json`：

```json
{
  "企业名称": "测试制造有限公司",
  "统一社会信用代码": "91310000TEST000001",
  "招聘结果": [
    {
      "岗位": "产品研发平台工程师",
      "岗位详情": "负责 Windchill PLM、PDM、BOM 变更与配置管理平台维护",
      "最近更新": "2026-08-20"
    },
    {
      "岗位": "仿真工程师",
      "岗位详情": "使用 Abaqus 开展非线性有限元分析"
    }
  ],
  "附加未知字段": {
    "版本": "sanitized-v2"
  }
}
```

- [ ] **Step 2: 写入失败测试，冻结降级边界**

在 `tests/qcc-adapter.test.ts` 中新增测试，使用现有 `identity` 和 `fixture()`：

```ts
it('degrades an attributed unknown recruitment shape to one bounded material item', () => {
  const mapped = mapQccToolResult(
    'operation',
    'get_recruitment_info',
    fixture('qcc-recruitment-material.json'),
    identity,
    new Date('2026-08-29T12:00:00.000Z'),
  );

  expect(mapped.items).toHaveLength(1);
  expect(mapped.gaps).toContain('招聘使用非结构化材料整理');
  expect(mapped.items[0]).toMatchObject({
    evidenceId: 'qcc-operation-get_recruitment_info-1',
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
  });
  const content = JSON.parse(mapped.items[0]!.content ?? '{}');
  expect(content.material).toContain('Windchill');
  expect(content.material).toContain('Abaqus');
  expect(Buffer.byteLength(content.material, 'utf8')).toBeLessThanOrEqual(4096);
});

it('truncates unknown recruitment material instead of retaining the full response', () => {
  const payload = {
    企业名称: identity.legalName,
    统一社会信用代码: identity.creditCode,
    招聘结果: [{ 岗位: 'Creo工程师', 岗位详情: '参数化建模'.repeat(3000) }],
  };
  const mapped = mapQccToolResult(
    'operation', 'get_recruitment_info', payload, identity,
    new Date('2026-08-29T12:00:00.000Z'),
  );
  const material = JSON.parse(mapped.items[0]!.content ?? '{}').material as string;
  expect(Buffer.byteLength(material, 'utf8')).toBeLessThanOrEqual(4096);
  expect(material.endsWith('…')).toBe(true);
});
```

保留现有 explanation-only 和 subject-mismatch 参数化测试，并增加两个断言：

```ts
expect(() => mapQccToolResult(
  'operation', 'get_recruitment_info',
  { 企业名称: identity.legalName, 统一社会信用代码: identity.creditCode, 招聘结果: [] },
  identity, new Date('2026-08-29T12:00:00.000Z'),
)).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

expect(() => mapQccToolResult(
  'operation', 'get_recruitment_info',
  { 企业名称: '其他公司', 统一社会信用代码: identity.creditCode, 招聘结果: [{ 岗位: 'Creo工程师' }] },
  identity, new Date('2026-08-29T12:00:00.000Z'),
)).toThrow(expect.objectContaining({ code: 'SUBJECT_MISMATCH' }));
```

- [ ] **Step 3: 运行测试确认失败原因正确**

Run:

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts
```

Expected: 新 material 测试失败，原因是当前 `ChineseRecruitmentSchema` 拒绝未知字段结构；现有 explanation-only 和主体冲突测试仍通过。

- [ ] **Step 4: 实现最小招聘 material 适配**

在 `src/upstream/qcc/mapper.ts` 中增加：

```ts
const RECRUITMENT_MATERIAL_GAP = '招聘使用非结构化材料整理';
const RecruitmentMaterialRecordSchema = z.object({
  RecruitmentMaterial: z.string().trim().min(1),
  Url: OptionalUrlSchema,
}).passthrough();

function recruitmentText(value: unknown): string {
  return JSON.stringify(value);
}

function hasRecruitmentMaterial(value: unknown): boolean {
  const text = recruitmentText(value).normalize('NFKC');
  return /(?:招聘结果|招聘信息|招聘记录|招聘职位|岗位详情|岗位职责|任职要求|职位描述|职位要求)/u.test(text)
    && /(?:岗位|职位|职责|要求|工程师|管理员|顾问)/u.test(text);
}

function recruitmentMaterialRecord(
  root: Record<string, unknown>,
  expected: ExpectedQccSubject,
): Record<string, unknown> {
  assertExpectedSubject(root, expected);
  if (!hasRecruitmentMaterial(root)) {
    throw invalidResponse('QCC recruitment response does not contain recruitment material');
  }
  return {
    RecruitmentMaterial: truncateUtf8(recruitmentText(root), MATERIAL_MAX_BYTES),
    Url: materialSourceUrl([root]),
  };
}
```

调整 `formalRecords()` 的招聘中文分支：先尝试 `ChineseRecruitmentSchema.safeParse(root)`；成功时沿用现有字段映射，失败时返回 `[recruitmentMaterialRecord(root, expected)]`。标准 `Data` 数组路径中，若所有记录都能通过 `RecruitmentRecordSchema` 则原样返回；否则把 `{ 企业名称: expected.legalName, 统一社会信用代码: expected.creditCode, 招聘结果: records }` 交给 `recruitmentMaterialRecord()`，仍先对每条存在的主体字段执行 `assertExpectedSubject()`。

在 `safeMappedRecord()` 的招聘分支最前面识别 `RecruitmentMaterialRecordSchema`：

```ts
const material = RecruitmentMaterialRecordSchema.safeParse(record);
if (material.success) {
  return {
    titleDetail: '招聘材料',
    summary: '招聘信息（企查查材料，待模型整理）',
    content: { material: material.data.RecruitmentMaterial },
    publishedAt: null,
    url: safeUrl(stringValue(material.data, 'Url')),
  };
}
```

在 `mapQccToolResult()` 返回 gaps 时，将 material 降级缺口与无直链缺口合并去重：

```ts
const usedRecruitmentMaterial = tool === 'get_recruitment_info'
  && records.some(record => RecruitmentMaterialRecordSchema.safeParse(record).success);
return {
  items,
  gaps: [...new Set([
    ...(usedRecruitmentMaterial ? [RECRUITMENT_MATERIAL_GAP] : []),
    ...items.filter(item => item.url === null)
      .map(item => qccUnavailableLinkAuditGap(item.evidenceId)),
  ])],
};
```

- [ ] **Step 5: 运行 QCC 回归**

Run:

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts
```

Expected: QCC adapter 文件全部通过；未知结构只生成一条最大 4096 字节 material；解释文本、空内容和主体冲突仍被拒绝。

- [ ] **Step 6: 提交 Task 1**

```bash
rtk git add src/upstream/qcc/mapper.ts tests/qcc-adapter.test.ts tests/fixtures/qcc-recruitment-material.json
rtk git commit -m "fix: preserve attributed qcc recruitment material"
```

---

### Task 2: 冻结豆包八类查询

**Files:**
- Modify: `tests/doubao-search.test.ts`
- Modify: `src/upstream/search/search-plan.ts`

**Interfaces:**
- Consumes: `buildSearchPlan(identity): SearchQuery[]` 和现有七种 `purpose` 枚举；不新增调用类型。
- Produces: 严格 8 条查询，其中第 4 条为 `software_ecosystem`，第 5、6 条为最近一年 `recruitment`。

- [ ] **Step 1: 用精确查询断言替换宽泛招聘断言**

在 `tests/doubao-search.test.ts` 的 `buildSearchPlan` describe 中新增：

```ts
it('uses the eight approved research intents without increasing the call count', () => {
  const plan = buildSearchPlan(identity);
  expect(plan.map(query => ({ purpose: query.purpose, terms: query.Query.replace(`${query.searchedName} `, '') })))
    .toEqual([
      { purpose: 'official_products', terms: '官网 产品 技术' },
      { purpose: 'engineering', terms: '研发 工程 中心' },
      { purpose: 'quality', terms: '质量 体系 认证' },
      { purpose: 'software_ecosystem', terms: 'PLM QMS PDM' },
      { purpose: 'recruitment', terms: '招聘 Creo CATIA SolidWorks CAD PDM' },
      { purpose: 'recruitment', terms: '招聘 Abaqus CST CAE 有限元 电磁仿真' },
      { purpose: 'procurement', terms: '招投标 数字化 采购' },
      { purpose: 'expansion_financing', terms: '扩产 融资' },
    ]);
});
```

更新时间与内容断言：第 4 条 `NeedContent=true` 且无 `TimeRange`；第 5、6 条均为 `NeedContent=true, TimeRange='OneYear'`；总动态查询仍为 4 条。

- [ ] **Step 2: 运行测试确认旧查询失败**

```bash
rtk npm test -- --run tests/doubao-search.test.ts
```

Expected: 精确八类查询断言失败，显示旧第 3、4、5、6、7 条关键词不同。

- [ ] **Step 3: 修改固定 plans，不改调用数量或 purpose Schema**

将 `src/upstream/search/search-plan.ts` 的 `plans` 替换为：

```ts
const plans = [
  { purpose: 'official_products', terms: '官网 产品 技术' },
  { purpose: 'engineering', terms: '研发 工程 中心' },
  { purpose: 'quality', terms: '质量 体系 认证' },
  { purpose: 'software_ecosystem', terms: 'PLM QMS PDM' },
  { purpose: 'recruitment', terms: '招聘 Creo CATIA SolidWorks CAD PDM' },
  { purpose: 'recruitment', terms: '招聘 Abaqus CST CAE 有限元 电磁仿真' },
  { purpose: 'procurement', terms: '招投标 数字化 采购' },
  { purpose: 'expansion_financing', terms: '扩产 融资' },
] as const;
```

保持 `needsContent` 与 `needsOneYear` 的现有按-purpose逻辑，不增加条件分支。

- [ ] **Step 4: 运行搜索与调用预算相关测试**

```bash
rtk npm test -- --run tests/doubao-search.test.ts tests/call-budget.test.ts tests/assessment-runner.test.ts
```

Expected: 三个测试文件全部通过；搜索仍恰好 8 次，整体预算没有改变。

- [ ] **Step 5: 提交 Task 2**

```bash
rtk git add src/upstream/search/search-plan.ts tests/doubao-search.test.ts
rtk git commit -m "fix: focus the eight search intents on product evidence"
```

---

### Task 3: 方舟产品信号与招聘方法双专槽

**Files:**
- Modify: `tests/ark-adapter.test.ts`
- Modify: `src/upstream/ark/payload-budget.ts`

**Interfaces:**
- Consumes: `compactResearchBundleForArk(bundle, requestMaxBytes, measureBytes): ArkPayloadSelection`、`buildSearchPlan()` 生成的 query-to-purpose 映射。
- Produces: 固定容量内在已有融资和四类覆盖后，尽力加入一个明确产品信号和一个招聘/工程方法信号；不改变 `ArkPayloadSelection` 的公开结构。

- [ ] **Step 1: 添加四个失败测试**

在 `tests/ark-adapter.test.ts` 使用现有 `minimumResearchBundle()`、`researchBundle()` 和 `buildSearchPlan()` 增加以下压力 bundle 辅助函数。四类保留项的正文可以缩短，12 条普通搜索结果会在旧算法中先消耗剩余空间；信号项放在普通已链接官网结果之后，确保测试验证专槽而不是现有“至少一条直链”逻辑：

```ts
function productRecallPressureBundle(signal: 'product' | 'method' | 'combined' | 'none'): ResearchBundle {
  const base = minimumResearchBundle();
  const template = researchBundle().items[0]!;
  const queries = new Map(buildSearchPlan(base.identity).map(query => [query.purpose, query.Query]));
  const common = {
    ...template,
    title: '普通企业资料',
    summary: '普通摘要'.repeat(80),
    content: '普通正文'.repeat(240),
    mentionedName: base.identity.legalName,
    entityScope: 'legal_entity' as const,
    entityMatch: 'confirmed' as const,
    matchBasis: ['法定名称一致'],
  };
  const qcc = (evidenceId: string, sourceKind: ResearchItem['sourceKind']): ResearchItem => ({
    ...common, evidenceId, source: 'qcc', sourceKind,
    url: null, query: null, position: null, logId: null,
  });
  const search = (evidenceId: string, purpose: 'official_products' | 'quality' | 'software_ecosystem' | 'recruitment', content: string): ResearchItem => ({
    ...common, evidenceId, source: 'doubao_search', sourceKind: 'web',
    url: `https://evidence.example.cn/${evidenceId}`,
    originalPublisher: '测试发布方', originalDomain: 'evidence.example.cn',
    query: queries.get(purpose)!, position: 1, logId: 'sanitized-log', content,
  });
  const categories = [
    qcc('qcc-company-get_company_profile-1', 'company'),
    qcc('qcc-ipr-get_patent_info-1', 'ipr'),
    qcc('qcc-operation-get_recruitment_info-1', 'operation'),
    qcc('qcc-risk-get_company_risk_scan-1', 'risk'),
  ];
  const ordinary = [
    search('search-official-generic', 'official_products', '公司官网介绍自动化产品。'),
    ...Array.from({ length: 12 }, (_, index) => search(
      `search-generic-${index}`,
      'quality',
      `质量认证一般资料 ${index} ${'背景'.repeat(180)}`,
    )),
  ];
  const signals = signal === 'product'
    ? [search('search-creo-product', 'software_ecosystem', '公司研发环境明确使用 Creo。')]
    : signal === 'method'
      ? [search('search-finite-element-job', 'recruitment', '招聘仿真工程师，岗位职责包括非线性有限元分析。')]
      : signal === 'combined'
        ? [search('search-cst-job', 'recruitment', '招聘电磁仿真工程师，任职要求使用 CST 开展天线仿真。')]
        : [];
  return { ...base, items: [...categories, ...ordinary, ...signals] };
}
```

随后添加：

```ts
it('keeps explicit product evidence when generic evidence fills the request budget', () => {
  const research = productRecallPressureBundle('product');
  const selection = compactResearchBundleForArk(
    research, 12_288,
    candidate => Buffer.byteLength(serializedRequest('ep-test', candidate), 'utf8'),
  );
  expect(selection.bundle.items.map(item => item.evidenceId)).toContain('search-creo-product');
  expect(selection.researchBytes).toBeLessThanOrEqual(12_288);
});

it('keeps one substantive recruitment or engineering-method item under pressure', () => {
  const research = productRecallPressureBundle('method');
  const selection = compactResearchBundleForArk(
    research, 12_288,
    candidate => Buffer.byteLength(serializedRequest('ep-test', candidate), 'utf8'),
  );
  expect(selection.bundle.items.map(item => item.evidenceId)).toContain('search-finite-element-job');
});

it('uses one item once when it satisfies both signal slots', () => {
  const research = productRecallPressureBundle('combined');
  const selection = compactResearchBundleForArk(research, 12_288);
  expect(selection.bundle.items.filter(item => item.evidenceId === 'search-cst-job')).toHaveLength(1);
});

it('does not manufacture signal reservations when no candidate contains a signal', () => {
  const research = productRecallPressureBundle('none');
  const first = compactResearchBundleForArk(research, 12_288);
  const second = compactResearchBundleForArk(research, 12_288);
  expect(first.bundle.items.map(item => item.evidenceId))
    .toEqual(second.bundle.items.map(item => item.evidenceId));
  expect(first.categoryCounts).toEqual(second.categoryCounts);
});
```

每个有信号测试先断言“仅四类候选加目标信号”的序列化请求不超过 12,288 字节，并断言完整压力 bundle 的序列化请求超过 12,288 字节。不得使用按 evidence ID 返回不同结果的伪造 `measureBytes`。

- [ ] **Step 2: 运行测试，确认产品信号当前会被排除**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
```

Expected: 至少产品专槽和招聘/方法专槽测试失败；现有四类覆盖、融资和直链保留测试继续通过。

- [ ] **Step 3: 增加本地信号判定，不创建共享规则平台**

在 `src/upstream/ark/payload-budget.ts` 的关键词规则附近增加：

```ts
const EXPLICIT_PRODUCT_SIGNAL_PATTERN =
  /\b(?:windchill|feigenbaum(?:\s+qms)?|plm|qms|pdm|creo|pro\s*\/?\s*e|catia|3dexperience|abaqus|cst(?:\s+studio(?:\s+suite)?)?|solid\s*works)\b/iu;

const ENGINEERING_METHOD_SIGNAL_PATTERN =
  /(?:bom|ebom|mbom|capa|配置管理|变更管理|质量追溯|供应商质量|参数化建模|复杂曲面|大型装配|有限元|非线性|碰撞仿真|疲劳仿真|多物理场|电磁仿真|射频|天线|雷达|微波|emc|emi)/iu;

const SUBSTANTIVE_RECRUITMENT_PATTERN =
  /(?:岗位职责|任职要求|职位描述|职位要求|工作职责|招聘职位).{0,240}(?:工程师|管理员|顾问|经理)|(?:工程师|管理员|顾问|经理).{0,240}(?:岗位职责|任职要求|职位描述|职位要求|工作职责)/iu;

function itemText(item: ResearchItem): string {
  return [item.title, item.summary ?? '', item.content ?? ''].join('\n').normalize('NFKC');
}

function signalMask(item: ResearchItem): number {
  const text = itemText(item);
  const product = EXPLICIT_PRODUCT_SIGNAL_PATTERN.test(text) ? 1 : 0;
  const recruitmentOrMethod = ENGINEERING_METHOD_SIGNAL_PATTERN.test(text)
    || SUBSTANTIVE_RECRUITMENT_PATTERN.test(text) ? 2 : 0;
  return product | recruitmentOrMethod;
}
```

这些函数只用于装箱，不导出、不参与机会评级。

- [ ] **Step 4: 在四类 reservation 后增加两位信号 reservation**

在 `fittedReservation` 建立后、linked-search 保留前执行一个固定四状态的小型选择过程。它从保持四类覆盖的 `states` 出发，只比较 `signalMask` 为 1、2、3 的未选候选：

```ts
type SignalReservation = Readonly<{ states: ItemState[]; mask: number; bytes: number }>;

const reserveSignals = (
  initial: ItemState[],
  candidates: readonly ResearchItem[],
): ItemState[] => {
  const reservations: Array<SignalReservation | null> = [
    { states: initial, mask: 0, bytes: measureBytes(compactFor(initial)) },
    null,
    null,
    null,
  ];
  for (const item of candidates) {
    const itemMask = signalMask(item);
    if (itemMask === 0) continue;
    const previous = reservations.slice();
    for (const reservation of previous) {
      if (reservation === null || (reservation.mask | itemMask) === reservation.mask) continue;
      const trial = fitCandidate(reservation.states, item);
      if (trial === null) continue;
      const nextMask = reservation.mask | itemMask;
      const bytes = measureBytes(compactFor(trial));
      const current = reservations[nextMask];
      if (current === null || bytes < current.bytes) {
        reservations[nextMask] = { states: trial, mask: nextMask, bytes };
      }
    }
  }
  const signalCount = (mask: number): number => (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0);
  const best = reservations
    .filter((entry): entry is SignalReservation => entry !== null)
    .sort((left, right) => signalCount(right.mask) - signalCount(left.mask)
      || Number(right.mask === 3) - Number(left.mask === 3)
      || left.bytes - right.bytes)[0]!;
  return best.states;
};
```

更新 `selectedIds` 后再执行现有 linked-search 和普通 fallback。这样同一条 mask=3 的证据只加入一次，四类 reservation 不被替换。

如果某个信号在原始候选中存在但最小合法片段无法与四类 reservation 同时放入，现有 `arkInputBudgetGap()` 已说明容量排除；不新增持久化字段或第二套 gap。

- [ ] **Step 5: 降低低信息密度候选的普通 fallback 优先级**

在本文件内增加：

```ts
function lowInformationOnly(item: ResearchItem): boolean {
  const text = itemText(item).replace(item.mentionedName.normalize('NFKC'), '').trim();
  return text.length < 32
    && signalMask(item) === 0
    && !/(?:融资|扩产|专利|认证|采购|招标|中标|研发|产品|技术)/u.test(text);
}
```

只在 `fallback` 的稳定优先级末位对 `lowInformationOnly(item)` 增加 100 点惩罚：先计算现有 QCC 或 search priority 为 `basePriority`，再返回 `basePriority + (lowInformationOnly(item) ? 100 : 0)`。不得在采集阶段删除该证据，也不得让此函数影响四类 reservation、融资或专槽候选。

- [ ] **Step 6: 运行 Ark 回归和性能边界测试**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
```

Expected: 新双专槽测试通过；现有动态四类覆盖、20 候选每类的测量次数上限、最小合法请求、融资专槽和直链搜索证据测试全部通过；所有最终 request bytes 不超过各测试配置上限。

- [ ] **Step 7: 提交 Task 3**

```bash
rtk git add src/upstream/ark/payload-budget.ts tests/ark-adapter.test.ts
rtk git commit -m "fix: reserve product and recruitment evidence for ark"
```

---

### Task 4: 完整回归与一次真实海柔创新复验

**Files:**
- Create: `docs/validation/2026-09-02-product-evidence-recall-e2e.md`
- Modify only if verification finds a reproducible defect: the Task 1–3 source/test files, using a new failing test before any fix.

**Interfaces:**
- Consumes: 四个 MCP 工具、真实 `.env`、隔离 SQLite、已确认主体“深圳市海柔创新科技有限公司”及信用代码 `91440300MA5DR1JD5X`。
- Produces: 自动验证结果和一次真实任务的脱敏验收记录；不产生新的公开 API。

- [ ] **Step 1: 运行完整自动验证**

分别运行，避免一个命令的输出掩盖另一个失败：

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Expected: 全部测试通过；测试数不少于当前 606 项；类型检查、构建和 diff check 均为 exit 0。

- [ ] **Step 2: 创建忽略的真实验证脚本和隔离数据库**

使用 `apply_patch` 创建 `.superpowers/product-evidence-recall-e2e.mjs`，不得加入 Git。写入以下完整脚本；信号正则与 Task 3 逐字一致，输出只包含计数和报告元数据：

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { config as loadDotEnv } from 'dotenv';
import { createApplication } from '../dist/index.js';
import { loadConfig } from '../dist/config.js';
import { ArkEvidenceService } from '../dist/upstream/ark/client.js';

loadDotEnv({ quiet: true });

const legalName = '深圳市海柔创新科技有限公司';
const creditCode = '91440300MA5DR1JD5X';
const sqlitePath = '.superpowers/product-evidence-recall-e2e.sqlite';
const env = {
  ...process.env,
  PORT: '3000',
  PUBLIC_MCP_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://localhost',
  SQLITE_PATH: sqlitePath,
};
const config = loadConfig(env);

const EXPLICIT_PRODUCT_SIGNAL_PATTERN =
  /\b(?:windchill|feigenbaum(?:\s+qms)?|plm|qms|pdm|creo|pro\s*\/?\s*e|catia|3dexperience|abaqus|cst(?:\s+studio(?:\s+suite)?)?|solid\s*works)\b/iu;
const ENGINEERING_METHOD_SIGNAL_PATTERN =
  /(?:bom|ebom|mbom|capa|配置管理|变更管理|质量追溯|供应商质量|参数化建模|复杂曲面|大型装配|有限元|非线性|碰撞仿真|疲劳仿真|多物理场|电磁仿真|射频|天线|雷达|微波|emc|emi)/iu;
const SUBSTANTIVE_RECRUITMENT_PATTERN =
  /(?:岗位职责|任职要求|职位描述|职位要求|工作职责|招聘职位).{0,240}(?:工程师|管理员|顾问|经理)|(?:工程师|管理员|顾问|经理).{0,240}(?:岗位职责|任职要求|职位描述|职位要求|工作职责)/iu;

const textOf = item => [item.title, item.summary ?? '', item.content ?? ''].join('\n').normalize('NFKC');
const productSignal = item => EXPLICIT_PRODUCT_SIGNAL_PATTERN.test(textOf(item));
const methodSignal = item => ENGINEERING_METHOD_SIGNAL_PATTERN.test(textOf(item))
  || SUBSTANTIVE_RECRUITMENT_PATTERN.test(textOf(item));

let arkAudit = null;
const realArk = new ArkEvidenceService({
  url: config.arkApiUrl,
  model: config.arkModel,
  credential: config.arkCredential,
  requestMaxBytes: config.arkRequestMaxBytes,
});
const wrappedArk = {
  async extractWithAudit(bundle) {
    const extraction = await realArk.extractWithAudit(bundle);
    const selected = extraction.selection.bundle.items;
    const recruitmentItems = bundle.items.filter(item => item.evidenceId.includes('-get_recruitment_info-'));
    const recruitmentPath = recruitmentItems.some(item => {
      try { return typeof JSON.parse(item.content ?? '{}').material === 'string'; } catch { return false; }
    }) ? 'material'
      : recruitmentItems.length > 0 ? 'structured'
        : bundle.gaps.some(gap => gap.includes('get_recruitment_info未查到') || gap.includes('招聘信息') && gap.includes('未查到')) ? 'empty'
          : bundle.gaps.some(gap => gap.includes('招聘信息获取失败')) ? 'upstream_failed'
            : 'unknown';
    arkAudit = {
      recruitmentPath,
      originalCount: extraction.selection.originalCount,
      selectedCount: extraction.selection.selectedCount,
      excludedCount: extraction.selection.excludedCount,
      categoryCounts: extraction.selection.categoryCounts,
      productCandidates: bundle.items.filter(productSignal).length,
      productSelected: selected.filter(productSignal).length,
      methodCandidates: bundle.items.filter(methodSignal).length,
      methodSelected: selected.filter(methodSignal).length,
      requestBytes: extraction.requestBytes,
    };
    return extraction;
  },
};

const runtime = createApplication(config, { ark: wrappedArk });
const token = runtime.tokenService.create('product-evidence-recall-e2e');
const server = await runtime.listen(0, '127.0.0.1');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('Local listener has no TCP port');
const client = new Client(
  { name: 'product-evidence-recall-e2e', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const startedAt = Date.now();

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError || typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error(`MCP tool failed: ${name}`);
  }
  return result.structuredContent;
};

try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const profile = await call('get_company_profile', { query: legalName });
  if (profile.source_status !== 'completed'
    || profile.candidates?.length !== 1
    || profile.candidates[0]?.legal_name !== legalName
    || profile.candidates[0]?.credit_code !== creditCode
    || profile.basic_profile === null) {
    throw new Error('Exact company profile was not persisted');
  }

  const submitted = await call('submit_assessment', {
    legal_name: legalName,
    credit_code: creditCode,
    force_refresh: true,
  });
  const assessmentId = String(submitted.assessment_id);
  let status = submitted;
  for (let attempt = 0; attempt < 120 && status.status === 'processing'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    status = await call('get_assessment_status', { assessment_id: assessmentId });
  }
  if (status.status !== 'completed') {
    process.stdout.write(JSON.stringify({
      assessmentId,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      status: status.status,
      message: status.message,
      arkAudit,
    }));
    process.exitCode = 1;
  } else {
    const report = await call('get_assessment_report', { assessment_id: assessmentId });
    const markdown = String(report.markdown ?? '');
    process.stdout.write(JSON.stringify({
      assessmentId,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      status: report.status,
      sourceStatus: report.source_status,
      overallOpportunity: report.overall_opportunity,
      recommendedProduct: report.recommended_product,
      directLinkCount: (markdown.match(/https?:\/\//gu) ?? []).length,
      productRows: markdown.split('\n').filter(line => /^\| (?:PTC|Feigenbaum|Dassault|CST)/u.test(line)),
      arkAudit,
    }));
  }
} finally {
  await client.close().catch(() => undefined);
  await runtime.close();
}
```

脚本不得增加任何调试输出，不得打印 Token、环境变量、ResearchBundle、网页正文、QCC 响应或方舟请求。

- [ ] **Step 3: 执行一次真实任务**

先确认隔离数据库不存在正在处理的任务；如存在，停止并调查，不得提交第二个任务。然后运行：

```bash
rtk node .superpowers/product-evidence-recall-e2e.mjs
```

Expected:

- 精确主体画像成功并入库。
- 只产生一个新的 completed 或有明确错误的 failed assessment ID。
- QCC 招聘结果被记录为结构化成功、material 降级、空数据或实际上游失败之一，不能再把可识别未知结构误报为不可读。
- 若内存审计发现产品信号，Ark 入选集中至少有一条产品信号。
- 若内存审计发现招聘/工程方法信号，Ark 入选集中至少有一条招聘/方法信号。
- 最终方舟请求不超过 12,288 字节。
- 报告可以合法保持“待核实”和 `recommended_product:null`。

- [ ] **Step 4: 若真实验证失败，遵守单假设调试和 TDD**

只读收集 assessment 状态、普通日志、`result_json` 和内存计数。不得保存原始响应。为一个已确认根因先在对应测试文件加入最小失败测试，运行确认红灯，再做一处修复并重新跑 Task 1–3 对应测试。修复通过后单独提交：

```bash
rtk git add src/upstream/qcc/mapper.ts tests/qcc-adapter.test.ts src/upstream/search/search-plan.ts tests/doubao-search.test.ts src/upstream/ark/payload-budget.ts tests/ark-adapter.test.ts
rtk git commit -m "fix: handle real product evidence edge case"
```

提交前用 `rtk git status --short` 核对这些已知任务文件，不得使用 glob。真实任务在代码修复前不得重复提交；修复后最多再提交一次，并在验收记录中明确首次失败和第二次提交原因。

- [ ] **Step 5: 写入脱敏验收记录**

使用 `apply_patch` 创建 `docs/validation/2026-09-02-product-evidence-recall-e2e.md`。文档标题固定为“产品机会证据召回真实验收”，并直接写入运行得到的 assessment ID、秒数、实际提交次数、三个来源状态、招聘路径、原始/入选/排除证据计数、两类信号候选及入选计数、方舟请求字节、报告直链数、七产品结果和推荐产品。结论只陈述召回链路是否通过以及仍然存在的外部数据或模型引用限制，不得声称销售准确率通过；运行值未知时不得提交文档。

- [ ] **Step 6: 清理临时验证资产并复验工作区**

停止本地服务后，删除明确的忽略文件：

```bash
rtk rm -f .superpowers/product-evidence-recall-e2e.mjs
rtk rm -f .superpowers/product-evidence-recall-e2e.sqlite
rtk rm -f .superpowers/product-evidence-recall-e2e.sqlite-shm
rtk rm -f .superpowers/product-evidence-recall-e2e.sqlite-wal
rtk git status --short
```

Expected: 只有验收文档或已通过 TDD 的必要源代码改动；没有 `.env`、SQLite、临时脚本或原始数据进入 Git 状态。

- [ ] **Step 7: 最终验证并提交验收记录**

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git add docs/validation/2026-09-02-product-evidence-recall-e2e.md
rtk git commit -m "docs: record product evidence recall verification"
```

Expected: 所有命令 exit 0，工作区干净，最后提交只包含验收记录；真实验证触发的必要修复已经在 Step 4 单独提交。

---

## Completion Checklist

- [ ] 未知但主体可信的 QCC 招聘结构生成一条最大 4096 字节 material。
- [ ] 主体冲突、解释文本、空招聘和上游错误仍然失败。
- [ ] 豆包固定为用户确认的 8 条查询，不增加调用预算。
- [ ] 12,288 字节内尽力保留明确产品词和招聘/工程方法证据。
- [ ] 四类覆盖、融资、直链和确定性机会规则未退化。
- [ ] 完整测试、类型检查、构建和 diff check 通过。
- [ ] 海柔创新只提交一次正式复验；只有真实验证暴露且修复了新根因时允许第二次。
- [ ] 真实报告不因验收要求被强制升级，不伪造推荐产品。
- [ ] 仓库不包含凭据、临时 SQLite、原始 QCC 响应、网页正文或方舟完整输入输出。
