# 简历空候选与关系线索修复实施计划

> 历史阶段计划。其“默认零条正式关系”规则已由同日的 [简历机构与项目客户关系实施计划](2026-09-28-resume-institution-auto-relations.md) 替代；当前实现允许证据明确的任职、就读和项目关系自动落图。

> 目标：真实简历导入时不显示毫无内容的第二个人物候选；有价值但证据不足的关系提议自动标记写入图谱线索；跨提取批次的学校、任职信息在条件明确时也能关联到人物线索，并验证预览到图谱写入的完整链路。默认导入不要求用户逐条选择关系。

**依据：** docs/superpowers/specs/contact-data-contract.md；现有联系人导入实现及本次真实 PDF 测试结果。

**架构：** 保持 Docling 解析 → 分批模型提取 → 预览 → SQLite 图谱写入的现有链路。给现有 commit_contact_import 增加可选的 auto_create 模式，由服务端根据预览组装一次提交：有可定位证据的主体人物及组织创建为节点，关系选择默认为空，关系建议和弱关系自动进入现有 contact_claims，状态为 unverified。正式关系可在以后用现有线索审核工具确认；不新增图谱节点类型、表、MCP 工具或人工核对界面，原有手工 choices 调用保持兼容。

**技术栈：** TypeScript、Vitest、Rust、SQLite、现有 Docling/模型服务。

## 已确认的问题与边界

1. 同一份简历出现 2 个人物候选，并不等于有 2 个真实人物。其中一个候选完全没有姓名、属性、证据和待核实项，应从预览中剔除；但有学校、公司或其他实质线索的匿名档案仍须保留。
2. 现有关系处理会把部分“缺少可定位的直接陈述”的模型提议只写入警告并丢弃。有效端点及可追溯线索应进入待核实预览；无效端点不能被伪造成关系。
3. 人物和组织可能位于不同提取批次。当前批内端点限制阻止部分任职、毕业院校关系的回忆。跨批处理必须使用原文结构和归属证据，不能因为同在一份 PDF 中就把全部组织连给人物。
4. 预览提取成功不等于图谱写入成功。现有 commit_contact_import 虽要求为每个候选传 create/merge/skip，但这些是内部请求参数，不必由用户逐项填写；auto_create 模式可自动生成。验收必须分别核对实体、待核实线索、正式关系和查询结果。

## 全局约束

- 继续只使用 Person、Organization 及既有 schema.org 关系名；多段任职继续保留独立关系及其时间、职位属性。
- 每份 PDF／名片只创建一个主体 Person 节点。跨批次无独立身份的简历片段可归并主体；明确标作证明人、推荐人或紧急联系人的人物候选保留预览但不可提交，不能把其联系方式归给主体。手工提交也不能从同一文件创建两个 Person 节点；主体无法辨认时拒绝自动写入。
- 不以“同一 PDF”合并人物；不将项目客户、推荐人单位、家庭成员单位自动判作工作单位；不把所有组织候选自动建边。
- 未确认关系线索必须明确标记为 unverified；默认已确认事实查询及问答不得把它陈述为事实。按公司／学校综合查找时可显式包含此类线索，并清楚区分命中状态。
- 默认导入传空 relation_choices，不创建正式关系；仅在人物实体实际提交后，其关系线索才能落入现有 contact_claims。以后需要确认、拒绝或改正时走现有 review_contact_claim／编辑工具。
- 有定位证据的姓名、联系方式等候选字段按现有字段契约保存为文件来源字段；不能因“自动入库”就把模型猜测升级成正式字段。弱字段继续以 unverified 线索保存。自动创建的节点须在查询说明中标出“来自文件提取、未经人工核对”；现有正式节点模型不等同于“经人工确认”。
- 自动流程不按同名、手机号或账号合并已有联系人。若预览存在多个有独立内容的人物且无法确定简历主体，只暂停这一份导入并询问一次主体归属；其余证据充分的单主体简历无需逐项确认。潜在重复只给出提示，后续可用现有合并工具处理。
- 复用 ReviewItemSchema 的大小、数量与引文限制；测试和仓库文档只用合成资料，不复制真实简历中的个人资料。

## 任务 1：清理空人物候选，保留被丢弃的关系线索

**文件：** src/contacts/document-extractor.ts；tests/contact-extraction.test.ts；必要时更新 docs/superpowers/specs/contact-data-contract.md。

**先写失败测试**

- 模型返回一个有效人物和一个所有字段均为空、没有证据或待核实项的 Person：预览只能有一个人物，不影响组织候选数量。
- 弱关系错误地引用上述空人物时，空人物仍须消失；该弱关系只能进入全局警告，不能挂到真实人物或制造一个空白匿名档案。
- 匿名 Person 虽无姓名、电话，但包含学校或经历线索及其可定位证据：仍保留；满足现有匿名档案提交条件时仍可提交。
- 模型返回端点有效但直接证据不足的 worksFor：预览含源人物上的 relation 待核实项，保留目标组织、关系类型、原因及现有可用页码/引文；自动提交后产生 unverified claim，不生成已确认关系。
- 目标 candidate_id 不存在或类型不兼容：只给出可诊断警告，不创建指向错误实体的待核实关系。
- 待核实项超过现有限额或引文过长：按契约安全裁剪或拒绝该项，不能导致整份预览失败。

**实现**

在现有关系验证分支区分“端点有效但证据弱”与“端点无效”。前者仅在源人物具有独立的有效字段或证据时，用 ReviewItemSchema 包装为 relation 待核实项并归属到源人物；后者保留全局警告。全部关系整理完成后，再过滤完全空白的 Person；判空检查姓名、非空属性、有效证据和有有效归属的待核实项，不把仅有空字符串、空数组或孤立关系当作内容。未归属关系碎片只留在全局警告，不能伪装成第二个已识别人物。

**验证**

运行 rtk npm test -- --run tests/contact-extraction.test.ts 和 rtk npm run typecheck。检查现有匿名简历、同文件多人物和人物合并测试仍通过。

## 任务 2：只在明确结构下补跨批关系建议

**文件：** src/contacts/document-extractor.ts；tests/contact-extraction.test.ts。

**先写失败测试**

- 强制分成至少三个批次：第一批有可定位姓名的人物，后两批分别有明确“工作经历”和“教育经历”标题、相邻且同页的组织名称。最终预览分别给出 uncertain 的 worksFor、alumniOf 建议；源和目标指向最终候选 ID，证据页码及引文可定位。自动提交后两条建议均作为 unverified claims 写入，不生成正式关系。
- 工作经历有两段不同时间/岗位：保留两个任职建议及各自属性，不折叠成一条。
- 同页项目客户、推荐人单位、否定表达、非相邻段落、跨页拼接、多个各有独立身份线索的人物、同名但无法确定是哪一个组织：均不得自动生成跨批关系建议；保留已有组织候选和可用待核实信息。
- 重复扫描或批次划分改变时，同一条证据不会产生重复关系建议。

**实现**

在现有 coalescePeople 之后做一次限定的全文结构归属整理，不再请求模型。复用现有标题识别、页码/块定位和组织名称定位逻辑；只有唯一可定位的简历主体人物、明确的经历标题、相邻同页的组织名称、没有冲突人物或排除语境时，补 uncertain 关系建议，供默认提交自动保存为 unverified claim。建议的关系证据沿用现有 ContactEvidence 格式，包含最终源/目标 ID、原文块定位、页码和可核对引文；没有这些证据时只保留待核实项。以关系类型、来源结构片段及任职时间/岗位去重，保留不同任职段。结构证据不够的模型关系继续作为任务 1 的待核实项，不因“组织也在 PDF 中”而升级成正式边。

**验证**

运行 rtk npm test -- --run tests/contact-extraction.test.ts 和 rtk npm run typecheck。查看一个三批次合成预览，确认最终候选 ID、证据和待核实标记均一致。

## 任务 3：把默认导入改为自动标记写入，并验证闭环

**文件：** src/mcp/contact-import-tools.ts；src/contacts/import-service.ts；tests/contact-management-e2e.test.ts；tests/contact-recall-acceptance.test.ts；skills/salestools-contact-management/SKILL.md；docs/QUICKSTART.md。

**先写失败测试**

- 合成单主体简历：调用 commit_contact_import 的 auto_create 模式，不传 choices；服务端为唯一有实质内容且 can_commit 的人物和有证据、可提交的组织生成 create，其余候选生成 skip，relation_choices 为空。一次提交后有正式节点、零条正式关系，未选建议/待核实项进入 contact_claims；按公司或学校关键词显式搜索能找到人物并显示 unverified，默认问答不会把它们当事实。
- 同一批次出现可能重复的现有联系人：默认不 merge，返回重复提示，提交仍可完成；再次执行同一 import_id 的固定 operation_id 不会重复建档。
- 同一预览出现两个各有独立内容、难以区分主体的人物：auto_create 原子地拒绝提交，提示用户只确定主体归属，不逐字段询问。
- 没有可提交的主体人物时，auto_create 不创建孤立组织；提示缺少可定位人物资料，保留预览。
- 手工 choices 模式保留修正、合并与跳过能力，但同一文件不能选择创建两个 Person；auto_create 与 choices 同时传入、或 auto_create 携带非空 relation_choices 时拒绝，避免两套决策冲突。
- 对一条已写入的关系 claim 以后使用现有 review_contact_claim 确认：图谱出现正确 Person → Organization 边，任职/教育属性与原文证据对应；拒绝则不出现正式边。
- 预览过期时提交被拒绝且不产生图谱写入；有效预览未提交人物时不产生孤立线索或关系，并仍可重新读取供人工核对。

**实现**

优先复用现有 Rust commit_import 和 contact_claims，不另建持久化路径或测试框架。扩展现有 MCP 提交工具为可选 auto_create 模式，由 TypeScript 服务读取完整预览并生成一次性 choices：恰有一个有实质内容且 can_commit 的主体人物时，该人物和所有有证据、can_commit 的组织选 create，其余选 skip；relation_choices 固定为空，绝不自动 merge。没有可提交主体或有多个实质人物时直接返回需处理原因，不部分写入。服务端仍使用预览版本与固定 operation_id，响应丢失按原请求重试。修改联系人管理 skill：用户要求导入时默认调用此模式，仅在主体无法判定或提交校验失败时请用户处理一个具体问题；综合查找公司／学校时显式包含未核实线索并保留标记。简短更新 QUICKSTART，说明自动入库、unverified 标记及后续确认／拒绝或编辑的路径。

**真实文件验收**

在临时数据库中，用用户提供的 PDF 和当前 .env 执行一次真实预览及默认自动提交；不把原文、个人资料或模型响应保存到仓库。记录脱敏统计和候选 ID：空人物候选为零，主体人物创建成功，组织候选可预览，工作／学校线索有证据时自动写为 unverified claim。核对人物、组织、claim 的回读及公司／学校显式线索搜索；正式关系数应为零，默认问答不得断言这些关系已成立。模型结果可能波动，若实际原文不足以支持某条关系，应记录“证据不足、未建边”，不能用固定候选数量或强行建边凑验收。

**最终检查**

运行 rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts tests/contact-recall-acceptance.test.ts、rtk npm run typecheck、rtk npm run build，以及 rtk cargo test --manifest-path rust/contact-graph/Cargo.toml；复查 rtk git diff --check 与 rtk git status。清除临时数据库和脱敏测试输出，保留可复现的合成测试。只有真实文件的自动提交、图谱线索回读与显式查询都验证通过，才报告“简历导入创建联系人”端到端可用；否则明确报告未通过的环节。
