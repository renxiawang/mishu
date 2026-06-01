# Slack Coding Agent

**Mention a bot in a Slack thread — a real coding agent does the work in an isolated sandbox with
your repo and credentials, and replies in the same thread.** Follow-up mentions continue the same
session; ask it to open a PR and it ships the work itself.

It's plumbing, not a chatbot: every thread maps 1:1 to its own microVM sandbox and coding-agent
session, and the router itself runs no LLM — it just relays your thread to a coding-agent CLI (Codex)
and relays the result back.

---

## What you can do with it

- **Fix an issue from a thread.** Describe a problem, `@mention` the bot, and it reads the thread,
  makes the change in your repo, and replies in-thread.
- **Iterate conversationally.** Mention it again in the same thread to continue — it remembers prior
  turns and any messages teammates added in between.
- **Run work in parallel.** Different threads run independent tasks at the same time without colliding.
- **Pick up after idle.** Mention it a day later and it resumes where it left off — code and
  conversation both restored.
- **Ship it.** Ask it to push or open a PR and the agent runs `git`/`gh` itself from inside the sandbox.
- **Grab a file.** Ask for a file it produced and it uploads it to the thread.

**Reading the bot's reactions:** 👀 means it picked up your mention and is working; it swaps to ✅ on
success or ❌ on failure when the turn finishes. The actual answer is posted as a reply in the thread.

---

## Set it up

You need **Docker Desktop**, the **`sbx` CLI** (Docker Sandboxes, v0.31.1), a **Slack app**, and a
**target git repo**. One-time setup:

### 1. Sandboxes (`sbx`)

```bash
# Docker Desktop must be running, then:
sbx login                          # sign in to Docker
sbx policy set-default balanced    # allow OpenAI / GitHub / package registries

# Give the coding agent its credential (must exist BEFORE the bot creates sandboxes):
sbx secret set -g openai --oauth   # ChatGPT subscription (browser sign-in)
#   …or, to avoid subscription rate limits, an API key:
#   sbx secret set -g openai        # paste an sk-… key
sbx secret ls                      # should show: openai (… configured)
```

### 2. Slack app (Socket Mode)

Create a Slack app with **Socket Mode enabled** and these **bot scopes**: `app_mentions:read`,
`chat:write`, `reactions:write`, `channels:history` (+ `groups:history` for private channels),
`files:write`, `users:read`. Install it to your workspace and **invite the bot to a channel**.

Put the two tokens in a `.env` file at the repo root:

```bash
APP_SLACK_APP_TOKEN=xapp-…   # app-level token (Socket Mode; scope connections:write)
APP_SLACK_BOT_TOKEN=xoxb-…   # bot token
```

### 3. Run

```bash
npm install
npm run build
SCA_REPO=/path/to/your/repo \
  node --env-file=.env dist/cli/index.js --sandbox=sbx ./data
```

On first use the bot checks `sbx secret ls`; if the agent's credential is missing it prints the exact
setup steps and exits. Once it prints `listening …`, **`@mention` it in your channel** and it goes to
work. Optional env: `SCA_AGENT=codex|claude` (default codex), `SCA_LOG_LEVEL=summary|verbose`,
`SCA_BOT_USER=U…`.

> To let the agent **push / open PRs**, also give it a repo-scoped GitHub token:
> `sbx secret set -g github` (prefer a fine-grained PAT scoped to the target repo).

### Watch what it's doing

Every turn is logged at the agent boundary to `./data/router.log` (JSONL). Tail one thread:

```bash
tail -f ./data/router.log | jq 'select(.threadId=="t-<channel>-<thread_ts>")'
```

---

## How it works

```
Slack ⇄ PlatformAdapter ⇄  ROUTER (no durable state, NOT an LLM)  ⇄ SandboxProvider ⇄ microVM
                                                                          └ CodingBackend (Codex CLI)
```

The router owns only transient in-memory coordination (an idle/running/pending lock + ts-dedupe).
Per-thread durable state — the seen-message ledger and the coding-agent session id — lives **inside
each sandbox** (`~/.agent-state/`); the router finds a thread's sandbox by deterministic naming +
`sbx ls`, with no database. Durability is the **PR + the Slack thread**, not a state store. Isolation
is a hypervisor-backed microVM per thread, with host-proxied credentials that never enter the VM.

Three swappable seams (Slack · sbx · Codex today; Discord/e2b/Claude tomorrow) keep every
vendor-specific choice behind an interface. Standalone project; conventions learned from pi-mom but
**no code shared**.

---

## Development

Working in this repo? **Read [AGENTS.md](./AGENTS.md) first** — it has the architecture invariants
(router-is-plumbing, transport ≠ interpretation, pure-core vs I/O-shell, the naming/logging/lifecycle
rules) you must follow.

| Command | What it does |
| --- | --- |
| `npm run check` | **The gate:** Biome (lint + format + imports) + `tsc --noEmit` + Vitest. Keep it green. |
| `npm run check:fix` | Apply Biome fixes, then run the gate. |
| `npm test` / `test:watch` / `test:cov` | Run Vitest (offline unit tests). |
| `npm run test:live` | `*.live.test.ts` against the real sbx daemon (needs Docker + sbx; **not** in CI). |
| `npm run build` | Emit `dist/` (`tsc -p tsconfig.build.json`, excludes tests). |
| `npm start` / `npm run dev` | Run the built CLI / run under `tsx watch`. |

Pure logic is separated from I/O so almost everything is unit-tested offline with injected fakes (the
dispatcher test is the logical end-to-end); the live sbx/Codex and Socket Mode paths are verified
hands-on. **TypeScript** `strict`, **ESM (NodeNext)** — relative imports use `.js`, type-only imports
use `import type`. **Biome** is the single lint/format tool. CI runs `check` then `build`.

### Layout (by seam)

```
src/
  platform/  slack-map.ts (pure event→Mention) + slack.ts (Socket Mode + Web API adapter)
  sandbox/   sbx-argv.ts (pure argv builders) + sbx-provider.ts (spawn/drain I/O shell)
  backend/   codex.ts (turnArgs/parseResult/sessionId — the ONLY agent-format knowledge) + fixtures/
  router/    state-machine, dedupe, sandbox-name, agent-state(+store), log, dispatcher, idle-sweep, router
  cli/       args.ts + onboarding.ts + index.ts (composition root)
  types.ts   shared types
```

---

## Status

**Phase 1 (local, single-user, macOS Apple silicon)** — verified end-to-end against real Slack + sbx +
Codex: mention → isolated sandbox → repo clone → headless codex → reply in-thread, with deterministic
sandbox naming, per-thread `~/.agent-state` ledger + session resume, idle/running/pending coalescing,
and always-on boundary logging. The design spec lives at
`.context/attachments/2PRioL/slack-coding-agent-spec.md`; the phased roadmap (ergonomics → teams →
cloud) is §8 there.
