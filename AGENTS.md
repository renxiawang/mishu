# AGENTS.md — rules for working in this repo

Mishu — a coding agent that lives in your team's chat (Slack today): mention it in a Slack thread → it
does the coding work in an isolated `sbx` microVM running a coding-agent CLI (Codex or Claude Code) →
it reports back **in the same thread**.

## 0. What this is — and is NOT

- The **router is plumbing, not an LLM**. It has **no model calls**, makes **no decisions about
  whether to delegate**, and does **no intent detection**. In particular it does **not** detect "open
  a PR" — shipping is the agent's job (`git`/`gh` inside the sandbox). Adding reasoning,
  branching on message content, or an "outer bot" to the router is **out of scope by default** — the
  router stays pure plumbing unless a strong, explicit use case justifies otherwise.
- Every Slack thread maps 1:1 to one sandbox to one coding-agent session.

## 1. Build / check / test

- `npm install` once. **`npm run check` is the single gate**: Biome (lint + format + organize-imports,
  `--error-on-warnings`) + `tsc --noEmit` + `vitest run`. Run it before every commit; **keep the repo
  green at every commit**. `npm install` also wires a **pre-commit hook** (`.githooks/pre-commit`, via
  the `prepare` script setting `core.hooksPath`) that runs the gate automatically; bypass in a pinch
  with `git commit --no-verify`.
- `npm run check:fix` applies Biome fixes then runs the gate. `npm test` / `npm run test:watch` /
  `npm run test:cov` run Vitest. `npm run build` emits `dist/` (excludes `*.test.ts`). `npm run dev`
  runs the CLI under `tsx watch`.
- `npm run test:live` runs the `*.live.test.ts` lane — needs the sbx daemon running (sbx bundles its
  own runtime; no Docker Desktop), so it's **NOT** part of `check`/CI. Run it locally after any `sbx`
  upgrade (substrate risk).

## 2. Module rules (ESM, strict)

- NodeNext + `verbatimModuleSyntax`: **every relative import ends in `.js`** (e.g.
  `import { Router } from "./router/index.js"`); type-only imports use `import type`. No CommonJS.
- `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters` are on — index access is
  `T | undefined`; handle it explicitly.

## 3. Three seams + the stateless router

```
Slack ⇄ PlatformAdapter ⇄  ROUTER (no durable state, NOT an LLM)  ⇄ SandboxProvider ⇄ microVM
                                                                          └ CodingBackend (Codex CLI)
```

Invariants — do not break these:

- **Transport ≠ interpretation.** `SandboxProvider.exec` is an **opaque byte stream** the router
  logs at the boundary. The **only** place that knows an agent's output/CLI format is `CodingBackend`
  (`src/backend/codex.ts`). **No Codex `item.*`/event-schema or rollout-file knowledge may live outside
  `backend/codex.ts`.**
- **No central state store.** The router runs no DB and keeps no disk state of its own.
  Discovery = `SandboxProvider.list()` (`sbx ls`) + deterministic naming. Per-thread durable state
  (`transcript.jsonl`, `session`, `thread`) lives **in each sandbox** under `~/.agent-state/`. Router
  memory holds only the transient `idle/running/pending` lock + ts-dedupe set — lost on restart by
  design (an in-flight turn is re-driven idempotently on the next mention).
- **Pure core vs I/O shell.** Pure modules import only `../types.js`, seam interfaces, and pure stdlib
  (`node:crypto`) — **never** `node:child_process`, `node:fs`, `@slack/*`. I/O shells import the pure
  core, never the reverse. New logic ⇒ a pure module + a colocated `*.test.ts`. This is what keeps the
  system testable offline (no daemon, tokens, or creds in CI).

## 4. Sandbox naming — `src/router/sandbox-name.ts`

- `name = "t-" + channel + "-" + thread_ts` with the `.` encoded as `-`. **The binding constraint
  (verified LIVE) is the container HOSTNAME**, which rejects BOTH `_` (so an earlier
  `replace(".", "_")` sample is illegal for `--name`) AND `.` (accepted by `--name` but `sbx create` fails
  "hostname: value must be a valid hostname"). So emit only `[A-Za-z0-9-]` — encode `thread_ts`'s `.`
  as `-`. A test guards against ever emitting `_` or `.`.
- Reversible: `t-<channel>-<secs>-<micros>` (channel has no `-`; ts is two numeric groups). Over-length
  names fall back to `t-<hash>`; the full id is stored in `~/.agent-state/thread`.

## 5. Boundary logging — `src/router/log.ts`

- Always-on **summaries** (argv + session id + prompt size/hash; exit code + duration + final-message
  snippet + `ok`) and a **verbose** toggle for raw stdout/stderr + full prompt. `direction ∈ in | out |
  router`; `turnId` correlates a turn's IN + streamed OUT + exit.
- **Best-effort, never blocking** — writes never `await` on the turn's critical path and never throw
  (a full disk / slow shipper must not stall a turn). **Cap/hash** large prompts and tool-output bursts.
- **Never log credentials** — they're proxy-side and never enter argv/prompt. A test asserts no
  credential-shaped field is emitted.

## 6. Router lifecycle — `src/router/router.ts`, `dispatcher.ts`

- **ACK the Socket Mode envelope immediately (<3s) on receipt; run the handler async.** Drop
  `retry_num > 0`. Dedupe on the trigger `ts` (TTL'd to the ~5-min retry window).
- **Acks are reactions, not replies.** 👀 on every mention; swap to ✅/❌ on completion. A *reply* ack
  would move the catch-up high-water mark and corrupt the delta if a turn fails before posting.
- **Coalescing.** Mid-turn mentions only flip one `pending` bit; one follow-up turn runs whose delta
  covers them all — **Slack is the queue**, mentions are never buffered in the router.
- **The stream reader is part of the dispatched turn and must outlive the dispatch.** "Free the router"
  means free it for *other* threads — never drop this turn's reader (truncates the log / trips the
  broken-pipe panic).
- **Write-after-success.** Persist the session id BEFORE posting; append the transcript AFTER the
  reply. An abandoned/crashed turn then re-feeds cleanly (at-least-once).
- Turn-1 vs resume is the **session file's presence**; the transcript high-water mark is the
  **delta boundary**.

## 7. Codex / exec gotchas — `src/sandbox/sbx-argv.ts`, `backend/codex.ts`

- Wrap exec in `bash -c` (`sbx exec` sources no env). **Redirect the agent's stdin from `/dev/null`
  IN the VM** (`<command> < /dev/null`) — verified live: `sbx exec` keeps the VM process's stdin open
  even when the host closes its end, so codex otherwise hangs on "Reading additional input from
  stdin..." forever. Never pass `-i`; **capture stderr** too. **Never `--ephemeral`** (breaks
  resume). The `--json` stream's `thread.started` event carries the session id (`thread_id`).
- **Provisioning:** with `--clone`, `/home/agent/workspace` is empty under `sbx exec`; the repo
  is a read-only mount at `/run/sandbox/source` (a valid git repo) plus a git daemon. A provision step
  (the dispatcher's `provisionScript`) must clone it into a writable dir, point `origin` at the real
  remote, and seed a non-base branch before the agent works.
- Keep Codex's native sandbox ON: `-c sandbox_mode=workspace-write -c approval_policy=never` (set via
  `-c` because `resume` lacks `-s`). This is defense-in-depth against prompt injection — Slack content
  is untrusted.
- Headless `codex exec` can emit **empty stdout** without a TTY on long prompts — `parseResult` treats
  empty output as a failed turn, and `sbx-argv` has a PTY wrap option (`script`) to mitigate. Resolve
  PTY-vs-pin during live verification; the boundary log surfaces "argv → 0 bytes, exit 0".

## 8. Test conventions

- **Vitest** (`globals` on), colocated `*.test.ts`, run via `npm test`. **Inject collaborators** (the
  spawn fn, a clock, fakes) — there is no live daemon, no tokens, and no mocking framework needed.
- New pure logic ⇒ a colocated transition/round-trip/table/fixture test. Backend parsing is verified
  against committed `src/backend/fixtures/` (real bytes after the live pass), including the empty-output
  regression. Live-only checks go in `*.live.test.ts` (gated out of CI).

## 9. Commits

- Small, logical, **green at every commit** (`npm run check` passes). Add a runtime dependency only at
  the seam that first needs it. Work on a branch; don't commit to the default branch directly. End
  commit messages with the project's `Co-Authored-By` trailer.
