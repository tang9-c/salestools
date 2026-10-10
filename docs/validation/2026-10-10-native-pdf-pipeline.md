# PDF 切换到 NativePdfPipeline

PDF 使用 Docling NativePdfPipeline：按默认行粒度输出文字，保留页码、坐标与 source_ref。解析线程固定为 1，不生成页面或图片渲染，不执行 PDF OCR、布局或表格模型。PNG/JPEG 仍使用原 StandardPdfPipeline OCR。Worker 容器、安全边界、资源上限、120 秒解析期限和阶段/内存日志保持不变。

Docling 最低版本提高到 2.130.0，与已有 uv.lock 的解析版本一致，未升级锁定依赖。无需新增依赖。

## 失败与内容边界

- 非 SUCCESS 或缺页返回 CONVERSION_FAILED，不接收部分结果。
- PDF 任意页面没有非空文字项，返回 PDF_TEXT_UNAVAILABLE；纯扫描 PDF、含空白页的 PDF 会被拒绝。不会自动回退到重型解析。
- 同一页面同时有原生文字和图片时，图片中的文字不做 OCR；存在文字不等于完整语义覆盖。
- 标题/表格不再作为结构化标签输出，阅读顺序取决于解析后端。原简历的任职归属、项目边界和技能召回仍需真实验收。
- 上传文件路径是无后缀 UUID，文件种类检查使用已验证的 PDF 签名，不依赖扩展名。

## 验证

本地仅运行解释器层定向测试和 tsc --noEmit，未执行构建或真实 Docling native 转换。已增加原生 PDF 配置、缺页/部分转换/无文字拒绝、图片 OCR 保留及错误码传递测试。

现有 contact-upload-validation.yml 的远程完整 Python 测试和容器门禁会执行真实文本 PDF 转换及图片 OCR；新增纯图片 PDF 拒绝测试也在远程完整套件执行。尚未运行本轮远程 CI，尚未部署，不能据此宣称原简历问题已修复。
