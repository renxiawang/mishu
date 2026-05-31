import type { ExecResult, SandboxHandle } from "../sandbox/index.js";
import type { CodingBackend, TurnResult } from "./index.js";

/**
 * Codex backend — the ONLY place Codex's CLI/output format lives (spec §4.5/§4.9).
 * Everything here is pure (off captured bytes) except captureSessionId, whose
 * one shell call is injected so the rest stays unit-testable.
 *
 * Verified against codex 0.135.0:
 *  - `codex exec [--json] [-c k=v]... [-- PROMPT]`
 *  - `codex exec resume [--json] [-c k=v]... [-- SESSION_ID PROMPT]`
 *  - `resume` has `-c` and `--json` but NOT `-s/--sandbox`, so we set the sandbox
 *    mode + approval policy via `-c` uniformly (works on both subcommands).
 *  - NEVER `--ephemeral` (breaks resume, §9.15); no `-i` (provider closes stdin).
 */

export const CODEX_HOME = "~/.codex";
/** Shell-expanded ($HOME) inside execShell, not single-quoted. */
export const CODEX_SESSIONS_PATH = "$HOME/.codex/sessions";

/**
 * Non-blocking defense-in-depth (§4.5/§9.8): keep Codex's native sandbox ON
 * (workspace-write) but never block headless on an approval prompt. Set via `-c`
 * because `resume` lacks `-s`. Exact keys confirmed live (§9.8).
 */
export const CODEX_NONBLOCKING_FLAGS = [
  "-c",
  "sandbox_mode=workspace-write",
  "-c",
  "approval_policy=never",
];

/** Minimal sandbox capability captureSessionId needs (one shell command). */
export interface SandboxShellExecutor {
  execShell(handle: SandboxHandle, command: string): Promise<ExecResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Build the turn invocation. `--` guards a prompt/id that might start with `-`.
 * Prompt is a positional (not stdin) so the provider can close stdin (§9.15).
 */
export function codexTurnArgs(message: string, sessionId?: string | null): string[] {
  const common = ["--json", ...CODEX_NONBLOCKING_FLAGS];
  if (sessionId === undefined || sessionId === null) {
    return ["codex", "exec", ...common, "--", message];
  }
  return ["codex", "exec", "resume", ...common, "--", sessionId, message];
}

function extractAssistantText(event: Record<string, unknown>): string | null {
  // Most authoritative: a completion event carrying the last message verbatim.
  const last =
    asString(event.last_agent_message) ??
    (isRecord(event.msg) ? asString(event.msg.last_agent_message) : null);
  if (last !== null) {
    return last;
  }
  // `item.*` thread events: { item: { type: "assistant_message", text } }.
  const item = isRecord(event.item) ? event.item : null;
  if (item !== null) {
    const itemType = asString(item.type) ?? asString(item.item_type);
    if (itemType === "assistant_message" || itemType === "agent_message") {
      return asString(item.text) ?? asString(item.message);
    }
  }
  // `msg`-wrapped events: { msg: { type: "agent_message", message } }.
  const msg = isRecord(event.msg) ? event.msg : null;
  if (msg !== null && asString(msg.type) === "agent_message") {
    return asString(msg.message) ?? asString(msg.text);
  }
  // Flat events: { type: "assistant_message", text }.
  const type = asString(event.type);
  if (type === "assistant_message" || type === "agent_message") {
    return asString(event.text) ?? asString(event.message);
  }
  return null;
}

/**
 * Interpret the captured `--json` stream into the result to relay. Tolerant of
 * several event shapes (the schema moves between versions) and of non-JSON
 * progress lines. Empty output -> {"", false}: the §9.14 headless regression
 * (argv -> 0 bytes, exit 0) surfaces as a failed turn, not a silent empty reply.
 */
export function parseCodexResult(captured: string): TurnResult {
  if (captured.trim() === "") {
    return { finalText: "", ok: false };
  }
  let finalText = "";
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
    if (!isRecord(event)) {
      continue;
    }
    const text = extractAssistantText(event);
    if (text !== null && text !== "") {
      finalText = text;
    }
  }
  return { finalText, ok: finalText.trim() !== "" };
}

function findSessionId(record: Record<string, unknown>): string | null {
  return (
    asString(record.thread_id) ?? asString(record.session_id) ?? asString(record.conversation_id)
  );
}

/** Extract the session id from a turn-1 `--json` stream (no filesystem). */
export function parseSessionId(captured: string): string | null {
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
    if (!isRecord(event)) {
      continue;
    }
    const id = findSessionId(event) ?? (isRecord(event.msg) ? findSessionId(event.msg) : null);
    if (id !== null) {
      return id;
    }
  }
  return null;
}

const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session UUID embedded in a `rollout-…-<uuid>.jsonl` filename (§4.5). */
export function parseRolloutId(filename: string): string | null {
  const match = ROLLOUT_UUID_RE.exec(filename);
  return match !== null && match[1] !== undefined ? match[1] : null;
}

/** From `find … -printf '%T@\t%p\n'` output, the path with the greatest mtime. */
export function newestRolloutPath(findOutput: string): string | null {
  let bestPath: string | null = null;
  let bestMtime = Number.NEGATIVE_INFINITY;
  for (const line of findOutput.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const mtime = Number.parseFloat(line.slice(0, tab));
    if (Number.isFinite(mtime) && mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = line.slice(tab + 1);
    }
  }
  return bestPath;
}

/** Parse the `--json` stream into raw events for log enrichment (degrade to []). */
export function codexEvents(captured: string): unknown[] {
  const events: unknown[] = [];
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip non-JSON progress lines
    }
  }
  return events;
}

export class CodexBackend implements CodingBackend {
  constructor(private readonly executor: SandboxShellExecutor) {}

  configHome(): string {
    return CODEX_HOME;
  }

  turnArgs(message: string, sessionId?: string): string[] {
    return codexTurnArgs(message, sessionId);
  }

  parseResult(captured: string): TurnResult {
    return parseCodexResult(captured);
  }

  parseSessionId(captured: string): string | null {
    return parseSessionId(captured);
  }

  events(captured: string): unknown[] {
    return codexEvents(captured);
  }

  /** Fallback when the stream had no id: newest rollout file under CODEX_HOME. */
  async captureSessionId(handle: SandboxHandle): Promise<string> {
    const command = `find ${CODEX_SESSIONS_PATH} -name 'rollout-*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null`;
    const { stdout } = await this.executor.execShell(handle, command);
    const newest = newestRolloutPath(stdout);
    if (newest === null) {
      throw new Error("codex: no rollout file found to capture the session id (§4.5)");
    }
    const filename = newest.slice(newest.lastIndexOf("/") + 1);
    const id = parseRolloutId(filename);
    if (id === null) {
      throw new Error(`codex: could not parse the session id from rollout file "${filename}"`);
    }
    return id;
  }
}
