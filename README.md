# Slack Coding Agent — starter

A **standalone** TypeScript scaffold for the router in the design spec: mention the bot in a
Slack thread → it works in an isolated sandbox → it reports back in-thread. Independent project;
conventions are **learned from pi-mom, but no code is shared or imported** (spec §10).

## Prerequisites

- Node **≥ 22** (the project is ESM / `NodeNext`).

## Commands (all verified on Node 22)

| Command | What it does |
| --- | --- |
| `npm install` | Install the dev toolchain. |
| `npm run dev` | Run the CLI under `tsx watch` (pass args: `npm run dev -- --sandbox=sbx ./data`). |
| `npm run build` | Type-check and emit `dist/` (`tsc -p tsconfig.build.json`). |
| `npm start` | Run the built CLI (`node dist/cli/index.js`). |
| `npm run check` | **CI verify:** Biome (lint + format + import-organize) + `tsc --noEmit`. |
| `npm run check:fix` | Apply Biome fixes, then type-check. |
| `npm run lint` / `format` / `typecheck` | The individual steps. |

## Layout (by seam — spec §3)

```
src/
  platform/   PlatformAdapter — Slack Socket Mode ingress/egress
  sandbox/    SandboxProvider — sbx microVM lifecycle (exec = the logged transport)
  backend/    CodingBackend   — Codex / Claude Code / Pi (turnArgs + parseResult)
  router/     Router          — dedupe, idle/running/pending, dispatch, boundary logging
  cli/        entrypoint      — `--sandbox=<provider> <data-dir>` (pi-mom-style)
  types.ts    shared types
.github/workflows/   ci.yml (check + build), audit.yml (weekly npm audit)
biome.json           single lint + format config (Biome 2.x)
tsconfig.json        base TS config (strict, ESM/NodeNext)
tsconfig.build.json  build config (emits dist/, excludes tests)
```

## Conventions (re-implemented from pi-mom's — spec §10)

- **TypeScript**, `strict`, **ESM (`NodeNext`)** — relative imports use `.js` extensions (e.g. `import { Router } from "./router/index.js"`).
- **Biome** is the single lint + format + import-organize tool. `$schema` points at the **local** `node_modules` schema so it always matches the installed Biome version (avoids the "schema does not match CLI version" error).
- **tsconfig pair:** `tsconfig.json` (base — editor + `tsc --noEmit`) and `tsconfig.build.json` (emits `dist/`, excludes tests).
- **CI:** GitHub Actions on push/PR → `npm ci --ignore-scripts` → `check` → `build`; plus a weekly `npm audit --omit=dev`.

## Implementation checklist (next steps)

The seams are typed interfaces with skeleton wiring (`Router` shows the dispatch shape). Fill them in roughly this order — section refs are to the design spec:

1. **PlatformAdapter** (`src/platform`) — Slack Socket Mode. **ACK the envelope immediately (<3s), run the handler async**; user-facing acks are reactions, not replies (§3, §4.1). Add `@slack/socket-mode` + `@slack/web-api`.
2. **SandboxProvider** (`src/sandbox`) — `sbx` microVM: `create` (`--clone`), `exec` (**wrap in `bash -c`**), `getFile`/`putFile`, `stop`/`destroy`, `list` (`sbx ls`). (§4.3, §4.4, §4.5)
3. **CodingBackend** (`src/backend`) — Codex first: `turnArgs` + `parseResult` + `captureSessionId`. Drive with `--json`, **capture stderr too, keep reading until exit** (§4.5, §4.9, §9.14–§9.15).
4. **Router** (`src/router`) — idle/running/pending coalescing, `ts` dedupe, boundary logging, and per-thread `~/.agent-state` (`transcript.jsonl` + `session`) (§4.1, §4.2, §4.6, §4.9).
5. **Wire it** in `src/cli` — construct the three implementations + `Router`, then `router.start()`.

> Runtime Slack/agent dependencies are intentionally **not** included yet, so the scaffold installs and builds with the toolchain alone. Add them as you implement each seam.
