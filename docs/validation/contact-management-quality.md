# 联系人质量评测

状态：verified-pass

样本版本：synthetic-contact-quality-v1；annotations SHA-256：3ae5e8a42c372f197b82b02df613eaf4808a368d370f183ea317157e102f0059

逐文件 SHA-256：{"synthetic-resume.pdf":"129bbbcea1c04abe4a263485b56697bb624928747b2f1bb60cbd6fa992cb7ec9","text-avery-nora.pdf":"fa33d87f87ffb200826f1a1fbac026e7b86e8a8fe60994763ee329184e35d6cf","text-jordan-roles.pdf":"68a94b1e621e2de1f0280a05e3d6a266b4a6c8505d977acc97b120ad046ab339","text-dana-injection.pdf":"87c627270fad00a1447b1ca827909cd220bb547bbb9feafe88ee24178fbe5d12","scan-chen.pdf":"96729215a2227d1399a35cd954b47d224acbe4bcf9360759b1ed94c84838dbd8","scan-robin-twin.pdf":"b4ad2087e843bbc6e04e4e8e60d30eacdd4f7b2f778f4b22d58624f4ec486c08","scan-two-people.pdf":"693b5b6b75cd37357c99fcba7d4ba957e05a6a50b5be1a5702555902b6426711","scan-noisy.pdf":"6484c682523e800f24cfc43bcba9e06d4479034276cb10f59d3eec6b04750746","synthetic-card.png":"abeac820b9e3f8cba88f3bc31f9356de7a6777f883508fd9e9a4a462e9df9193","card-zh.jpg":"c7fd3651e65a25f7bb290cade530893fa684d191df083bf6c416cda09f1ff363","card-phone.png":"a28e9860f47bed9656ce2d46b16d5099f6f4cbb6e14e5fc6e8bc2924c5f8138c","card-multi.jpg":"7d45016d695ef79013953b023f0a5fb69ed8f1c79a27ad5a599bd3e6691c9407"}

运行时间：2026-09-26T15:52:05.500Z；耗时：229162 ms

服务端点：http://127.0.0.1:55923；部署与模型元数据：{"deployment":"dd9ef312bb45282bb6aac778aa289517658b9bde","arkEndpoint":"https://aigw.feigenbaum.com.cn/v1/chat/completions","arkModel":"lite32k","embeddingEndpoint":"https://aigw.feigenbaum.com.cn/v1/embeddings","embeddingModel":"doubao-embedding-vision-251215","doclingVersion":"2.130.0","ocrVersion":"rapidocr-3.9.2"}

本地锁文件、Docling 解析器、抽取提示词、问答提示词、契约和评测脚本 SHA-256：{"python/uv.lock":"631a42f54c7071ae0874b08f4f4a10ebc709a7ca1443d54c3c5ed7aee2701e8d","python/contact_worker/parser.py":"ff73db0e1643f96b2ca61469d977df1bdecfb58b9dd70439dde11bb6910dff3b","src/contacts/document-extractor.ts":"7b870d1d52e17bff99b51c86d8fe8e595b24c989f4de4113b5000c958717424e","src/contacts/contact-answer.ts":"977214a90bb9108e626a162973a5963b77ec768bced82bb3c4ace574932ae29e","src/contacts/embedding-client.ts":"f42818903295a61c75cbba2817f15e61fa942af168a188c914831cdf93e7d657","src/contracts/contact-graph.ts":"00fdfe14d11b72c064dab89c565aef27871ff31e33199a80f10526295b794813","scripts/evaluate-contacts.ts":"f477feb443c61f47ec8224adb4fa06664637de623138ea1e401388ef0cd04a2c"}

微平均 precision=1.0000，recall=1.0000；semantic Top-5=10/10；问答=10/10；伪造关系=0；伪造引用=0；证据错误=0；实体类型错误=0；服务错误=0

| 文档 | TP/FP/FN | 关系伪造 | 实体类型错误 | 证据错误 | 失败细节 |
| --- | --- | --- | --- | --- | --- |
| resume-lin | 2/0/0 | 0 | 0 | 0 | [] |
| text-avery-nora | 14/0/0 | 0 | 0 | 0 | [] |
| text-jordan-roles | 10/0/0 | 0 | 0 | 0 | [] |
| text-dana-injection | 3/0/0 | 0 | 0 | 0 | [] |
| scan-chen | 7/0/0 | 0 | 0 | 0 | [] |
| scan-robin-twin | 4/0/0 | 0 | 0 | 0 | [] |
| scan-two-people | 10/0/0 | 0 | 0 | 0 | [] |
| scan-noisy | 3/0/0 | 0 | 0 | 0 | [] |
| card-robin | 2/0/0 | 0 | 0 | 0 | [] |
| card-zh | 4/0/0 | 0 | 0 | 0 | [] |
| card-phone | 4/0/0 | 0 | 0 | 0 | [] |
| card-multi | 6/0/0 | 0 | 0 | 0 | [] |

| 语义案例 | Top-5 | 排名/原因 |
| --- | --- | --- |
| q01 | true | 1 |
| q02 | true | 1 |
| q03 | true | 1 |
| q04 | true | 1 |
| q05 | true | 1 |
| q06 | true | 1 |
| q07 | true | 1 |
| q08 | true | 1 |
| q09 | true | 1 |
| q10 | true | 1 |

| 问答案例 | 通过 | 失败细节 |
| --- | --- | --- |
| a01 | true | [] |
| a02 | true | [] |
| a03 | true | [] |
| a04 | true | [] |
| a05 | true | [] |
| a06 | true | [] |
| a07 | true | [] |
| a08 | true | [] |
| a09 | true | [] |
| a10 | true | [] |

## 同预算 Docling Graph 对比与决策

触发原因：早期复测中跨页同人归并与 OCR 分块的任职字段证据未过门槛。使用固定 [`docling-graph@bbcd0e4`](https://github.com/docling-project/docling-graph/tree/bbcd0e4846fadfcadac2800784783e59cd2722a9)、同一组 12 份合成文件、同一 Ark 聊天模型 `lite32k`，以 `run_pipeline` 的 `many-to-one`/`direct` 路径运行一次。对比模板只含 Person/Organization 的 `name`、`jobTitle`、`email`、`telephone` 与 `worksFor`，所以共同口径只统计这些字段和关系，**不把上游未建模的任职日期算作它的漏抽**。全程硬限 16 次实际 LiteLLM completion 调用；上游每份文件用了 2 次，因此前 8 份完成后预算已尽，余下 4 张名片未调用远端模型。

| 实现与范围 | TP/FP/FN | precision / recall | 无原文支持的关系 | 字段级引文 | 耗时 / 模型调用 |
| --- | --- | --- | --- | --- | --- |
| 当前实现，前 8 份共同口径 | 39/0/0 | 100% / 100% | 0 | 字段与关系的证据错误 0 | 包含在下面的端到端运行中 |
| Docling Graph，前 8/12 份，共同口径 | 35/9/4 | 79.55% / 89.74% | 4 | 输出只有节点级来源，35 个命中项中 0 个附可逐字段核验的短引文 | 182.1 秒抽取；16 次调用；计入 4 份预算截断共 198.6 秒 |
| 当前实现，全部 12 份完整契约 | 69/0/0 | 100% / 100% | 0 | 字段与关系的证据错误 0 | 239.3 秒对比当次端到端；抽取 12 次调用 |

上游在无任职陈述的简历、人物简介和噪声扫描件中补出了 `worksFor`，并把带分机号电话 `+86 10 5555 0101 转 208` 改为 `+861055550101转208`。它在重复档案编号跨页归并上表现较好，但这份一次性对比的模板、处理范围和耗时范围与完整本地评测不同，不能据此推断一般场景性能。决策：继续使用当前 Docling 解析加固定联系人抽取层；不把 Docling Graph 加入生产依赖，也不实现双后端切换。
