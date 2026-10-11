# 原生 PDF 双栏验收的跨块引文修正

失败 CI：https://github.com/tang9-c/salestools/actions/runs/38069587629，tested SHA 为 d47b266d5f93927d303e78d150c881337ff80005。

真实双栏 PDF 解析成功，返回 24 个文本块。`Birch Example University` 与 `Spruce Example Network` 被拆为相邻的原生行项目。测试模拟模型要求整段名称出现在单个块中，首先抛出 `Fixture quote missing: Birch Example University`，导致抽取失败；该状态不能据此归因于 Docling 解析或 Sealos。

仅修改测试辅助函数：完整引文存在时沿用原定位；这两处已知测试文本的换行形式使用两个独立、原文精确匹配的引文。不存在的片段仍抛错，不拼接文本块，不修改生产抽取、解析或证据校验。双栏入库验收额外检查学校名称的两条原始引文均被存储，失败状态断言显示 `preview.failure`。

本地解释器验证真实单栏和双栏 PDF，分别生成 15 和 24 个块，经修正后的模拟模型及真实 DocumentExtractor 均得到 9 个候选。两处拆行名称的每条引文均定位成功；学校和机构候选允许提交。模型响应使用测试模拟，不代表真实 LLM 验收。tsc --noEmit 与改动文件 diff 检查通过。

未执行本地构建或使用旧 Rust 二进制。完整入库、回读、搜索、浏览器及生产容器验收交由远程 contact-upload-validation workflow。

## 远程结果

CI：https://github.com/tang9-c/salestools/actions/runs/38100575058，tested SHA 为 1db8ca840846fdee821d7e03bb4882db15b0627e，最终结果 success。

1319 项 Vitest、37 项 Python 测试及 3 项 Python subtests 全部通过，Rust 测试及生产容器门禁通过。contact-recall-acceptance 的 6 项测试通过，包括真实双栏 PDF 入库、回读、搜索及两条学校名称引文的持久化。后续仅补充本文档，不更改已验证代码。本分支尚未合并或发布镜像。
