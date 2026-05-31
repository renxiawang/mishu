# Codex fixtures

Sample `codex exec --json` bytes that `codex.ts` parsing is verified against.

Captured live against codex 0.130.0 in an sbx microVM (2026-05-31). The real
`--json` event schema is `thread.started` (carries `thread_id` = the session id),
`turn.started`, `item.*`, `turn.completed`/`turn.failed`, and `error`. The parser
is tolerant of several shapes so it survives version drift.

- `codex-error.jsonl` — **REAL bytes**: a `thread.started` + `turn.started` +
  `error` + `turn.failed` stream (the run hit the subscription usage limit, §9.7).
  Confirms `parseSessionId` reads `thread_id` and the error message is relayed.
- `codex-json-stream.jsonl` — a **successful** fresh turn (assistant message). Still
  a documented placeholder: the live success path was **quota-blocked** (§9.7);
  recapture with an OpenAI API key or after the limit resets. The parser already
  handles the `item.completed`/`agent_message`/`last_agent_message` shapes.
- `codex-empty.stdout.txt` — the headless empty-output regression: 0 bytes, exit 0 (§9.14).
- `codex-rollout-filename.txt` — a sample `~/.codex/sessions/.../rollout-*.jsonl` filename.
- `codex-find-output.txt` — sample `find … -printf '%T@\t%p\n'` output for newest-rollout selection.
