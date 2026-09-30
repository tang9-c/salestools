# Contact Upload Minimal Implementation Plan

> 2026-09-30 更新：本文件保留上一轮实施记录；“替代隔离部署必须作为上线前置”的历史决定已取消。后续以 `2026-09-30-contact-upload-closeout.md` 为准，仅修现有 CI 阻塞并验收现有方案。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 删除上传页面重复业务判断，保留既定安全和产品流程。
**Architecture:** 现有服务产生完整预览及 confirmation.allowed/reasons；前端展示，确认接口重新使用相同服务端规则。复用现有鉴权、存储、队列与幂等。
**Tech Stack:** 现有 Node24/TypeScript/Express/MCP Apps/Vitest。
**Spec:** docs/superpowers/specs/2026-09-29-contact-upload-minimal-design.md

## Global Constraints

- 禁止本地构建；无新增基础设施/依赖/沙箱扩展。
- 不删安全措施，不改 CLI/MCP 既有行为；不部署。
- 页面确认只接受服务端明确 allowed=true；缺字段拒绝。
- 服务端确认重新读取完整预览，版本冲突刷新并重新明确点击。

### Task 1: 统一服务端确认判断并精简页面

**Files:** src/contacts/import-service.ts, src/mcp/http-app.ts, web/contact-upload.ts, associated tests; docs/QUICKSTART.md and original upload design/implementation docs only to reconcile scope.
**Interfaces:** complete upload preview includes confirmation:{allowed:boolean,reasons:string[]}; existing public get/commit CLI interfaces preserved. A shared server-side routine is used for preview and commit; no independently copied owner/coverage/matching rules. Avoid unnecessary new files.

- [x] Add red regressions: ready complete single-subject allowed; duplicate/incomplete/unknown coverage/multiple/no-subject denied; subsequent-page blocker denied. Exercise actual service where policy lives.
```ts
expect(preview.confirmation.allowed).toBe(false);
// confirmation endpoint still rejects when backing preview changes after GET.
expect(commitImportCalls).toHaveLength(0);
```
- [x] Run the focused regression via `rtk proxy ./node_modules/.bin/vitest run <affected-test-files>` before implementation and record genuine failure.
- [x] Extract/reuse existing server rules rather than introducing another policy implementation; return complete display data and confirmation state. Preserve final pre-write actor/source/session/version revalidation.
```ts
commit.disabled = preview.confirmation?.allowed !== true;
```
- [x] Delete frontend reviewReasons/paging business-policy replica; keep pure-text rendering, receipt/retry/teardown, explicit confirmation and all evidence/warnings.
- [x] Update browser/HTTP integration fixtures to actual new contract; keep malicious HTML, stale-policy direct commit, lost receipt and teardown tests.
- [x] Focused green + `rtk proxy ./node_modules/.bin/tsc --noEmit` + `rtk proxy git diff --check`; independent scoped review. Document actual code removed and remaining deployment/host gates.
- [x] Commit/push isolated existing feature branch for remote build validation only; native/container known prerequisite failures remain explicitly pending, no unrelated sandbox fixing.

## 实施记录（2026-09-29）

- 本轮三个生产文件 +147/-149，净减少 2 行；删除浏览器和 HTTP 的重复确认规则，服务端共享既有主体选择算法。未新增依赖、基础设施或沙箱改动。
- 针对性五文件回归 128/128；最后绑定任务编号微修后 HTTP 77/77，其余四文件未变。no-emit 和 diff 检查通过。没有本地构建。
- 独立任务审核及最终整体审核均 Approved，无 Critical/Important。既有 Node 实验 API 警告不阻断。
- 决定：保留现有解析安全限制，冻结沙箱扩展；替代隔离部署须独立验收。代价是仍维护现有沙箱，上线仍受隔离门禁限制。
- 本轮远程构建验证将在现有功能分支 push 后运行；此前 fe2aab7 的 Python 进程限额测试失败不代表本轮通过。真实宿主、完整远程门禁及隔离替代部署仍待完成，未合并/部署。

### 本轮远程结果

测试提交：`ea33e523502f29ed05ef41445cf6b2817576f07f`。已推送现有功能分支，工作区代码无待提交变更。[验证运行 36667346533](https://github.com/tang9-c/salestools/actions/runs/36667346533)：类型检查、Rust 编译/测试、服务端和上传 App bundle 构建、OCR 预热全部通过；Python 全套 2 failed / 32 passed / 29 subtests passed，两项沙箱测试的 `os.fork()` 报 `BlockingIOError: [Errno 11] Resource temporarily unavailable`，与此前进程限额阻塞一致。后续全套 Vitest 和生产容器 gate 被跳过。完整 CI 未通过，未放宽控制或修复旧沙箱；真实宿主与解析隔离替代部署仍待验收。

本轮简化开发、两轮审核及远程构建验证已完成；完整发布门禁未完成。不合并、不部署，保留功能分支。
