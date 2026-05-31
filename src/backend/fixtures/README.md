# Codex fixtures

Sample `codex exec --json` bytes that `codex.ts` parsing is verified against.

> **Status: best-guess placeholders.** These approximate the codex 0.135.0
> `--json` event shapes. They are **replaced with real captured bytes** during
> the live verification pass (plan C8.5 / spec §9), at which point the parser is
> reconciled to the exact schema. The parser is intentionally tolerant of
> several plausible event shapes so it survives the swap.

- `codex-json-stream.jsonl` — a successful fresh turn (session-id event + final assistant message).
- `codex-error.jsonl` — a turn that errored before producing a final message.
- `codex-empty.stdout.txt` — the headless empty-output regression: 0 bytes, exit 0 (§9.14).
- `codex-rollout-filename.txt` — a sample `~/.codex/sessions/.../rollout-*.jsonl` filename.
- `codex-find-output.txt` — sample `find … -printf '%T@\t%p\n'` output for newest-rollout selection.
