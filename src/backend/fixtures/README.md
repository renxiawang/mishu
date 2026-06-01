# Backend fixtures

Sample agent-CLI output bytes that the backend parsers are verified against.

## Codex

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

## Claude Code

Sample `claude -p --output-format stream-json --verbose` bytes that `claude.ts` parsing is verified
against.

**Documented placeholders** (hand-authored 2026-05-31), to be recaptured live against a real sbx
`claude` sandbox — the same convention the codex fixtures started with. The real stream is JSONL: a
`{"type":"system","subtype":"init",…}` first line (carries `session_id`), `{"type":"assistant",…}` /
`{"type":"user",…}` turns, and a final `{"type":"result",…}` (carries `result` + `is_error` +
`session_id`). Session transcripts live at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (the
filename is the session id).

- `claude-stream.jsonl` — a **successful** fresh turn (init → assistant `tool_use` → `tool_result` →
  final assistant text → `result`). Confirms `parseClaudeResult` reads the `result` text,
  `parseClaudeSessionId` reads the init `session_id`, and `claudeEvents` parses every line.
- `claude-error.jsonl` — an **errored** turn (`is_error:true`, `subtype:"error_during_execution"`).
  The session is still created (the init line), so `parseClaudeSessionId` still works and the error
  message is relayed to the user.
- `claude-empty.stdout.txt` — the headless empty-output failure mode: 0 bytes (parity with codex §9.14).
- `claude-session-filename.txt` — a sample `~/.claude/projects/.../<session-id>.jsonl` basename.
- `claude-find-output.txt` — sample `find … -printf '%T@\t%p\n'` output for newest-session selection.
