# Task 3 Report

## Status

Implemented Token CLI, SHA-256 bearer-token authentication, four strict MCP tool contracts, camelCase service DTO mapping, and the modern MCP v2 Express HTTP entry.

## TDD record

### RED 1 — missing Task 3 surface

Command:

```text
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
```

Result: 3 failed suites because `token-service.ts`, `cli/tokens.ts`, `tool-schemas.ts`, and `http-app.ts` did not exist.

### GREEN 1 — base implementation

Command:

```text
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
```

Result: 22 passed after implementing token generation/hash verification, CLI parsing, tool registration, and Host/Origin/Bearer middleware. A follow-up typecheck exposed the SDK v2 handler auth location as `context.http.authInfo`; this was corrected against the installed declarations.

### RED 2 — camelCase service boundary

Command:

```text
rtk npm test -- --run tests/mcp-tools.test.ts
```

Result: 2 failed, proving the existing adapter leaked snake_case DTOs and passed a raw assessment ID instead of `{ assessmentId }`.

### GREEN 2 — explicit protocol mapping

Command:

```text
rtk npm test -- --run tests/mcp-tools.test.ts
```

Result: 5 passed after defining camelCase service inputs/outputs and mapping every external field in `src/mcp/tools.ts`, followed by output-schema parsing.

### RED/GREEN 3 — authenticated submit caller

Command with caller forwarding temporarily removed:

```text
rtk npm test -- --run tests/http-security.test.ts -t "accepts the exact full Origin"
```

RED result: expected submit caller `user-2`, received an empty string.

After restoring `context.http.authInfo.clientId`, the same command passed (1 passed, 6 skipped).

## Delivered behavior

- `TokenService.create/verify/disable/list` stores only SHA-256 hashes; generated plaintext is 32 random bytes encoded as base64url.
- `runTokenCli` accepts exactly `tokens:create --user`, `tokens:disable --user`, and `tokens:list`; the configured CLI opens the configured SQLite database and never lists hashes or plaintext.
- Four MCP tools register strict input/output schemas, preserve business states as successful structured results, and return matching JSON in `content` and `structuredContent`.
- `src/mcp/tools.ts` is the only snake_case boundary; service DTOs are camelCase, including nested candidates, profiles, source status, and report fields.
- `get_assessment_report` forwards only `{ assessmentId }`, so report access is not filtered by requester identity.
- HTTP uses only `createMcpHandler`, `toNodeHandler`, and `createMcpExpressApp`; it does not instantiate `NodeStreamableHTTPServerTransport`.
- Host validation runs before exact full-Origin validation, which runs before Bearer verification. Missing Origin is allowed to continue to authentication.
- Verified users become SDK `req.auth`; `authInfo.clientId` selects `servicesFor(userId)` and is passed to `submitAssessment`.
- `closeMcpHandler()` closes the modern handler during application shutdown.

## Verification

```text
rtk git diff --check
```

Passed with no whitespace errors.

```text
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
```

Passed: 3 files, 22 tests.

```text
rtk npm run typecheck
```

Passed with zero TypeScript errors.

```text
rtk npm test -- --run
```

Passed: 6 files, 55 tests.

## Concerns

- Node 24 emits the existing experimental SQLite warning during tests; it does not affect exit status.
- Non-HTTP direct `McpServer` use has no authenticated HTTP context, so the submit caller falls back to an empty string. The production `/mcp` route rejects unauthenticated requests before dispatch, and the HTTP test proves real requests receive the verified user ID.
