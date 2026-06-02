# Backend fixtures

Sample agent-CLI output bytes that the backend parsers are verified against.

## Codex

Sample `codex exec --json` bytes that `codex.ts` parsing is verified against.

Captured live against codex 0.130.0 in an sbx microVM (2026-05-31). The real
`--json` event schema is `thread.started` (carries `thread_id` = the session id),
`turn.started`, `item.*`, `turn.completed`/`turn.failed`, and `error`. The parser
is tolerant of several shapes so it survives version drift.

- `codex-error.jsonl` — **REAL bytes**: a `thread.started` + `turn.started` +
  `error` + `turn.failed` stream (the run hit the subscription usage limit).
  Confirms `parseSessionId` reads `thread_id` and the error message is relayed.
- `codex-json-stream.jsonl` — a **successful** fresh turn (assistant message). Still
  a documented placeholder: the live success path was **quota-blocked**;
  recapture with an OpenAI API key or after the limit resets. The parser already
  handles the `item.completed`/`agent_message`/`last_agent_message` shapes.
- `codex-empty.stdout.txt` — the headless empty-output regression: 0 bytes, exit 0.
- `codex-rollout-filename.txt` — a sample `~/.codex/sessions/.../rollout-*.jsonl` filename.
- `codex-find-output.txt` — sample `find … -printf '%T@\t%p\n'` output for newest-rollout selection.

## Claude Code

Sample `claude -p --output-format stream-json --verbose` bytes that `claude.ts` parsing is verified
against. The stream is JSONL: a `{"type":"system","subtype":"init",…}` first line (carries
`session_id`), `{"type":"assistant",…}` / `{"type":"user",…}` turns, and a final
`{"type":"result",…}` (carries `result` + `is_error` + `session_id`). Session transcripts live at
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (the filename is the session id).

**Live-validated 2026-05-31** against Claude Code **2.1.141** in an sbx `claude` microVM (image
`docker/sandbox-templates:claude-code-docker`, sbx v0.31.1):

- the argv `claude -p --output-format stream-json --verbose --dangerously-skip-permissions -- PROMPT`
  parses (the `--` operand is the prompt; the run reaches the API), and `--output-format stream-json`
  errors without `--verbose` (`"When using --print, --output-format=stream-json requires --verbose"`);
- `--resume` **reuses** the session id (a stable id across turns) unless `--fork-session` is passed —
  the basis for capture-once + resume;
- `is_error:true` can ship with `subtype:"success"` — so `parseClaudeResult` keys on `is_error`,
  never `subtype`;
- `captureSessionId`'s `find $HOME/.claude/projects -name '*.jsonl' -printf '%T@\t%p\n'` returns the
  real transcript (`…/<cwd-slug>/<session-id>.jsonl`); `parseClaudeSessionFilename` reads the id from
  that basename;
- **end-to-end**: a `--clone` sandbox with a provisioned repo ran turn 1 (created a file via the
  `Write` tool, `is_error:false`, no approval prompt) then turn 2 `claude -p --resume <id>` recalled a
  planted codeword from session history — the **same session id across both turns** (no fork).

Fixtures (all REAL captured bytes unless noted):

- `claude-stream.jsonl` — **REAL bytes**: a successful turn that created a file (init →
  `rate_limit_event` → assistant `thinking` → assistant `tool_use` (Write) → `tool_result` →
  assistant text → `result`, `is_error:false`, `result:"done"`). Exercises the thinking/tool_use skip
  and the authoritative `result` text; captured with `--dangerously-skip-permissions` (the Write ran
  with no approval prompt).
- `claude-error.jsonl` — **REAL bytes**: a fresh turn that reached the API and failed auth
  (`is_error:true`, `result:"Not logged in · Please run /login"`, `subtype:"success"`). The session
  is still created (the init line), so `parseClaudeSessionId` still works and the message is relayed.
- `claude-empty.stdout.txt` — the headless empty-output failure mode: 0 bytes (parity with codex).
- `claude-session-filename.txt` — a sample `<session-id>.jsonl` transcript basename.
- `claude-find-output.txt` — sample `find … -printf '%T@\t%p\n'` output for newest-session selection
  (real format/paths; two lines to exercise the mtime tiebreak).
