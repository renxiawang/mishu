import type { SandboxHandle } from "../sandbox/index.js";
import type { CodingBackend, SandboxShellExecutor, TurnResult } from "./index.js";
import { asString, isRecord, newestByMtime, parseJsonlEvents } from "./parsing.js";

/**
 * Claude Code backend — the ONLY place Claude Code's CLI/output format lives.
 * Everything here is pure (off captured bytes) except
 * captureSessionId, whose one shell call is injected so the rest stays
 * unit-testable.
 *
 * Verified: `claude -p --resume <id>` continues the SAME session
 * — id stable across turns, history replayed, surviving sbx stop/restart — so
 * the router captures the id once on turn 1 and resumes with it, exactly like
 * codex.
 *  - `claude -p --output-format stream-json --verbose <nonblocking> [--resume ID] -- PROMPT`
 *  - `--output-format stream-json` REQUIRES `--verbose` in print mode.
 *  - The prompt is a positional (not stdin) so the provider can close stdin;
 *    `--` guards a prompt that might start with `-`.
 *  - The stream's first `{"type":"system","subtype":"init",…}` line carries
 *    `session_id` (parseSessionId reads it live); the final `{"type":"result",…}`
 *    line carries the answer + `is_error`.
 */

export const CLAUDE_HOME = "~/.claude";
/** Shell-expanded ($HOME) inside execShell, not single-quoted. */
export const CLAUDE_PROJECTS_PATH = "$HOME/.claude/projects";

/**
 * Non-blocking headless — the analog of codex's `approval_policy=never`: never
 * block on a permission prompt. The sbx microVM is the isolation boundary
 * (Slack content is untrusted), so defense-in-depth is the hypervisor,
 * not Claude's in-process permission gate. Isolated here so the choice is one
 * edit (`--permission-mode bypassPermissions` is an equivalent newer spelling).
 */
export const CLAUDE_NONBLOCKING_FLAGS = ["--dangerously-skip-permissions"];

/**
 * Build the turn invocation. `--` guards a prompt that might start with `-`.
 * Prompt is a positional (not stdin) so the provider can close stdin.
 * `--verbose` is mandatory with `--output-format stream-json` in print mode.
 */
export function claudeTurnArgs(message: string, sessionId?: string | null): string[] {
  const common = ["-p", "--output-format", "stream-json", "--verbose", ...CLAUDE_NONBLOCKING_FLAGS];
  if (sessionId === undefined || sessionId === null) {
    return ["claude", ...common, "--", message];
  }
  return ["claude", ...common, "--resume", sessionId, "--", message];
}

/** Concatenated text blocks of an `{type:"assistant", message:{content:[…]}}` event. */
function extractAssistantText(event: Record<string, unknown>): string | null {
  if (asString(event.type) !== "assistant") {
    return null;
  }
  const message = isRecord(event.message) ? event.message : null;
  if (message === null || !Array.isArray(message.content)) {
    return null;
  }
  let text = "";
  for (const block of message.content) {
    if (isRecord(block) && asString(block.type) === "text") {
      text += asString(block.text) ?? "";
    }
  }
  return text === "" ? null : text;
}

/**
 * Interpret the captured stream-json into the result to relay. The authoritative
 * final answer is the `{"type":"result", result, is_error, …}` event; the last
 * assistant text is a fallback if a run ends without one. Empty output ->
 * {"", false}: the headless empty-output failure mode surfaces as a failed turn,
 * not a silent empty reply (parity with codex). On `is_error` the error
 * text (or the `subtype`, e.g. "error_max_turns") is relayed, still with ok=false.
 */
export function parseClaudeResult(captured: string): TurnResult {
  if (captured.trim() === "") {
    return { finalText: "", ok: false };
  }
  let finalText = ""; // authoritative: the result event's text
  let assistantText = ""; // fallback: the last assistant message's text
  let errorText = ""; // an is_error result's text (or its subtype)
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate non-JSON progress lines
    }
    if (!isRecord(event)) {
      continue;
    }
    if (asString(event.type) === "result") {
      const text = asString(event.result);
      if (event.is_error === true) {
        errorText = text ?? asString(event.subtype) ?? "";
      } else if (text !== null) {
        finalText = text;
      }
      continue;
    }
    const text = extractAssistantText(event);
    if (text !== null) {
      assistantText = text;
    }
  }
  if (finalText.trim() !== "") {
    return { finalText, ok: true };
  }
  if (errorText.trim() !== "") {
    return { finalText: errorText, ok: false }; // relay the agent's own error
  }
  if (assistantText.trim() !== "") {
    return { finalText: assistantText, ok: true }; // no result event, but it answered
  }
  return { finalText: "", ok: false };
}

/** Extract the session id from a stream-json turn (every line carries it; init is first). */
export function parseClaudeSessionId(captured: string): string | null {
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(event)) {
      const id = asString(event.session_id);
      if (id !== null) {
        return id;
      }
    }
  }
  return null;
}

const SESSION_UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session UUID from a `<session-id>.jsonl` transcript filename. */
export function parseClaudeSessionFilename(filename: string): string | null {
  const match = SESSION_UUID_RE.exec(filename);
  return match?.[1] ?? null;
}

export class ClaudeBackend implements CodingBackend {
  constructor(private readonly executor: SandboxShellExecutor) {}

  configHome(): string {
    return CLAUDE_HOME;
  }

  turnArgs(message: string, sessionId?: string): string[] {
    return claudeTurnArgs(message, sessionId);
  }

  parseResult(captured: string): TurnResult {
    return parseClaudeResult(captured);
  }

  parseSessionId(captured: string): string | null {
    return parseClaudeSessionId(captured);
  }

  events(captured: string): unknown[] {
    return parseJsonlEvents(captured);
  }

  /** Fallback when the stream had no id: newest transcript under CLAUDE_PROJECTS_PATH. */
  async captureSessionId(handle: SandboxHandle): Promise<string> {
    const command = `find ${CLAUDE_PROJECTS_PATH} -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null`;
    const { stdout } = await this.executor.execShell(handle, command);
    const newest = newestByMtime(stdout);
    if (newest === null) {
      throw new Error("claude: no session transcript found to capture the session id");
    }
    const filename = newest.slice(newest.lastIndexOf("/") + 1);
    const id = parseClaudeSessionFilename(filename);
    if (id === null) {
      throw new Error(`claude: could not parse the session id from transcript file "${filename}"`);
    }
    return id;
  }
}
