# 持续企业研究合成 fixture

`http.ts` 只监听 loopback HTTP MCP，使用临时文件 SQLite 和合成 Token。默认保留生产 Runner、buildResult、QCC gateway、搜索 mapper、Ark 请求与预算校验；只在网络 dispatch 边界返回受控结果。个别生命周期场景注入来源／模型接口用于精确控制取消与迟到。不开 native、浏览器、页面 bundle，不读取生产配置或密钥。

`schema-237ca6d.ts` 是 `git show 237ca6d83a43d4d042a6aa847281bcab50128026:src/db/schema.ts` 的原样快照。升级测试先用这份真正旧 schema 创建文件库并插入 Token、画像与评估报告，再执行新版 initializeDatabase；验证旧记录逐字段不变和新增三表。它不是从新版删表模拟的旧库。

`company-research-native.test.ts` 是独立远程测试，实际启动 Rust Store 并保存四类职业关系与来源，再经生产 collector/Runner/builder 读取固定结果。缺少可执行二进制直接失败，不自动编译、不 skip。只在既有远程 workflow 完成 Rust build 后运行。
