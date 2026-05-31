# Slack Coding Agent

Mention the bot in a Slack thread → a coding-agent CLI (Codex) does the work in an isolated `sbx`
microVM with your repo + credentials → it reports back **in the same thread**. The router is pure
plumbing (no LLM); every thread maps 1:1 to a sandbox and a coding-agent session. Standalone TypeScript
project; conventions learned from pi-mom but **no code shared** (spec §10).

Design spec: `.context/attachments/2PRioL/slack-coding-agent-spec.md`. Working in the repo? Read
[AGENTS.md](./AGENTS.md) first.

## Architecture (three seams + a stateless router, spec §3)

```
Slack ⇄ PlatformAdapter ⇄  ROUTER (no durable state, NOT an LLM)  ⇄ SandboxProvider ⇄ microVM
                                                                          └ CodingBackend (Codex CLI)
```

The router owns only transient in-memory coordination (the idle/running/pending lock + ts-dedupe).
Per-thread durable state (the seen-message ledger + session id) lives **in each sandbox** under
`~/.agent-state/`; discovery is `sbx ls` + deterministic naming. Durability is the **PR + the Slack
thread**, not a state store.

## Prerequisites

- **Node ≥ 22** (ESM / NodeNext).
- **Docker Desktop** running + **`sbx` v0.31.1** (the daemon: `sbx daemon start`).
- A coding-agent credential in sbx (the bot gates on this and walks you through it): for Codex,
  `sbx secret set -g openai --oauth`.
- A **Slack app with Socket Mode** enabled — bot scopes `app_mentions:read`, `chat:write`,
  `reactions:write`, `channels:history` (+`groups:history` for private), `files:write`, `users:read`;
  an app-level token (`xapp-…`, `connections:write`) and a bot token (`xoxb-…`).
- A **target git repo** to operate on (the `--clone` seed).

## Run

```bash
npm install
export APP_SLACK_APP_TOKEN=xapp-…   # Socket Mode app-level token
export APP_SLACK_BOT_TOKEN=xoxb-…   # bot token
export SCA_REPO=/path/to/your/repo  # the --clone seed
# optional: SCA_AGENT=codex|claude  SCA_LOG_LEVEL=summary|verbose  SCA_BOT_USER=U…
npm run build && npm start -- --sandbox=sbx ./data
# or, for development:  npm run dev -- --sandbox=sbx ./data
```

On first use the router checks `sbx secret ls`; if the agent's credential is missing it prints the
one-time setup steps and exits. Then it listens for `@bot` mentions, runs a turn per thread, and
replies in-thread. Watch a thread's boundary log:

```bash
tail -f ./data/router.log | jq 'select(.threadId=="t-C0ABCDEF-1748600000.123456")'
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | **The gate:** Biome (lint+format+imports, `--error-on-warnings`) + `tsc --noEmit` + Vitest. |
| `npm run check:fix` | Apply Biome fixes, then run the gate. |
| `npm test` / `test:watch` / `test:cov` | Run Vitest (offline unit tests). |
| `npm run test:live` | The `*.live.test.ts` lane (needs sbx daemon + Docker + creds; **not** in CI). |
| `npm run build` | Emit `dist/` (`tsc -p tsconfig.build.json`, excludes tests). |
| `npm start` / `npm run dev` | Run the built CLI / run under `tsx watch`. |

## Layout (by seam — spec §3)

```
src/
  platform/  slack-map.ts (pure event→Mention) + slack.ts (Socket Mode + Web API adapter)
  sandbox/   sbx-argv.ts (pure argv builders) + sbx-provider.ts (spawn/drain I/O shell)
  backend/   codex.ts (turnArgs/parseResult/sessionId — the ONLY agent-format knowledge) + fixtures/
  router/    state-machine, dedupe, sandbox-name, agent-state(+store), log, dispatcher, router
  cli/       args.ts + onboarding.ts + index.ts (composition root)
  types.ts   shared types
```

Pure logic is separated from I/O so almost everything is unit-tested offline with injected fakes (the
dispatcher test is the logical end-to-end). Parts that touch live services — the Socket Mode connection
and the sbx/Codex execution path — are verified hands-on (see [AGENTS.md](./AGENTS.md) §8 and the live
lane).

## Conventions

- **TypeScript** `strict`, **ESM (NodeNext)** — relative imports use `.js`; type-only imports use
  `import type`. **Biome** is the single lint/format/import tool. CI: GitHub Actions →
  `npm ci --ignore-scripts` → `check` → `build`; plus a weekly `npm audit`.
