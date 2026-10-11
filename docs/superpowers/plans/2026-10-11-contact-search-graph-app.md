# 联系人搜索图谱 MCP App 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 不自动派生子代理；当前任务内顺序执行即可。

**Goal:** 将 `search_contacts` 的现有搜索结果显示为只读、证据可追溯的独立 MCP 图谱 App。

**Architecture:** 搜索工具关联自包含 UI 资源，保留原 JSON。浏览器先显示命中节点，再经宿主顺序读完当前搜索页每个命中根的全部一跳关系页并逐步绘制；补充端点只读取名称/类型，不遍历其关系。点击查看详情与证据，不清空图。复用现有鉴权、存储和打包，不增加业务接口。

**Tech Stack:** 现有 TypeScript、MCP SDK、`@modelcontextprotocol/ext-apps`、HTML/CSS/SVG、esbuild、Vitest、Playwright；不增加依赖。

**Spec:** [联系人搜索图谱 App 设计](../specs/2026-10-11-contact-search-graph-app-design.md)。实施前必须读完整设计及仓库 `AGENTS.md`。

## 执行记录（2026-10-11）

- 隔离分支：`feat/contact-search-graph`，基于 `75005bf7e85298a6972fcfb799a100685bf3cd9b`；工作区 `.worktrees/contact-search-graph`。应用 worktree 工具因当前聊天根目录不是 Git 仓库而不可用，已使用被忽略的项目内 Git worktree。
- Task 1、2：图模型、可选资源注册、生产注入和 JSON/鉴权兼容已实现，本地对应测试通过。
- Task 3、4：页面、自动全部一跳分页、名称补读、详情/证据分页、停止/继续、失败页重试、单请求串行与旧响应隔离已实现；真实 SDK + Chrome 的无构建解释器测试通过。真实 bundle 仍待 CI，不将解释器测试算作 bundle 验收。
- Task 5：已有 CI 和生产容器 gate 已覆盖两个页面；远程构建、完整原生回归、bundle 和生产镜像执行待用户授权提交/推送。真实 Codex/ChatGPT 宿主及部署尚未验收，不得标记整个计划完成。
- Task 6：README、PRD、QUICKSTART、联系人 skill 已同步；测试与缺口记录见 [验证记录](../../validation/2026-10-11-contact-search-graph-app.md)。skill 仅做窄范围更新，未安装到本机全局目录。
- 下方未勾选清单保留为完整验收核对表，不以“代码已写”代替测试或外部验收。

## Global Constraints

- `search_contacts` 输入、文本 JSON、`structuredContent`、筛选与分页行为不变；只增加 UI 元数据。
- 不新增 `open_contact_graph`、HTTP 查询路由、会话、Cookie、数据库迁移、上游研究或 LLM 分析。
- 只读调用固定为 `search_contacts` 和 `get_contact`；不新增写工具调用。
- 正式边按 `relation_id` 去重，待核实边按 `claim_id` 去重，人物与机构按 `entity_id` 去重；不能按姓名合并。
- 首屏自动加载所有命中根的全部一跳关系，不递归补充端点。只保留当前搜索页累计材料及单个选中详情，无跨查询缓存、通用队列或静默截断；每次请求30秒，不承诺整图30秒完成。
- 正式边和 claim 共用 worksFor/alumniOf/memberOf/clientOrganization/affiliation 范围；不显示家庭关系及其证据/线索。
- 原查询参数未到时 claim_limit=0 并标记未加载；收到 include_unverified=true 后自动补读当前页所有命中根的 claim 页。仅返回主体自身 claim，入向 claim 不在本次能力中。
- 搜索分页替换画布；自动关系/claim 分页累计，详情三集合分页只替换面板。补充节点不计入搜索总数。
- 本地不构建；真实 bundle/原生/生产镜像验证只在远程 CI。既有无关改动不得提交或覆盖。

## 文件职责

| 文件 | 改动与职责 |
|---|---|
| `web/contact-search-graph-model.ts` | 新增：当前页及累计一跳材料生成节点/边的纯函数、职业范围过滤 |
| `web/contact-search-graph.html` | 新增：画布、图例、状态、分页、列表、详情与证据区域 |
| `web/contact-search-graph.ts` | 新增：SDK 生命周期、固定工具调用、UI 请求状态、SVG 与详情渲染 |
| `src/mcp/contact-search-tools.ts` | 可选 App 资源参数与 search 工具注册 |
| `src/mcp/contact-tools.ts` | `get_contact` 保持模型可用并声明 App 可调用 |
| `src/mcp/tools.ts`、`src/index.ts` | 可选 App html loader 的类型和生产注入 |
| `scripts/build-contact-upload.mjs` | 两个明确页面入口，保留现有上传输出 |
| `tests/contact-search-tools.test.ts` | JSON 兼容与新资源注册 |
| `tests/contact-search-graph-model.test.ts` | 新增：纯图模型与语义边界 |
| `tests/contact-search-graph-app.test.ts` | 新增：真实 HTTP/MCP 的资源、鉴权与只读注册 |
| `tests/contact-search-graph-browser.test.ts` | 新增：远程 CI 执行真实 SDK iframe/DOM 与异步交互 |
| `tests/contact-upload-build.test.ts` | 多入口打包与脚本字符串转义回归 |
| `.github/workflows/contact-upload-validation.yml` | 当前 build/full test 包含新页面；CI 必须要求新 bundle 验收，不跳过 |
| `docs/PRD.md`、`docs/QUICKSTART.md`、`README.md`、`skills/salestools-contact-management/SKILL.md` | 用户入口、只读/待核实/宿主限制 |
| `docs/validation/2026-10-11-contact-search-graph-app.md` | 实施时新增：版本/SHA/测试与宿主证据 |

## Task 1：当前页图形与不推断关系的回归测试

**Interfaces:** 在 `web/contact-search-graph-model.ts` 定义并导出：

```ts
import type { ContactSearch, ContactSearchInput } from '../src/contacts/contact-search.js';
import type { ContactLibraryService } from '../src/contacts/library-service.js';
export type SearchInput = ContactSearchInput;
export type SearchPage = Awaited<ReturnType<ContactSearch['search']>>;
export type ContactDetail = NonNullable<Awaited<ReturnType<ContactLibraryService['get']>>>;
export type GraphNode = {
  id: string; label: 'Person' | 'Organization' | 'Project' | 'Unknown';
  title: string; matched: boolean;
};
export type GraphEdge = {
  id: string; source: string; target: string; type: string;
  status: 'recorded' | 'unverified';
  record: Record<string, unknown>;
};
export type GraphState = {
  nodes: GraphNode[]; edges: GraphEdge[];
};
// 仅保存当前搜索页的材料；每项 detail 是某个命中根的一页返回。
export function toGraph(
  page: SearchPage, details?: ContactDetail[], includeUnverified?: boolean,
): GraphState;
```

前三个 type-only 别名复用服务契约，不把 Node/Rust 运行时代码打入浏览器。`get` 当前返回 Record，边界检查 entity、集合和游标中实际用到的字段；缺失必需结构显示响应异常，不强转或重新建立完整 Schema。GraphEdge.id 采用 relation:<relation_id>/claim:<claim_id>，record 保留原关系/claim 供面板解释。details也可含端点最小量返回，但入集合前清空其relations/claims，仅供名称/类型；非目标分页集合同样清空。纯函数只采纳搜索命中根的一跳边，不采纳补充端点的其他边。

- [ ] 先写测试，证明相同搜索页里的两个节点不自动连线、同名不同 ID 不合并、未知端点不推断名称。示例：

```ts
it('does not invent employment from search matches or titles', () => {
  const state = toGraph({ items: [
    { entity_id: 'p1', label: 'Person', name: '林知远' },
    { entity_id: 'o1', label: 'Organization', name: '云杉智造' },
  ], total: 2, mode_used: 'keyword', warnings: [] });
  expect(state.nodes.map(node => node.id)).toEqual(['p1', 'o1']);
  expect(state.edges).toEqual([]);
});
```

- [ ] 写 table-driven 测试：五种职业关系保留 source/target；`worksFor` unknown 不变成 current；`alumniOf` 不声称毕业；正式与 claim 同端点保留不同 ID；当前页重复 ID 去重；未启用 claim 时不画虚线；无 target_id/非当前主体/家庭关系 claim 不画边；memberOf/clientOrganization 不改成 worksFor。
- [ ] 运行解释器测试，看见预期失败：`node node_modules/vitest/vitest.mjs run tests/contact-search-graph-model.test.ts --reporter=dot`。
- [ ] 实现最小纯函数：按真实 ID 使用 Map 去重，未知端点生成 Unknown 占位；实线和虚线共用职业关系 Set。只采纳返回实体是搜索命中根且该根是端点的正式边，以及 subject_id 为该根的 claim。不让 jobTitle/matched_project_id 参与造边。
- [ ] 加入范围测试：两个根累计多个关系页，超过20条仍全部可见；共同端点/共同正式边去重，入向/出向均保留；补充端点的其他关系被排除。端点名称补读不新增边；新搜索页不残留旧材料，不改搜索 total，不建立100/200容量截断。
- [ ] 再运行本任务全部测试，类型检查通过后进行独立 diff review；提交仅在用户授权时执行。

## Task 2：MCP App 资源注册和 JSON 兼容

**Interfaces:** `McpServices.contactSearchApp?: { html: () => Promise<string> }`；扩展注册函数的最后一个参数：

```ts
registerContactSearchTools(server, search, indexer?, app?: {
  html: () => Promise<string>;
}): void
```

所有现有三参数调用仍有效。URI 固定 `ui://salestools/contact-search-graph.html`。

- [ ] 扩展 `tests/contact-search-tools.test.ts`：有 App 时 listTools 包含资源关联；readResource 能读自包含 HTML；不加新 opener；参数 default/校验和现有 expected JSON 不变；未注入 App 时仍 JSON-only。
- [ ] 新建 HTTP/MCP 测试，沿用 `tests/contact-upload-app.test.ts` 的临时本地 HTTP 服务/InMemoryTransport 模式（不启动 `npm run dev`）：有效 Token 可读工具及资源；无效 Token 拒绝；资源结果不含长期 Token。测试整个 HTTP 入口，不依赖伪造 actor。
- [ ] 运行测试确认旧注册没有资源而失败，然后实现条件注册：

```ts
const uri = 'ui://salestools/contact-search-graph.html';
if (app) {
  registerAppTool(server, 'search_contacts', {
    description, inputSchema: searchInput,
    _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] } },
  }, async input => result(await search.search(input)));
  registerAppResource(server, '联系人图谱', uri,
    { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
      uri, mimeType: RESOURCE_MIME_TYPE, text: await app.html(),
    }] }));
} else {
  server.registerTool('search_contacts', { description, inputSchema: searchInput },
    async input => result(await search.search(input)));
}
```

- [ ] 在 `get_contact` 注册元数据明确 `ui.visibility=['model','app']`，不关联新画布资源，避免详情读取不断打开新的 App。不修改任何写工具权限或实现。
- [ ] `tools.ts` 将可选 App 参数传给注册函数。`index.ts` 在图谱启用时注入 `readFile(new URL('../web/dist/contact-search-graph.html', import.meta.url), 'utf8')` loader，不创建上传会话。资源读取失败只影响 App 资源，search 查询 handler 不读页面文件。
- [ ] 跑 `tests/contact-search-tools.test.ts`、`tests/contact-search-graph-app.test.ts`、`tests/mcp-tools.test.ts`、`tests/mcp-e2e.test.ts`，验证新 UI 元数据没有改变原 JSON 或工具名称。类型检查通过后 review。

## Task 3：自包含页面、宿主生命周期与只读调用

**Files:** 新增 `web/contact-search-graph.html`、`web/contact-search-graph.ts`，扩展现有打包脚本，不修改上传业务。

**Interfaces:** 主入口使用 `new App({name:'salestools-contact-search-graph',version:'1.0.0'}, {})`；连接前设置 `ontoolinput`/`ontoolresult`/失败回调。在此文件内部封装两个固定调用，不能接收任意 tool 名：

```ts
async function readSearch(args: SearchInput): Promise<SearchPage>;
async function readDetail(args: {
  entity_id: string; evidence_offset?: number; evidence_limit: number;
  relation_offset?: number; relation_limit: number;
  claim_offset?: number; claim_limit: number;
}): Promise<ContactDetail | { found: false }>;
```

`SearchInput` 使用既有输入字段和约束。SDK 请求传 `{ timeout: 30_000 }`；解包 structuredContent，显式检查 isError、found:false 和实际必要字段，不能把错误当成空数组。

- [ ] 先建立真实SDK/DOM宿主harness：验证搜索节点立即显示；无需点击即順序读各命中根全部关系页；无原参数不读claim。端点以evidence_limit=1、relation_limit=1、claim_limit=0补名称，每ID一次，附带关系不扩图、不递归。
- [ ] 页面实现画布、图例、节点列表、状态区和详情区。SVG 文本全部使用 createElementNS/textContent；详细手机号/邮箱等字段不被默认绘制。离开宿主 iframe 时只显示明确提示，不尝试 fetch 数据或新建凭证。
- [ ] 复用现有上传页的无日志 postMessage Transport 契约，在新页面内实现同样的来源/消息形状检查；不在本次抽取通用 transport 框架，不使用会输出整包个人资料的调试日志。
- [ ] 所有输入/结果做必要边界检查；input/result 任意先后均可显示。无input时搜索分页禁用，自动正式关系照常加载，claim_limit=0并标记未加载。input后到且true时自动补读所有命中根的claim页，不重读已完成正式页；false/未设置不读、不显示claim，不从命中标签猜开关。result失败不能当total:0。
- [ ] 扩展打包脚本为两个明确 entryPoints/html/output 三元组，逐个调用现有 esbuild 逻辑；模板替换继续用函数，保留 `</script>` 转义。
- [ ] 扩展 `tests/contact-upload-build.test.ts`，以被隔离的 esbuild/I/O 边界运行真实脚本逻辑：两个产物均有脚本，`$&`/`$'`/`$\``/`</script>` 在两个页面中保持正确。此测试不是真实 bundle 验收。
- [ ] 本地执行 tsc 和解释器模型/注册/打包逻辑测试；浏览器源码解释器测试仅在已配置 Chromium 且无需构建时可运行，真实 bundle 浏览器 gate 统一留给 Task 5 的 CI。

## Task 4：自动一跳加载、详情证据及恢复交互

**Interfaces:** UI 保存请求序号、当前搜索输入/页起点、搜索页、该页累计一跳材料、每根集合游标/完成或失败状态、已补读端点ID、停止标记及单个选中详情/offset。一个简单异步循环逐根逐页执行，最多一个工具请求，不建立通用调度器。点击可立即选中；详情请求以一个待处理选中ID在当前请求结束后优先读取，多次点击仅保留最后选择；然后继续自动循环。停止只阻止下一次自动读取，继续从未完成游标执行。图与面板状态分开，详情页不改变一跳材料。

- [ ] 先写自动加载测试：至少两个命中根，其中一根超过20条，全部分页完成；共享节点/边去重，包含入向关系；无点击即可见。补充端点仅补名称且不遍历，非命中节点标记“关联补充”。jobTitle存在但relations空不能造任职边。
- [ ] 自动正式关系页用evidence_limit=1、relation_limit=20、claim_limit=0；启用claim时单独遍历，使用evidence_limit=1、relation_limit=1、claim_limit=20。各集合用自己的next_offset，仅累计目标集合，忽略附带重复返回。逐页更新图/进度；失败记录根/集合/offset后继续其他根，重试失败页。拒绝重复或不前进游标，不修改现有limit契约。
- [ ] 缺失名称/类型端点按ID补读，evidence_limit=1、relation_limit=1、claim_limit=0，仅取entity字段，忽略附带关系/证据。点击节点读10/20/20详情，只更新面板不改图；重复点击已加载详情不重读。只展示职业范围字段/关系/证据/冲突，补充端点其他关系不入图。
- [ ] 实现固定初始分列位置、平移、缩放与适应画布；不做节点拖拽、重叠线偏移或布局重置。节点列表用按钮实现键盘选择；宽屏侧栏、窄屏下方详情，不增加 UI 框架。
- [ ] 独立分页：搜索next_offset更换当前页，上一页只记录成功页起点；无input不得无参搜索。详情三集合各用next_offset，上一页max(0,offset-limit)，limit为10/20/20，成功后替换面板与offset、不累积。图例说明画布是当前搜索页命中根全部已加载的一跳关系，不是选中面板当前页。
- [ ] 对证据按 subject_kind/subject_id 对齐，当前页无所选关系证据时显示“当前证据页未包含该关系的证据”并提供证据翻页。claim 的 source 单独展示，不能拿主体姓名引文代替关系依据。URL 仅 http/https，用户点击使用 SDK 宿主链接接口，拒绝 javascript/data URL。

```ts
const parsed = new URL(sourceUrl);
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  throw new Error('Unsupported source URL');
}
const result = await app.openLink({ url: parsed.href }, { timeout: 30_000 });
// result.isError 时给出可复制的文本地址，不自动 window.open 或 fetch。
```
- [ ] 覆盖单根/端点失败、超时、桥接不可用、found:false、参数迟到true/false、停止/继续/重试。保留已成功边，其他根继续，不能宣称全部完成。单根失败不能删除其他根支持的共同边；选中详情失败不清图。仅补读主体自身claim，明确没有反向claim查询。
- [ ] 验证无递归：50个命中根加载一跳，端点补名称时附带关系被忽略；点击邻居不扩图。无静默条数/调用预算截断，关联多时可停止/继续；每次请求30秒不作为整个循环期限。
- [ ] 新查询/成功搜索翻页取消旧循环、清空旧页材料与选中详情；旧响应不能混入，原SDK请求结束/超时前不发新请求。搜索失败保留旧图并标明旧结果。自动加载/详情争用只串行，重复点击不产生并发。进度明确区分关系完成、端点名称未完成、待核实未加载及失败。

## Task 5：远程 CI、实际宿主与已有功能回归

- [ ] CI 使用现有 Node.js 24 环境执行 `npm run typecheck`、`npm run build` 和完整 Vitest，确保两个 HTML 都实际构建。给新浏览器测试增加与既有 `CONTACT_UPLOAD_BUNDLE_REQUIRED=1` 一致的 bundle 必须存在规则；CI 无 artifact 必须失败，不允许 skip 或退回解释器。
- [ ] 真实 SDK iframe harness 发送tool input/result执行tools/call：覆盖自动多根多页一跳、端点名称补读、详情、停止/继续/失败页重试、新查询晚响应、恶意字符串/URL。模拟宿主仅适配通信边界，真实生产HTML/SDK/SVG参与。
- [ ] 复用已有 Rust 存储/查询回归，不新建整套原生 fixture。新增纯图模型和真实 SDK 页面测试用受控的正式职业/教育/项目关系、待核实关系及敏感关系反例验证展示；再用现有远程MCP记录验证实际宿主接入，分清三种证据，不将渲染fixture称为真实存储验收。
- [ ] 生产镜像 smoke 检查 `web/dist/contact-search-graph.html` 以及原上传页面均存在，App resource 可以读取；在现有 CI 完成，不新增发布 workflow。Dockerfile 已复制整个目录，无需增加服务。
- [ ] 回归原上传 App、公开 discover_contacts、JSON-only graph search、get_contact、ask_contacts、鉴权、默认不含待核实线索；所有原行为不变。
- [ ] 用户批准部署后，在当前Codex查询云杉智造，展开App验证默认公司命中与自动正式一跳、不造任职；显式include_unverified:true时林知远成为根，无需点击自动读取出虚线，再点击核对来源。不得确认旧claim；默认仅公司时不承诺发现其他主体的入向claim。
- [ ] 在实际宿主验证缩放、点击、详情读取和 App 内搜索翻页。遇到宿主桥接权限不足明确记录，不把普通网页或 Playwright harness 结果称为真实 MCP App 验收。ChatGPT 宿主单独记录已测/未测。
- [ ] 记录服务/镜像版本、tested SHA、宿主版本、操作与返回、脱敏截图、耗时、warnings、未通过项。真实远程案例为合成记录；正式关系覆盖来自隔离 CI fixture。

## Task 6：文档与 skill 收尾

- [ ] 更新PRD/QUICKSTART/README：JSON不变；App自动显示当前搜索页全部一跳职业关系，逐步加载、不递归；点击查看详情，加载不完整明确提示，入向claim未覆盖。无备用网页入口。
- [ ] 更新联系人skill：仍按原搜索流程调用，App自身读取一跳，聊天Agent不重复批量请求；任职依据仍需真实worksFor/status/evidence，虚线不能当员工名单。不支持App继续文字/表格。
- [ ] 运行 diff 检查、文档路径与工具名称核对，确认没有误改旧诊断记录、Rust schema 或业务召回。按需验证 skill 前置字段，不能以文案 grep 代替行为验收。
- [ ] 创建 validation 记录并区分单元测试、远程 CI、真实宿主与未完成项。未经过用户授权不提交、推送、发版或部署；需要发布时另行采用现有流程。

## 完成判定

设计第 7 节的十项验收全部有对应证据；资源与 JSON 兼容测试、纯模型和浏览器/真实 CI 全部通过；实际 Codex 宿主中的只读搜索、图谱展开与来源核对通过。没有真实宿主结果只能报告“实现/模拟验证完成，宿主验收待完成”，不能声称上线可用。

本计划不要求旧“云杉智造”生成实线：旧档案没有正式任职关系，正确结果就是待核实虚线。需要修正旧数据时另行请求用户授权，不属于本实施范围。
