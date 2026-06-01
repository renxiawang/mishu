# Mishu

**Mishu is a coding agent that lives in your team's chat.** Mention it in a thread — a real coding
agent does the work in an isolated sandbox with your repo and credentials, and replies in the same
thread. Follow-up mentions continue the same session; ask it to open a PR and it ships the work itself.

It works in your team's communication platform — **Slack today**, more later. It's plumbing, not a
chatbot: every thread maps 1:1 to its own microVM sandbox and coding-agent session, and the router
itself runs no LLM — it just relays your thread to a coding-agent CLI (Codex or Claude Code) and
relays the result back.

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

**Reading the bot's reactions:** 👀 means it picked up your mention and is working; it swaps to ✅ on
success or ❌ on failure when the turn finishes. The actual answer is posted as a reply in the thread.

---

## Set it up

You need the **`sbx` CLI** (Docker Sandboxes, v0.31.1 — it bundles its own container runtime and
hypervisor, so **Docker Desktop is not required**), a **Slack app**, and a **target git repo**.
One-time setup:

### 1. Sandboxes (`sbx`)

```bash
sbx login                          # sign in to Docker (to pull the sandbox images)
sbx policy set-default balanced    # allow OpenAI / GitHub / package registries

# Give the coding agent its credential (must exist BEFORE the bot creates sandboxes):
sbx secret set -g openai --oauth   # ChatGPT subscription (browser sign-in)
#   …or, to avoid subscription rate limits, an API key:
#   sbx secret set -g openai        # paste an sk-… key
sbx secret ls                      # should show: openai (… configured)
```

> **Prefer a guided flow?** After `npm install` (below), `npm run setup` asks which agent (or honors
> `MISHU_AGENT=codex|claude`), checks the credential, and walks you through the browser OAuth (Codex)
> or in-sandbox `/login` (Claude). Mishu prints the same one-liner if it starts without one.

### 2. Slack app (Socket Mode)

Never made a Slack app? Follow these steps:

1. **Create the app** — go to <https://api.slack.com/apps> → **Create New App** → **From scratch**,
   name it, and pick your workspace.
2. **Enable Socket Mode** — *Settings → Socket Mode* → toggle **Enable Socket Mode** on.
3. **App-Level Token** — generate one (the Socket Mode toggle prompts for it, or *Settings → Basic
   Information → App-Level Tokens*) with the **`connections:write`** scope. This `xapp-…` token is your
   **`APP_SLACK_APP_TOKEN`**.
4. **Bot Token Scopes** — *Features → OAuth & Permissions → Scopes → Bot Token Scopes*, add:
   - `app_mentions:read` — receive the `@mention` that triggers a turn
   - `chat:write` — post replies in the thread
   - `reactions:write` — the 👀 / ✅ / ❌ acks
   - `channels:history` — read thread messages in public channels
   - `groups:history` — read thread messages in private channels
5. **Subscribe to events** — *Features → Event Subscriptions* → toggle **Enable Events** on → under
   **Subscribe to bot events**, add **`app_mention`** (the only event this bot needs).
6. **Install** — *Settings → Install App* → install to your workspace → copy the **Bot User OAuth
   Token** (`xoxb-…`). This is your **`APP_SLACK_BOT_TOKEN`**.
7. **Invite the bot** to any channel you want it to work in: `/invite @YourBot` — it only sees
   messages in channels it's been added to.

Put the two tokens in a `.env` file at the repo root:

```bash
APP_SLACK_APP_TOKEN=xapp-…   # step 3 — app-level token (Socket Mode)
APP_SLACK_BOT_TOKEN=xoxb-…   # step 6 — bot user OAuth token
```

### 3. Run

```bash
npm install
npm run build
MISHU_REPO=/path/to/your/repo \
  node --env-file=.env dist/cli/index.js --sandbox=sbx ./data
```

On first use the bot checks `sbx secret ls`; if the agent's credential is missing it prints the exact
setup steps and exits. Once it prints `listening …`, **`@mention` it in your channel** and it goes to
work. Optional env: `MISHU_AGENT=codex|claude` (default codex), `MISHU_LOG_LEVEL=summary|verbose`,
`MISHU_BOT_USER=U…`.

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
| `npm run test:live` | `*.live.test.ts` against the real sbx daemon (needs `sbx` running; **not** in CI). |
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
and always-on boundary logging. The phased roadmap runs ergonomics → teams → cloud.
