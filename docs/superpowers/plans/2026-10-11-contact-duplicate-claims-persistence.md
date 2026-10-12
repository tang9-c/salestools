# 联系人疑似重复线索持久化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划不自动授权提交、推送、发布或生产写入；如需这些操作，另行取得授权。

**Goal:** 用户授权保存有效联系人资料后，允许独立入库，并长期保存疑似重复线索，身份确认不再成为资料保存的前提。

**Architecture:** 复用 `contact_claims`，以 `kind=relation, relation_type=possible_duplicate` 保存身份待核对线索。联系人及线索在现有 Rust 入库事务内一起保存；沿用现有查询、审核、合并和审计，不创建正式关系边。

**Tech Stack:** TypeScript、现有 MCP SDK、Rust、SQLite、现有 MCP Apps。

**Spec:** 本聊天已确认的五项修正及 ponytail 审查；字段、表和已有接口以 `src/contracts/contact-graph.ts`、`rust/contact-graph/src/store.rs` 和 `src/mcp/contact-import-tools.ts` 为准。本计划将行为约束完整记录在下文，不依赖实现者补充产品决策。

## 全局约束

- 不新增表、正式关系类型、MCP 工具、页面、配置或状态。沿用 `unverified / confirmed / rejected`。
- 不自动合并；只允许用户明确选择已有合并入口。独立入库不表示已确认不同人。
- 保存仍须用户授权。仅移除疑似重复及重复匹配不完整造成的阻断，不移除主体、内容、权限、版本和文件处理校验。
- 覆盖新导入，包括 PDF、名片、文字；网络资料经现有导入确认流程保存时复用，不扩展 `discover_contacts` 自动入库或 `save_contact` 直接创建的去重机制。
- 不回填历史资料，不扫描全库、不创建后台身份 Agent，不延长临时原件或上传会话有效期。身份线索不自动到期。
- 不修改 Docling、模型提取规则、正式字段合并、任职关系去重规则。
- 仓库禁止本地构建、Rust 编译及 `npm run dev`。本地只运行解释器测试、类型/格式/diff 检查；Rust 真实存储和构建产物测试在现有远程 CI 完成。旧本地二进制不算本次源码验证。
- 保护工作区其他改动；不使用全量 `git add`。实施与验收状态以对应验证记录为准。

## 固定数据与行为约定

### 存储

现有 `contact_claims` 的列无需改动：

```text
kind          = relation
relation_type = possible_duplicate
field_path    = NULL
subject_id    = 本次候选最终入库的 Person ID（新建或合并目标）
target_id     = 匹配到的另一个 Person 最终保留档案 ID
status        = unverified
reason        = possible_duplicate
import_id     = 首次发现的有效导入任务
candidate_id  = 产生该线索的候选 ID
value_json    = { reasons: [same_name | name_with_organization | self_phone | email | instant_messaging],
                  subject_name: "当时的姓名", target_name: "当时的姓名" }
source_json   = 首次来源的安全摘要及导入引用
```

- 名称是发现时的快照，不作为新的正式姓名事实；UI 说明“线索记录名称”，不直接显示内部 ID。
- 只保存理由代码，不重复保存匹配手机号/邮箱；正式资料和字段证据仍保留在联系人档案。
- `source_json` 仅保留导入引用、来源类型、文件名/哈希或文字哈希、采集时间等短元数据；不复制 `original_text`、OCR、模型响应、凭证。沿用每个 JSON 列最多 2048 UTF-8 字节的限制，过长文本元数据截短并标注，不静默删除整条线索。
- 同一无方向联系人对仅有一条当前待核对提示；新发现合并理由集合，原始来源不覆盖，后续发现写现有 `audit_log`，不累积无限长 JSON。
- 保留“本次入库联系人 → 匹配联系人”的存储方向，不按 ID 排序或交换主体。查重同时比较两个方向，不只依靠 claim ID；存在 `confirmed/rejected` 记录时不新开 `unverified`，新增发现仍写审计。已有记录的方向不因新的发现而改变。
- 查询只展示未处理线索；已处理记录继续存储，处理历史仍走已有审计。不增加历史管理 UI。

### 提交与重试

服务端在首次提交前复用 `matchSuggestions`，给 Rust 私有 `commit_import` 请求增加可选派生字段，**不暴露到 MCP 输入 Schema**：

```ts
duplicate_matches?: Array<{
  candidate_id: string;
  target_id: string;
  reasons: Array<'same_name' | 'name_with_organization' | 'self_phone' | 'email' | 'instant_messaging'>;
}>;
duplicate_match_incomplete?: boolean;
```

- 为最终选择 `create` 或 `merge` 的 Person 计算，`skip` 不处理。由 `landed` 确定实际入库主体；用户选择合并到 A 时，只排除最终指向 A 自身的线索，仍保留与 B 等其他匹配者的线索。复用已有匹配上限和截断提示，不新增配置。
- `duplicate_match_incomplete` 缺省为 false；任一姓名、联系方式、机构匹配、档案读取阶段失败，或结果截断时设 true。重构现有 `matchSuggestions` 的错误收集粒度，不把整个页面包在唯一的兜底 catch 中：分别保留成功阶段及成功候选结果，再聚合所有成功页。只因补充资料读取失败，不能抹掉此前已取得且可校验的同名/联系方式匹配线索。
- 匹配失败或截断仍允许有效资料入库；不能显示“没有重复”或“核对完成”。在 Rust 入库事务中把固定警告“本次入库的重复核对未完整完成，已保存资料及已获得的线索。”去重追加到现有 `import_jobs.data_json.warnings`，并并入提交 `warnings`、`operation_results` 回执和审计。预览回读、进程重启或原操作重放都保留首次提交的警告，不能只在 TypeScript 响应里追加文案。
- Rust 校验理由枚举、候选存在且选择 `create/merge`、目标存在且为 Person；拒绝非入库候选、任意原文和越界请求。复用已有 50 个匹配目标上限，每条理由去重后 1–5 个；按最终实际 ID 排除自指线索，不因本次已合并到匹配目标而让整个提交失败。
- 在事务内读取派生匹配目标的 metadata，沿已有 `merged_into` 解析到最终保留 Person 后再查重、排除自身和写线索。用已访问 ID 集合检测循环；链条缺失、类型非法或循环则拒绝非法提交并回滚，不猜测目标。普通归档且没有 `merged_into` 的有效目标仍可留线索；合并归档不能把新线索留在已被替代的旧档案上。发生重定向时，在已有来源摘要/审计保留最初匹配档案 ID，说明理由来自当时的匹配，不声称最终档案当前字段仍相同。
- 上述解析仅用于派生线索目标，不偷偷更换用户显式选择的 `merge` 写入目标，也不绕过其版本及归档校验；显式合并目标过时仍按原规则失败并要求重新核对。
- 两个派生字段均不参与幂等用户请求哈希；其余用户字段、actor、import_id、operation_id、版本和 choices 继续参与。Native 原操作重放优先于新任务版本校验，返回原回执与原警告，且不再添加线索。

```rust
let mut request_identity = raw.clone();
request_identity.as_object_mut().unwrap().remove("duplicate_matches");
request_identity.as_object_mut().unwrap().remove("duplicate_match_incomplete");
let hash = canonical_hash(&request_identity)?;
// Existing operation_results replay remains before the import write transaction.
```

旧请求未带派生字段时的 hash 不变；相同 operation_id 但改 choices/actor 仍产生冲突。私有请求兼容旧调用者：匹配集合缺省为空，不完整标记缺省 false。用户请求重放时不以新的派生匹配结果更新原操作。

无方向查重沿用现有表，在新增、补充理由和合并折叠时使用同一判断：

```sql
WHERE kind='relation' AND relation_type='possible_duplicate'
  AND ((subject_id=?1 AND target_id=?2) OR
       (subject_id=?2 AND target_id=?1))
```

### 读取与处理

双向查询只扩展这一类型，不让任职、教育等其他 claim 出现在错误的主体档案中。总数、当前页和 next_offset 必须使用相同谓词：

```sql
WHERE status='unverified'
  AND (subject_id=?1 OR
       (kind='relation' AND relation_type='possible_duplicate' AND target_id=?1))
```

- `get_contact` 继续使用原 `unverified_claims` 和原分页字段，不扩展顶层响应。
- `review_contact_claim(confirm)` 对 `possible_duplicate` 明确拒绝，并提示使用 `merge_contacts`，不产生任何正式边。
- `reject` 复用现有工具，要求 1–500 字符 `confirmation_note`，供“确认不同人”或“忽略提示”说明；不改变其他类型 reject 的既有要求。
- 入向线索审核仍传该记录实际 `subject_id` 的当前实体版本；工具/skill 明确需先读该主体，而不是误用当前查看的另一端版本。
- 合并双方的 pending 线索在合并事务内改为 `confirmed`，表示“已经人工合并处理”，而非创建身份事实。先处理该线索，再重定向其他端点，避免产生未处理的自指线索。
- 与第三人相关的线索随现有合并重定向，保持原存储方向，不重新排序主体/目标；按无方向联系人对去重。同一对被折叠时优先保留已处理记录，否则保留最早的 pending，其余记录标为 rejected 并写合并去重审计，不删除历史、不遗失来源。不得重新打开已处理记录。
- `possible_duplicate` 不参与职业事实搜索、待核实文本命中、正式关系、图谱扩边、向量内容和问答依据。档案详情单独显示待核对提示。

## Task 1：允许保存并在现有事务内写入线索

**Files:**
- Modify: `src/contacts/import-service.ts`, `src/mcp/contact-import-tools.ts`
- Modify: `rust/contact-graph/src/import_commit.rs`
- Test: `tests/contact-import.test.ts`, `rust/contact-graph/tests/import_commit.rs`

**Interfaces:** 复用 `matchSuggestions`；扩展私有 `CommitInput.duplicate_matches` 和 `duplicate_match_incomplete`，MCP `commit_contact_import` 入参不变。

- [ ] 先改当前“重复候选阻止 auto_create”的测试为“用户授权后允许创建，提交含派生线索，旧档案不改”。补候选匹配 A、B 后显式合并到 A 的用例：传递与 B 的匹配，不生成 A–A，也不跳过所有线索。主体不明确、覆盖不完整、版本冲突仍拒绝。
- [ ] 本地运行解释器测试，确认旧行为导致失败：`node node_modules/vitest/vitest.mjs run tests/contact-import.test.ts --exclude '.worktrees/**'`。
- [ ] Rust 增加真实存储测试：新旧 Person 均存在、正式关系数不变、只有一条 `possible_duplicate`、来源安全且短、线索写失败时新 Person 回滚、普通归档目标仍留线索；合并候选实际写入 A 后，与 B 的线索仍保存。
- [ ] 先为部分失败写解释器测试：姓名成功但联系方式查询失败；联系方式成功但机构解析失败；已有档案补充读取失败；某一页失败但其他页成功。每例都要求保留可校验的成功结果，标记 incomplete，并允许有效资料入库；全部匹配失败则保存资料和不完整警告，不宣称无重复。
- [ ] 移除 `getUploadPreview` 与 `commit` 中的重复/匹配不完整阻断，只保留提示；首次创建或合并提交时计算服务端匹配，按阶段/候选收集错误及部分结果，聚合成功页。不接受客户端伪造两个派生字段，不记录上游异常原文。
- [ ] Rust 在同一入库事务完成 `landed` 后解析派生匹配目标的 `merged_into`，按实际端点排除自指、无方向查重并写线索。审计保存新发现引用；继续使用现有 FK、JSON 字节限制和 actor 校验。
- [ ] 写并发窗口回归测试：服务端得到匹配 A 后，先把 A 合并到 B，再提交新候选 C；只保存 C–B，B 可查询，A 不留下新 pending。另测多级合并链、最终目标等于当前入库主体、链循环/不存在时回滚，以及用户显式 merge 目标过时仍被拒绝。
- [ ] 把 incomplete 警告在同一事务持久追加到任务数据、操作回执及审计，保留其他原有警告；补重新打开预览、进程重启、响应丢失后重放仍有原警告的真实存储测试。不得只依靠 TypeScript 返回时附加消息。
- [ ] 排除两个内部派生字段计算请求 hash；补原样重试、新匹配结果/不完整标记变化后重试、旧请求 hash、修改 choices/actor、无派生字段兼容测试。重放仍返回首次回执，不追加线索或覆盖警告。
- [ ] MCP 描述说明“可独立保存，身份待核对”，不再称必须人工选定身份才能保存；同时说明用户明确合并只解决指定对象，不抹掉其他身份线索。
- [ ] 本地重跑解释器/类型检查；Rust RED/GREEN 在远程 CI 执行，未执行前明确标为待验收。

**核心验收断言：**

```text
new_person_id != existing_person_id
create: existing formal profile unchanged
merge: existing profile changes only by confirmed field choices and existing merge rules
pending possible_duplicate pair count == 1
candidate matched A/B and merged into A: pending A/B pair count == 1, no pending self-pair
matching A merged into B before saving C: pending C/B pair count == 1
kg_relations count unchanged
same operation_id replay: entity/claim counts unchanged
matching incomplete: stored task and original receipt replay both retain the incomplete warning
changed public choices or actor: OPERATION_CONFLICT
```

复用 `tests/contact-import.test.ts` 已有同名同机构 fixture 与 harness；将此前拒绝自动创建的断言改为以下行为断言（fixture 的 `ci_1` 版本为 3，已有目标为 `p1`）：

```ts
const saved = await h.service.commit({ import_id: 'ci_1', preview_version: 3,
  operation_id: 'contact-import:ci_1', auto_create: true }, 'reviewer');
expect(saved.status).toBe('committed');
expect(h.state.lastCommit?.duplicate_matches).toEqual([{
  candidate_id: 'c_1', target_id: 'p1', reasons: ['name_with_organization'],
}]);
```

这只证明服务端提交行为；档案、线索和原子性必须由实际 `Store` 测试证明。读取保存结果后，用以下断言核对线索性质：

```rust
let detail = store.get_contact(&json!({"entity_id":new_person_id})).unwrap();
let claims = detail["unverified_claims"].as_array().unwrap();
assert_eq!(claims.len(), 1);
assert_eq!(claims[0]["relation_type"], "possible_duplicate");
assert_eq!(claims[0]["status"], "unverified");
assert_eq!(count(&store, "kg_relations"), 0);
```

## Task 2：双向分页读取及事实隔离

**Files:**
- Modify: `rust/contact-graph/src/store.rs`, `rust/contact-graph/src/search.rs`
- Check: `rust/contact-graph/src/protocol.rs`, `src/contacts/contact-answer.ts`, `src/contacts/vector-indexer.ts`, `web/contact-search-graph-model.ts`
- Test: `rust/contact-graph/tests/search.rs`, `tests/contact-search-graph-model.test.ts`；现有问答/向量测试按其实际文件补用例

**Interfaces:** `get_contact.unverified_claims` 使用同一个存储记录从两端读取；原 claim_offset/claim_limit/next_offset 不变。

- [ ] 先写真实存储用例：A、B 都读到相同 claim_id，C 读不到；混合普通 claims 后总数/翻页一致；rejected/confirmed 不显示为 pending。
- [ ] 对 count 与列表查询同时应用上面的限定双向谓词；稳定排序沿用 claim_id。不得将所有 target_id 相同的普通关系 claim 一并拉入。
- [ ] 在 `search.rs` 的泛化未核实命中中排除该类型：`AND (c.relation_type IS NULL OR c.relation_type <> 'possible_duplicate')`。项目路径查询原本限定类型，保留原逻辑。
- [ ] 检查问答、向量与 App 模型的每个 claim 消费者：职业类型白名单保持不变；如有泛化正文消费者，只加该类型排除，不做架构重构。
- [ ] 用测试证明：线索中的另一人姓名/机构不能让本联系人冒充拥有其任职、项目、技能或事实；正式查询和问答结果不受影响。
- [ ] 执行相关解释器测试；存储/搜索 SQL 的真实测试交远程 CI，不能用 mock 代替 SQL 验收。

## Task 3：复用审核与合并，闭合处理状态

**Files:**
- Modify: `rust/contact-graph/src/claims.rs`, `rust/contact-graph/src/lifecycle.rs`, `src/mcp/contact-tools.ts`
- Test: `rust/contact-graph/tests/claim_review.rs`, `rust/contact-graph/tests/lifecycle.rs`；已有 MCP 契约测试

**Interfaces:** 不增加工具或 action；继续 `review_contact_claim(reject, confirmation_note)` 和 `merge_contacts`。

- [ ] 先写测试：confirm 被拒且无正式边；reject 缺说明被拒，有说明后状态/审计/版本更新；原样操作重放幂等，其他 claim 审核不回归。
- [ ] 识别 `possible_duplicate` 后单独处理审核要求，不能走通用 relation confirm 分支。保留权限、归档限制、实体版本与操作重放。
- [ ] 合并事务先把双方 pending 标 confirmed 并记录合并操作；随后沿用主体/目标重定向。
- [ ] 对受影响的第三人线索重定向端点但不排序，按两个方向比较处理折叠后的重复；保留处理状态、来源引用和审计，不删除记录。
- [ ] 测试 A–B、A–C、B–C 的合并场景：没有 pending 自指，第三人的资料不被合并，C 仍可双向查，折叠后只出现一条当前提示；已有 rejected 不被重开。
- [ ] 补合并失败回滚测试，证明联系人、关系、线索状态不能半成功；验证双方版本保护。

## Task 4：修正文案、显示与编排，完成验收

**Files:**
- Modify: `web/contact-upload.ts`, `web/contact-upload.html`, `web/contact-search-graph.ts`
- Modify: `skills/salestools-contact-management/SKILL.md`, `docs/QUICKSTART.md`
- Test: `tests/contact-upload-browser.test.ts`, `tests/contact-search-graph-browser.test.ts`, `tests/contact-upload-app.test.ts`
- Create: `docs/validation/2026-10-11-contact-duplicate-claims-persistence.md`

**Interfaces:** 页面继续调用原上传/预览/确认接口；聊天继续使用原导入、查询、审核和合并工具。

- [ ] 浏览器先写失败用例：有重复提示仍可由用户确认独立入库；“暂不保存”不提交；双方详情显示“身份待核对”及理由，但图谱不增加正式身份边。
- [ ] “确认导入”文案改为“保存资料，身份待核对”（有重复提示时）；无重复仍用普通确认文案。不自动点击、不替用户选合并。匹配不完整要显式展示警告。
- [ ] 将此前“暂不决定/继续核对”改为“暂不保存/继续核对”；前者只停留预览、不提交也不取消，避免混淆“暂不确认身份但已授权保存”。
- [ ] 档案详情独立显示 `possible_duplicate`，用名称快照和理由中文，不把 ID 当正文，不将其画成正式边。选中档案时通过原 `get_contact` 读取 claims，身份提示不受搜索 `include_unverified` 开关隐藏；其他职业待核实线索仍遵守该开关，图谱的自动扩展逻辑不改。共用原 claim 分页，需要下一页时保留翻页入口，不为显示复制一条反向线索。补默认查询不开启 `include_unverified` 时仍可读取身份提示的浏览器测试。
- [ ] 联系人 skill 和工具说明同步：授权保存后可独立入库；无身份确认仍留 pending；确认同一人才走合并，合并到 A 不代表已排除与 B 的关联；拒绝线索时使用实际 subject 的当前版本并提供说明。用实际编排情境检查指引，不用字符串 grep 冒充行为测试。
- [ ] 更新 QUICKSTART：这轮覆盖新导入，不自动处理历史库；原件清理和线索长期保留是两件事。
- [ ] 本地验证（无构建）：

```sh
CONTACT_UPLOAD_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node node_modules/vitest/vitest.mjs run \
  tests/contact-import.test.ts tests/contact-identity-match.test.ts \
  tests/contact-upload-browser.test.ts tests/contact-upload-app.test.ts \
  tests/contact-search-graph-model.test.ts tests/contact-search-graph-browser.test.ts \
  --exclude '.worktrees/**' --reporter=dot
node node_modules/typescript/bin/tsc --noEmit
rustfmt --check --edition 2021 rust/contact-graph/src/import_commit.rs \
  rust/contact-graph/src/store.rs rust/contact-graph/src/search.rs \
  rust/contact-graph/src/claims.rs rust/contact-graph/src/lifecycle.rs
git diff --check
```

- [ ] 取得提交/推送授权后，在现有 `.github/workflows/contact-upload-validation.yml` 上验证同一 tested SHA。使用远程 native RED/GREEN、完整测试、真实构建页面及容器 gate，不新增 CI 平台、不使用生产密钥。CI 内 Rust 命令仍为 `cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`。
- [ ] 记录测试 SHA、解释器/真实 Rust/页面 bundle/容器结果。未跑远程 CI 不宣称全部验收通过；模拟浏览器不称真实 Codex 宿主验收。

## 完成条件

- 有效资料经授权可以独立入库，旧档案正式资料不被修改；疑似重复不再成为阻断。用户明确选择合并时仍按已有字段取舍修改目标档案，并保留与其他匹配者的线索。
- 新联系人和线索事务一致；不产生正式身份关系；失败原子回滚。
- 重启后双方仍能读取同一 pending 线索，重复提交不增加档案或线索。
- 阶段或分页部分匹配失败不抹掉成功线索，核对不完整警告在任务和原操作回执中长期保留；重放不依赖重新计算的匹配状态。
- 派生目标已被合并时线索指向最终保留档案；普通归档不误当作合并；显式合并的版本及归档保护不被绕过。
- 拒绝有审计；合并无 pending 自指，第三人线索不丢，已处理状态不重新打开。
- 普通 claim 归属、职业搜索、问答、向量及正式图谱语义不改变。
- 无新表/表结构迁移、无新工具/状态/配置/页面；已有记录和旧客户端兼容。
- 本地允许的检查及远程真实 gate 通过，未关联改动未混入。

## 不做的内容与已知边界

不做历史回填、全库扫描、LLM 身份推断、重复管理页面、正式身份边或网络发现自动保存。姓名/机构/联系方式只是匹配理由，不证明同一人；匹配失败、截断或后续出现的新档案可能仍有漏提示，但不能导致已授权资料丢失。
