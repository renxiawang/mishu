# Mishu

Mishu is a Slack bot that lets a team run coding-agent work from a shared thread.
Mention the bot, and it starts a coding-agent CLI inside an isolated `sbx` sandbox, then replies in
the same thread. Follow-up mentions in that thread resume the same sandbox and agent session.

The router is deliberately small: it does not call an LLM, classify intent, or decide whether to
delegate. It moves Slack thread text to a coding agent, captures the result, and keeps each Slack
thread mapped to one sandbox.

## Features

- One Slack thread maps to one sandbox and one agent session.
- Follow-up mentions resume the same coding-agent context.
- Different threads can run in parallel.
- Sandboxes keep per-thread state under `~/.agent-state/`.
- The coding agent can push or open a PR when the sandbox has GitHub credentials.
- Boundary logs are written as JSONL for debugging and audits.

## Requirements

- Node.js 22+
- The Docker Sandboxes `sbx` CLI
- A Slack app with Socket Mode enabled
- A target git repo
- A Codex or Claude Code credential configured in `sbx`

For PR creation, the target repo should have a pushable `origin`, and the sandbox needs a repo-scoped
GitHub credential:

```bash
sbx secret set -g github
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the coding-agent credential

Codex is the default agent:

```bash
npm run setup
```

To set up Claude Code instead:

```bash
MISHU_AGENT=claude npm run setup
```

The setup command checks `sbx secret ls` and runs the needed interactive login flow.

### 3. Create the Slack app

Create an app at <https://api.slack.com/apps>, enable Socket Mode, and add these scopes:

| Token | Scopes |
| --- | --- |
| App-level token | `connections:write` |
| Bot token | `app_mentions:read`, `chat:write`, `reactions:write`, `channels:history`, `groups:history` |

Subscribe the app to the `app_mention` bot event, install it to your workspace, and invite it to the
channels where it should work.

Create `.env` from [.env.example](./.env.example):

```bash
APP_SLACK_APP_TOKEN=xapp-...
APP_SLACK_BOT_TOKEN=xoxb-...
```

### 4. Run Mishu

```bash
npm run build
MISHU_REPO=/path/to/your/repo \
  node --env-file=.env dist/cli/index.js --sandbox=sbx ./data
```

When Mishu prints `listening`, mention the bot in Slack.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `APP_SLACK_APP_TOKEN` | Yes | Slack app-level Socket Mode token (`xapp-...`). |
| `APP_SLACK_BOT_TOKEN` | Yes | Slack bot user token (`xoxb-...`). |
| `MISHU_REPO` | Yes | Repo path or ref passed to `sbx create --clone`. |
| `MISHU_AGENT` | No | `codex` or `claude`; default is `codex`. |
| `MISHU_LOG_LEVEL` | No | `summary` or `verbose`; default is `summary`. |
| `MISHU_BOT_USER` | No | Slack bot user id; resolved with `auth.test` when omitted. |

## Logs

Each turn is logged to `./data/router.log` as JSONL. Summary logs include argv, prompt size/hash, exit
code, duration, and final-message snippet. Verbose logs also include raw stdout/stderr chunks.

```bash
tail -f ./data/router.log | jq 'select(.threadId=="t-<channel>-<thread-ts>")'
```

Credentials are stored and injected by `sbx`; Mishu does not put Slack, OpenAI, Anthropic, or GitHub
secrets in prompts or argv.

## Development

Read [AGENTS.md](./AGENTS.md) before changing the router, sandbox, platform, or backend seams.

| Command | Description |
| --- | --- |
| `npm run check` | Biome check, TypeScript, and Vitest. This is the main gate. |
| `npm run check:fix` | Apply Biome fixes, then run the gate. |
| `npm test` | Run offline unit tests. |
| `npm run test:live` | Run live `sbx` tests. Requires the `sbx` daemon and is not part of CI. |
| `npm run build` | Compile `dist/`. |
| `npm run dev` | Run the CLI under `tsx watch`. |

## Architecture

```
Slack <-> PlatformAdapter <-> Router <-> SandboxProvider <-> sandbox
                                                          \-> CodingBackend
```

- `src/platform/`: Slack event mapping and Slack SDK adapter.
- `src/router/`: thread state machine, dedupe, sandbox naming, state store, logging, dispatcher, idle sweep.
- `src/sandbox/`: `sbx` argv builders and provider.
- `src/backend/`: Codex and Claude Code argument builders and output parsers.
- `src/cli/`: argument parsing, setup flow, and composition root.
