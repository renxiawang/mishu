# AGENTS.md

Rules for contributors and coding agents working in this repo.

Mishu is a Slack-to-coding-agent router. A Slack thread maps to one `sbx` sandbox and one coding-agent
session. The router is plumbing, not an LLM.

## Build And Test

- Run `npm install` once.
- Run `npm run check` before every commit. It runs Biome, `tsc --noEmit`, and Vitest.
- Use `npm run check:fix` for formatter/import fixes.
- Use `npm test`, `npm run test:watch`, or `npm run test:cov` for Vitest.
- Use `npm run build` to emit `dist/`.
- Use `npm run test:live` only for live `sbx` checks; it is not part of CI.

The pre-commit hook in `.githooks/pre-commit` runs `npm run check`.

## Module Rules

- ESM only. Relative imports include `.js`.
- Use `import type` for type-only imports.
- TypeScript is strict, with `noUncheckedIndexedAccess` and unused checks enabled.
- New pure logic should have colocated `*.test.ts` coverage.

## Architecture Invariants

```
Slack <-> PlatformAdapter <-> Router <-> SandboxProvider <-> sandbox
                                                          \-> CodingBackend
```

- The router does not call models, inspect intent, or decide whether to open PRs.
- Agent output is an opaque byte stream until it reaches `CodingBackend`.
- Codex-specific parsing lives in `src/backend/codex.ts`.
- Claude-specific parsing lives in `src/backend/claude.ts`.
- The router has no durable database. Per-thread state lives inside the sandbox under
  `~/.agent-state/`.
- Router memory may hold only transient locks, dedupe state, and pending/running state.
- Keep pure code separate from I/O shells. Pure modules should not import `node:child_process`,
  `node:fs`, or Slack SDK packages.

## Router Lifecycle

- ACK Socket Mode envelopes immediately and handle work asynchronously.
- Drop Slack retries with `retry_num > 0`.
- Use reactions for acknowledgements: `eyes` while running, then `white_check_mark` or `x`.
- Do not reply just to acknowledge a mention; replies affect thread high-water marks.
- Coalesce mentions that arrive during a running turn into one follow-up turn.
- Keep stream readers attached until the agent process exits.
- Persist a new session id before posting the agent reply.
- Append transcript messages only after the reply posts successfully.

## Sandbox Rules

- Sandbox names come from `src/router/sandbox-name.ts`.
- Names must contain only `[A-Za-z0-9-]`; encode Slack `thread_ts` dots as `-`.
- Long names may hash, but `~/.agent-state/thread` must preserve the full thread id.
- Use `sbx create --clone` so agents work in an isolated VM, not the host tree.
- `sbx exec` commands are wrapped in `bash -c`.
- Do not use `--ephemeral`; resume depends on sandbox state.
- Agent stdin is redirected from `/dev/null` inside the VM to avoid headless hangs.
- Provisioning must create a writable repo clone, set `origin`, and start from a non-base branch.

## Logging

- Boundary logs go through `src/router/log.ts`.
- Summary logging is always on; verbose logging may include raw stdout/stderr and full prompts.
- Logging is best-effort and must not block or fail a turn.
- Do not log credentials or credential-shaped fields.

## Commits

- Keep commits small and logical.
- Keep `npm run check` green at every commit.
- Include the project `Co-Authored-By` trailer when making commits.
