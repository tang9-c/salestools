# Task 4 验收记录

状态：固定回归与全量检查通过；真实模型语义验收未通过，不能宣称目标已全部达成。

## 实现范围

- 新增相同虚构资料的单栏1页／双栏2页 PDF。真实 Docling 分别得到15／10块，双栏会把同一行左右内容合到一个块，保留这项真实解析难度。
- `contact-recall-acceptance.test.ts` 迁移到 DocumentProfile 模型桩；真实上传、Docling、SQLite提交、get_contact、正式／弱两跳查询、按claim分页对齐、确认／拒绝、save_contact修正及幂等均验证。名片使用既有 synthetic-card.png，真实 OCR 3块。
- 新增共享验收 harness 和显式运行的真实模型脚本；每份输入独立临时SQLite与上传目录，在 finally 清理。真实模型脚本不参与普通 Vitest，不替换模型，不输出真实正文或完整模型响应，只输出计数／安全错误码。`.env`直接读取，不复制，不提交。
- 更新契约、QUICKSTART与skill：DocumentProfile及映射、来源定位与语义区别、文件事实不等于人工认证、已保存／待核实／未处理范围、后续核对修正、幂等重放与非断点续跑。

## 固定矩阵

| 场景 | 验证位置／结果 |
|---|---|
| 多电话邮箱、重复／归纳技能、跨块 | 新双版式验收：2电话、2邮箱、技能去重及不同于引文完整值的归纳保存和来源回读 |
| 匿名档案、补姓名ID稳定 | 既有 contact-management-e2e：匿名与relation-only参数化；学校检索、原ID补姓名 |
| 多学校、多任职、在读／求职 | 新验收2学校、同雇主2任职；无jobTitle与hasCredential伪造；真实语义另外核对 |
| 两项目不同客户 | 新验收每项目精确客户端点；一个正式客户、一个弱客户；Person查询两跳 |
| 名片／证明人 | 真OCR名片弱关联可查；新PDF桩不生成证明人；既有e2e明确名片任职／非主体保护 |
| 无标题、跨页、不同栏 | 新PDF均无章节标题，双栏跨页；不引入模板规则 |
| 核对修正 | 新验收claim_limit=1逐页找到目标claim_id、拒绝意向、确认关联、正式边回读、save_contact改名 |
| 预算／部分模型失败／OCR空 | contact-extraction 52项保留预算／部分失败／空块／伪引文／错误块／来源跨主体负例；import生命周期保留处理状态 |
| 重放／重复文件 | 新验收同operation_id返回replayed；既有import/e2e重复提示和不自动合并保护继续通过 |

模型桩只能证明结构映射与保存，不能证明LLM理解正确。

## 真实模型验收

预期在 `task-4-expectations.md`。使用当前用户工作区 `.env`，默认提取预算不变。命令：`rtk proxy npx tsx tests/run-real-contact-acceptance.ts`（可用 ACCEPTANCE_SAMPLE=1..4 单独重跑）。初轮验收脚本把commit的skip项也送get_contact，导致`entity_id is required`；已修复，只回读真正创建项，此错误不算产品提交失败。

以下为修复脚本后的真实观察，不包含个人资料：

| 输入 | 已处理/未处理 | Person | 电话/邮箱 | 技能 | 正式学校/任职 | Project | 待核实 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 虚构单栏 | 15/0 | 1 | 0/0 | 1 | 2/2 | 2 | 3 | 失败 |
| 虚构双栏 | 10/0 | 1 | 2/2 | 2 | 0/0 | 2 | 13 | 失败 |
| 虚构名片 | 3/0 | 1 | 0/0 | 0 | 0/0 | 0 | 1 | 通过，弱公司关联可查 |

单栏：模型把两个电话和两个邮箱各合成一个分号字符串，被结构校验降为invalid_shape；未满足逐项可辨资料正式保存预期。Linux运维技能漏提。两项目各自客户正确、客户当雇主0、证明人污染0；未确认机构名本身也被标uncertain，组织不可提交，所属弱claim缺少可检索名称，预设歧义项弱查询未命中。

双栏：学校、任职、项目参与和客户Link存在invalid_shape，转成弱线索，学校／雇主正式查询不命中，但inclusive查询可命中。证明人单位被模型错误归为第一个项目第二客户，弱错误关联1；客户当雇主0；未把求职意向写现任、未补造毕业学位。预设歧义机构同样弱查询未命中。

已向主任务报告产品缺口，建议先检查模型返回Link形状、提示词单值示例、独立字段和关联的不确定性；没有添加正则或强制转正式。

## 真实用户 PDF：部分达标且不稳定

来源检查先于预期核对，脱敏清单见 expectations：75块／2页、1电话、1邮箱、学校与实习段、明确编号2项目，以及多项技术词。没有把旧模型输出作为人工真值。

第一次修复脚本后的运行：75已处理／0未处理，1Person+2Org+2Project真实提交；1电话／1邮箱、2技能、1学校边／1实习边、7待核实项。学校与实习单位正式和inclusive查询均能找到主体。警告“上下文超出请求预算，跨段关系待核实”。

为核对技能及项目参与再次运行，同样原件及默认预算，出现退化：1Person+2Org提交、2Project跳过；正式学校／实习边均0，两机构inclusive仍能找到主体；正式项目参与0、弱memberOf 1；候选降级原因invalid_shape 18、missing_evidence 2，最终人物待核实10。电话／邮箱仍各1且能逐字定位原文。技能变为1项复合值，包含11个预期技术词，Redis、Grafana、CMDB在正式与弱技能值均未见；K8s字面未出现但Kubernetes出现，按同义不计漏项。两轮差异说明模型结构和跨批上下文处理不稳定，不能把一次最低数量正确宣称验收完成。

第三轮为核对项目关键词查询追加诊断：模型响应无效，75块中50已处理／25未处理，1Person+1Org实际提交；1电话／1邮箱、正式技能0、正式学校0／实习1、Project0、人物待核实4、memberOf正式0／弱0、客户边0。项目抽取阶段未成功，没有可供逐项目查询的实际项目名称候选，因此项目关键词回到主体未得到有效验收，不伪称成功；无法建立客户两跳路径。已成功保存的实习单位正式／inclusive查询仍命中主体。形状诊断只输出字段键，已成功批次的attendance/employment是正确的evidence+uncertain对象，后续失败不是据此证明已处理。

用户原文未给出可辨独立项目客户名称时不要求补造客户。现有Rust查询的项目通路依赖客户组织关键词和两跳关系；项目名本身不等同于客户关键词。真实项目/客户召回仍未达标，留给后续产品修复后重新验收。这三轮逐次记录，不拼接为一次成功。

## 全量检查

- `rtk cargo build --locked --manifest-path rust/contact-graph/Cargo.toml`：通过。
- `rtk proxy python/.venv/bin/python -m pytest python/tests/test_parser.py -q`：18 passed。
- `rtk npm test -- --run`：54 files、1064 tests passed。
- `rtk npm run typecheck`：通过。
- `rtk npm run build`：通过。
- `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`：107 passed、14 suites。
- `rtk proxy cargo fmt --check --manifest-path rust/contact-graph/Cargo.toml`：通过。
- `rtk proxy git diff --check`：通过。

未跟踪python/.venv符号链接不提交。没有提交原件、OCR、真实响应、密钥或数据库。

## 提交与后续

本任务提交固定验收、虚构样例、文档与脱敏报告；未改生产抽取逻辑。真实模型失败已经交回主任务集中修复。真实模型脚本为显式验收工具，最低计数检查不等同语义验收；真实用户样本始终标manual_review_required。可用`ACCEPTANCE_SHAPE_DIAGNOSTICS=1`输出白名单Link键类型诊断，禁止输出完整响应。

## Task 4 审查修正：验收判定器

审查发现旧runner最低数量检查可能漏掉Python/Linux技能、memberOf及实际两跳召回，仍输出semanticAcceptance=passed。已移除这一不可靠结论。新增独立的虚构样本判定器，逐项检查具体组织／项目集合、两电话邮箱、Python/Linux必要覆盖、指定学校与雇主端点及两段日期、两项目正式参与、各自正式客户边、学校／雇主正式与inclusive命中、每客户命中正确matched_project_id、预设关联的弱claim及其标记查询。名片检查确切主体和公司、无额外联系方式／技能／正式关系，以及唯一待核实affiliation和对应claim命中。

所有必要自动检查成立也只输出manual_review_required，因为忠实归纳、来源主体归属等仍需要人工语义核对；不再有任何自动passed语义分支。失败退出码1，自动条件成立但尚需语义复核退出码2。真实用户样本仍仅报告最低检查及manual_review_required。已有真实产品失败结论保持，不因修正判定器改变。

新增判定器回归涵盖缺技能、缺memberOf、错误项目、机构查人失败、缺两跳project ID、部分处理，以及名片公司错名／关系已确认／额外电话；正确自动样本也不允许被标为语义通过。初次新增测试在判定器不存在时红灯；实现后通过。harness清理改为逐阶段allSettled，无论前一清理失败都尝试关闭图谱及删除临时目录，失败只输出CLEANUP_FAILED。

本轮只运行相关固定测试与typecheck，没有重跑真实模型，不修改产品抽取器。

审查修正验证：`rtk npm test -- --run tests/contact-live-verdict.test.ts tests/contact-recall-acceptance.test.ts`通过（当时10+5）；追加正确名片边界后单跑`tests/contact-live-verdict.test.ts`为11 passed；`rtk npm run typecheck`及`rtk proxy git diff --check`通过。
